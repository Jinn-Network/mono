import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { laneReleaseGroupIds, loadPlatformCatalog } from './platform-catalog.mjs';
import { verificationGateConclusionIds } from './platform-verification-receipt.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const workflowsRoot = resolve(import.meta.dirname, '../workflows');
const platformPath = resolve(workflowsRoot, 'platform-verification.yml');
const platform = readFileSync(platformPath, 'utf8');
const catalog = loadPlatformCatalog(repoRoot);

function jobBlock(source, jobId) {
  const start = source.indexOf(`\n  ${jobId}:\n`);
  assert.notEqual(start, -1, `missing job ${jobId}`);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/^  [a-zA-Z0-9_-]+:\n/mu);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

// Canary verification is the superset: every stack-published group plus the canary-only
// benchmarking group, so every one of their gates must be a static reusable job here.
const platformGateIds = [...new Set(
  laneReleaseGroupIds(catalog, 'canary')
    .flatMap((groupId) => catalog.releaseGroups[groupId].requiredGateIds),
)].sort();
const platformJobIds = [...platform.matchAll(/^  ([a-zA-Z0-9_-]+):$/gmu)]
  .map(([, jobId]) => jobId);
const domains = new Map(platformGateIds.map((gateId) => {
  const definition = catalog.gateDefinitions[gateId];
  assert.equal(definition.kind, 'workflow', `${gateId} must name a workflow gate`);
  assert.match(gateId, /-ci$/u, `${gateId} must provide a receipt conclusion key`);
  assert.match(definition.path, /^\.github\/workflows\/[a-zA-Z0-9_-]+\.yml$/u);
  const staticUse = `uses: ./${definition.path}`;
  const jobs = platformJobIds.filter((jobId) => jobBlock(platform, jobId).includes(staticUse));
  assert.equal(jobs.length, 1, `${gateId} must have exactly one static reusable job`);
  const [jobId] = jobs;
  const filename = definition.path.slice('.github/workflows/'.length);
  return [jobId, {
    gateId,
    gate: gateId.slice(0, -3),
    filename,
    path: definition.path,
    source: readFileSync(resolve(repoRoot, definition.path), 'utf8'),
  }];
}));

function sorted(values) {
  return [...values].sort();
}

function jobConditions(jobId) {
  return [...jobBlock(platform, jobId).matchAll(/^    if: (.+)$/gmu)]
    .map(([, condition]) => condition);
}

function jobNeeds(jobId) {
  const block = jobBlock(platform, jobId);
  const inline = block.match(/^    needs: (.+)$/mu);
  if (inline) return inline[1].replace(/^\[|\]$/gu, '').split(',').map((id) => id.trim());
  const list = block.match(/^    needs:\n((?:      - [a-zA-Z0-9_-]+\n)+)/mu);
  return list ? [...list[1].matchAll(/^      - ([a-zA-Z0-9_-]+)$/gmu)].map(([, id]) => id) : [];
}

function transitiveDependents(jobId) {
  const found = new Set();
  const queue = [jobId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const otherId of platformJobIds) {
      if (found.has(otherId) || !jobNeeds(otherId).includes(current)) continue;
      found.add(otherId);
      queue.push(otherId);
    }
  }
  return sorted(found);
}

test('the reusable interface grants OIDC only to artifact-only attestation jobs', () => {
  const header = platform.slice(0, platform.indexOf('\njobs:\n'));
  assert.match(header, /workflow_call:\n\s+inputs:\n/u);
  for (const input of ['source_sha', 'lane']) {
    assert.match(header, new RegExp(`${input}:\\n\\s+required: true\\n\\s+type: string`, 'u'));
  }
  assert.match(
    header,
    /secrets:\n\s+JINN_PROFILE_MANIFEST_SIGNING_KEY:\n\s+required: false\n\s+JINN_PROFILE_MANIFEST_KEY_ID:\n\s+required: false\n/u,
    'the reusable interface must name exactly its optional profile-signing secrets',
  );
  assert.match(header, /contents: read/u);
  for (const job of ['artifacts', 'verification_receipt']) {
    const block = jobBlock(platform, job);
    assert.doesNotMatch(block, /id-token: write|attestations: write|actions\/attest@/u);
  }
  for (const job of ['artifact_attestation', 'receipt_attestation']) {
    const block = jobBlock(platform, job);
    assert.match(block, /id-token: write/u);
    assert.match(block, /attestations: write/u);
    assert.match(block, /artifact-metadata: write/u);
    assert.match(block, /uses: actions\/download-artifact@v8/u);
    assert.match(block, /uses: actions\/attest@v4/u);
    assert.doesNotMatch(block, /actions\/checkout|actions\/setup-node|^\s+-?\s*run:/mu);
  }
});

test('the new workflow uses the repository release-gate action versions', () => {
  assert.doesNotMatch(platform, /uses: actions\/(?:checkout|setup-node)@v4/u);
  assert.equal((platform.match(/uses: actions\/checkout@v7/gu) ?? []).length, 4);
  assert.equal((platform.match(/uses: actions\/setup-node@v7/gu) ?? []).length, 4);
});

test('platform jobs check out the exact requested source SHA', () => {
  assert.equal(
    (platform.match(
      /uses: actions\/checkout@v7\n\s+with:\n\s+ref: \$\{\{ inputs\.source_sha \}\}/gu,
    ) ?? []).length,
    4,
  );
});

test('platform delegates the exact requested source SHA to every domain workflow', () => {
  for (const [jobId, { filename }] of domains) {
    const block = jobBlock(platform, jobId);
    assert.match(
      block,
      new RegExp(
        `uses: \\.\\/.github/workflows/${filename.replace('.', '\\.')}`
          + '\\n\\s+with:\\n\\s+source_sha: \\$\\{\\{ inputs\\.source_sha \\}\\}',
        'u',
      ),
      `${filename} must receive the requested source SHA`,
    );
  }
});

test('domain reusable interfaces require a source SHA', () => {
  for (const { filename, source } of domains.values()) {
    const header = source.slice(0, source.indexOf('\npermissions:\n'));
    assert.match(
      header,
      /workflow_call:\n\s+inputs:\n\s+source_sha:\n\s+required: true\n\s+type: string/u,
      `${filename} must require source_sha from reusable callers`,
    );
  }
});

test('reusable domain gates do not declare PR-cancelling workflow concurrency', () => {
  for (const { filename, source } of domains.values()) {
    assert.doesNotMatch(
      source,
      /^concurrency:/mu,
      `${filename} must not share a cancel-in-progress group with its pull_request trigger; that cancels the platform-verification workflow_call`,
    );
  }
});

test('domain checkouts use the requested SHA with the event SHA fallback', () => {
  for (const { filename, source } of domains.values()) {
    const checkouts = (source.match(/uses: actions\/checkout@v7/gu) ?? []).length;
    const pinnedCheckouts = (source.match(
      /uses: actions\/checkout@v7\n\s+with:\n\s+ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/gu,
    ) ?? []).length;
    assert.ok(checkouts > 0, `${filename} must contain a checkout`);
    assert.equal(
      pinnedCheckouts,
      checkouts,
      `${filename} must pin every checkout with the direct-trigger fallback`,
    );
  }
});

test('catalog validation treats the requested source SHA as authoritative', () => {
  const catalog = jobBlock(platform, 'catalog');
  assert.match(catalog, /SOURCE_SHA: \$\{\{ inputs\.source_sha \}\}/u);
  assert.doesNotMatch(catalog, /github\.sha|CALLER_SHA/u);
  assert.match(catalog, /git rev-parse HEAD/u);
  assert.match(catalog, /loadPlatformCatalog/u);
  assert.match(catalog, /catalogSha256/u);
  assert.match(catalog, /catalog_digest: \$\{\{ steps\.catalog\.outputs\.digest \}\}/u);
});

test('every catalog-selected platform gate remains independently triggered and is one static reusable call', () => {
  for (const [jobId, { filename, source }] of domains) {
    const header = source.slice(0, source.indexOf('\npermissions:\n'));
    assert.match(header, /pull_request:/u, `${filename} lost pull_request`);
    assert.match(header, /push:/u, `${filename} lost push`);
    assert.match(header, /workflow_call:/u, `${filename} is not reusable`);

    const block = jobBlock(platform, jobId);
    assert.match(block, /needs: catalog/u);
    assert.match(block, new RegExp(`uses: \\.\\/.github/workflows/${filename.replace('.', '\\.')}\\n`, 'u'));
    assert.doesNotMatch(block, /secrets: inherit/u);
    assert.doesNotMatch(block, /\n\s+secrets:/u, `${filename} must receive no caller secrets`);
  }
  assert.match(domains.get('task_execution').source, /workflow_dispatch:/u);
});

test('the static reusable workflow set exactly equals the platform release-group gates', () => {
  const reusablePaths = [...platform.matchAll(/^    uses: (\.\/\.github\/workflows\/[a-zA-Z0-9_-]+\.yml)$/gmu)]
    .map(([, path]) => path.slice(2));
  assert.deepEqual(
    sorted(reusablePaths),
    sorted(platformGateIds.map((gateId) => catalog.gateDefinitions[gateId].path)),
  );
});

test('a domain gate runs on the stable lane only when a stable group requires it', () => {
  const stableGroupIds = laneReleaseGroupIds(catalog, 'stable');
  const stableGateIds = new Set(
    stableGroupIds.flatMap((groupId) => catalog.releaseGroups[groupId].requiredGateIds),
  );
  const canaryOnlyJobs = [];
  for (const [jobId, { gateId }] of domains) {
    const conditions = jobConditions(jobId);
    if (stableGateIds.has(gateId)) {
      assert.deepEqual(conditions, [], `${gateId} gates a stable group, so it must run on every lane`);
    } else {
      // No stable group requires this gate, so a stable cut neither runs it nor can be refused
      // by it. It keeps running on the canary lane, where a group does require it.
      assert.deepEqual(
        conditions,
        ["inputs.lane == 'canary'"],
        `${gateId} gates no stable group, so it must run on the canary lane only`,
      );
      canaryOnlyJobs.push(jobId);
    }
  }
  assert.deepEqual(canaryOnlyJobs, ['benchmarking']);

  // A skipped gate job reaches the receipt as `skipped`. That is safe only because no stable
  // group's receipt names the gate, and unsafe for any canary group that does.
  for (const jobId of canaryOnlyJobs) {
    const { gate } = domains.get(jobId);
    for (const groupId of stableGroupIds) {
      assert.ok(
        !verificationGateConclusionIds(catalog, groupId).includes(gate),
        `${groupId} must not require the ${gate} conclusion`,
      );
    }
    assert.ok(
      laneReleaseGroupIds(catalog, 'canary')
        .some((groupId) => verificationGateConclusionIds(catalog, groupId).includes(gate)),
      `a canary-lane group must still require the ${gate} conclusion`,
    );
    // A skip is inherited by every job further down the needs chain, not only by the next one,
    // unless that job's own condition uses a status function. So the receipt job is the only
    // one allowed to depend on a lane-conditional gate directly, and every job behind it, such
    // as receipt_attestation behind verification_receipt, needs a condition of its own.
    const dependents = platformJobIds.filter((otherId) => jobNeeds(otherId).includes(jobId));
    assert.deepEqual(dependents, ['verification_receipt']);
    const downstream = transitiveDependents(jobId);
    assert.ok(
      downstream.includes('receipt_attestation'),
      `the needs walk from ${jobId} must reach receipt_attestation through verification_receipt`,
    );
    for (const otherId of downstream) {
      const conditions = jobConditions(otherId);
      assert.equal(conditions.length, 1, `${otherId} sits behind ${jobId}, so it needs one job condition`);
      assert.match(
        conditions[0],
        /(?:always|cancelled|failure)\(\)/u,
        `${otherId} sits behind ${jobId}, so without a status function it is skipped on the stable lane`,
      );
    }
  }
  assert.match(jobBlock(platform, 'verification_receipt'), /^    if: always\(\)$/mu);
  // The attestation must survive the skipped gate, and must still refuse a receipt job that did
  // not succeed or a run that was cancelled.
  const [attestationCondition] = jobConditions('receipt_attestation');
  assert.match(attestationCondition, /^\$\{\{ .+ \}\}$/u);
  const attestationTerms = attestationCondition.slice(3, -2).split('&&').map((term) => term.trim());
  assert.ok(
    attestationTerms.includes("needs.verification_receipt.result == 'success'"),
    'receipt_attestation must require verification_receipt to have succeeded',
  );
  assert.ok(attestationTerms.includes('!cancelled()'), 'receipt_attestation must not run in a cancelled run');
  assert.ok(attestationTerms.includes('!failure()'), 'receipt_attestation must not run after a failed ancestor');
  assert.doesNotMatch(attestationCondition, /\|\||always\(\)/u);
});

test('artifacts build and upload public/profile/pack outputs without OIDC', () => {
  const artifacts = jobBlock(platform, 'artifacts');
  assert.match(artifacts, /build-platform-public-surface\.mjs/u);
  assert.match(artifacts, /build-profile-root\.mjs/u);
  assert.match(artifacts, /sign-profile-manifest\.mjs \\\n\s+--root "\.platform-verification\/\$\{group\}\/profile-root"/u);
  assert.ok(
    artifacts.indexOf('build-profile-root.mjs') < artifacts.indexOf('sign-profile-manifest.mjs'),
    'the manifest must be built before it is signed',
  );
  assert.match(artifacts, /build-prepublication-bundle\.mjs/u);
  assert.match(artifacts, /--native-vertical-roles/u);
  assert.match(artifacts, /--out \.platform-verification\/native-role-pack/u);
  assert.match(artifacts, /stack-trusted-publishers\.mjs/u);
  assert.match(artifacts, /--out \.platform-verification\/trusted-publishers/u);
  assert.match(artifacts, /--source-sha "\$\{SOURCE_SHA\}"/u);
  assert.match(artifacts, /--catalog-digest "\$\{CATALOG_DIGEST\}"/u);
  assert.match(artifacts, /--lane "\$\{LANE\}"/u);
  assert.doesNotMatch(artifacts, /id-token: write|attestations: write|uses: actions\/attest@/u);
  assert.match(artifacts, /uses: actions\/upload-artifact@v4/u);
  assert.match(
    artifacts,
    /uses: actions\/upload-artifact@v4[\s\S]*?include-hidden-files: true/u,
    'the dot-directory artifact must opt in to hidden files',
  );
});

test('every per-group loop follows the lane, and only stack-published profile roots are signed', () => {
  const laneSelector = 'laneReleaseGroupIds(loadPlatformCatalog(process.cwd()), process.env.LANE)';
  const stackSelector = 'stackPublishedReleaseGroupIds(loadPlatformCatalog(process.cwd()))';
  const artifacts = jobBlock(platform, 'artifacts');
  const signAt = artifacts.indexOf('- name: Sign the profile manifest');
  const packAt = artifacts.indexOf('- name: Pack exact prepublication bundle');
  assert.ok(signAt > -1 && packAt > signAt);
  const build = artifacts.slice(0, signAt);
  const sign = artifacts.slice(signAt, packAt);
  const pack = artifacts.slice(packAt);
  assert.ok(build.includes(laneSelector), 'the surface and profile-root build must follow the lane');
  assert.ok(pack.includes(laneSelector), 'the pack must follow the lane');
  // A canary-only group is built and attested for its receipt, but its profile root is never
  // signed, so it can never be served at the protocol origin.
  assert.ok(sign.includes(stackSelector), 'signing must stay on the stack-published groups');
  assert.ok(!sign.includes('laneReleaseGroupIds'), 'signing must not follow the lane');
  for (const jobId of ['external_consumer', 'verification_receipt']) {
    const block = jobBlock(platform, jobId);
    assert.ok(block.includes(laneSelector), `${jobId} must follow the lane`);
    assert.match(block, /LANE: \$\{\{ inputs\.lane \}\}/u, `${jobId} must receive the lane`);
    assert.ok(!block.includes('stackPublishedReleaseGroupIds'), `${jobId} must not select by stack publication`);
  }
});

test('artifact attestation downloads immutable build outputs without executing repository code', () => {
  const attestation = jobBlock(platform, 'artifact_attestation');
  assert.match(attestation, /needs: artifacts/u);
  assert.match(attestation, /name: platform-verification-artifacts/u);
  for (const subject of [
    /\.platform-verification\/\*\/pack\/manifest\.json/u,
    /\.platform-verification\/\*\/pack\/tarballs\/\*\.tgz/u,
    /\.platform-verification\/native-role-pack\/manifest\.json/u,
    /\.platform-verification\/native-role-pack\/tarballs\/\*\.tgz/u,
    /\.platform-verification\/\*\/public-surface-manifest\.json/u,
    /\.platform-verification\/\*\/profile-root\/\*\*/u,
    /\.platform-verification\/trusted-publishers\/trusted-publishers\.json/u,
    /\.platform-verification\/trusted-publishers\/trusted-publishers\.md/u,
  ]) assert.match(attestation, subject);
  assert.doesNotMatch(attestation, /actions\/checkout|actions\/setup-node|^\s+-?\s*run:/mu);
});

test('external consumer accepts only the downloaded same-run tarball bundle', () => {
  const consumer = jobBlock(platform, 'external_consumer');
  assert.match(consumer, /needs: artifacts/u);
  assert.match(consumer, /uses: actions\/download-artifact@v8/u);
  assert.match(consumer, /prepublication-external-consumer\.mjs/u);
  assert.match(consumer, /--manifest "\.platform-verification\/\$\{group\}\/pack\/manifest\.json"/u);
  assert.match(consumer, /--native-manifest \.platform-verification\/native-role-pack\/manifest\.json/u);
});

test('the always-running receipt receives every exact job conclusion and is uploaded only on success', () => {
  const receipt = jobBlock(platform, 'verification_receipt');
  assert.match(receipt, /if: always\(\)/u);
  const infrastructure = new Map([
    ['catalog', 'catalog'],
    ['artifacts', 'artifacts'],
    ['artifact-attestation', 'artifact_attestation'],
    ['external-consumer', 'external_consumer'],
  ]);
  const expectedGateJobs = new Map([
    ...infrastructure,
    ...[...domains].map(([jobId, { gate }]) => [gate, jobId]),
  ]);
  const declaredNeeds = [...receipt.matchAll(/^      - ([a-zA-Z0-9_-]+)$/gmu)]
    .map(([, jobId]) => jobId);
  assert.deepEqual(sorted(declaredNeeds), sorted(expectedGateJobs.values()));

  const resultVariables = new Map(
    [...receipt.matchAll(/^\s+([A-Z_]+_RESULT): \$\{\{ needs\.([a-zA-Z0-9_-]+)\.result \}\}$/gmu)]
      .map(([, variable, jobId]) => [variable, jobId]),
  );
  assert.deepEqual(sorted(resultVariables.values()), sorted(expectedGateJobs.values()));

  const cliGates = new Map(
    [...receipt.matchAll(/--gate "([^="\s]+)=\$\{([A-Z_]+_RESULT)\}"/gu)]
      .map(([, gate, variable]) => [gate, variable]),
  );
  assert.deepEqual(sorted(cliGates.keys()), sorted(expectedGateJobs.keys()));
  for (const [gate, expectedJob] of expectedGateJobs) {
    assert.equal(resultVariables.get(cliGates.get(gate)), expectedJob, `${gate} must bind ${expectedJob}.result`);
  }
  assert.match(receipt, /platform-verification-receipt\.mjs/u);
  assert.doesNotMatch(receipt, /id-token: write|attestations: write|uses: actions\/attest@/u);
  assert.match(receipt, /uses: actions\/upload-artifact@v4/u);
  assert.match(
    receipt,
    /uses: actions\/upload-artifact@v4[\s\S]*?include-hidden-files: true/u,
    'the dot-directory receipt must opt in to hidden files',
  );
  assert.equal((receipt.match(/if: success\(\)/gu) ?? []).length, 1);
});

test('receipt attestation downloads only the completed receipt and executes no repository code', () => {
  const attestation = jobBlock(platform, 'receipt_attestation');
  assert.match(attestation, /needs: verification_receipt/u);
  assert.match(attestation, /name: platform-verification-receipt/u);
  assert.match(attestation, /subject-path: \.platform-verification-receipt\/\*\*\/verification-receipt\.json/u);
  assert.doesNotMatch(attestation, /platform-verification-artifacts/u);
  assert.doesNotMatch(attestation, /actions\/checkout|actions\/setup-node|^\s+-?\s*run:/mu);
});

test('the experimental policy group remains continuously represented and disabled', () => {
  const group = catalog.releaseGroups['experimental-policy'];
  assert.deepEqual(group.requiredGateIds, ['policy-ci']);
  assert.deepEqual(group.publishPolicies, ['disabled']);
  assert.equal(group.stackPublished, false);
  assert.equal(group.canary, false);
  assert.equal(group.stable, false);
  assert.ok(catalog.packages
    .filter(({ releaseGroup }) => releaseGroup === 'experimental-policy')
    .every(({ publishPolicy }) => publishPolicy === 'disabled'));
});

test('prepublication verification cannot publish or wait permissively for a registry', () => {
  assert.doesNotMatch(platform, /npm\s+publish|publish-stack\.mjs(?![^\n]*--dry-run)/u);
  assert.doesNotMatch(platform, /\bsleep\b|\buntil\b/u);
  assert.equal(
    [...platform.matchAll(/\bwhile\b/gu)].length,
    [...platform.matchAll(/\bwhile IFS= read -r group; do/gu)].length,
    'the only while loops allowed are per-group artifact iteration',
  );
  assert.doesNotMatch(platform, /stack-npm-publish\.yml/u);
});
