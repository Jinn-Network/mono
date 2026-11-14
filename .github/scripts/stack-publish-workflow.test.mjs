import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const workflowPath = resolve(import.meta.dirname, '../workflows/stack-npm-publish.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const publishingRunbook = readFileSync(
  resolve(import.meta.dirname, '../../docs/runbooks/stack-npm-publishing.md'),
  'utf8',
);

function canaryPublishBlock() {
  return workflow.slice(workflow.indexOf('canary-publish:'), workflow.indexOf('canary-host-refresh:'));
}

// The `run: |` body of one named step in `block`, dedented, as the runner executes it.
function stepRunScript(block, stepName) {
  const steps = block.split(/\n {6}- /u);
  const step = steps.find((candidate) => candidate.split('\n')[0] === `name: ${stepName}`);
  assert.ok(step, `missing step ${stepName}`);
  const lines = step.split('\n');
  const runAt = lines.findIndex((line) => /^ {8}run: \|$/u.test(line));
  assert.ok(runAt > -1, `${stepName} has no run block`);
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line !== '' && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const RECEIPT_GROUP = 'benchmarking-product-v1';

// Runs the stored-receipt comparison against one fixture workspace: this attempt's receipt,
// plus whatever the download step left from an earlier attempt (undefined: nothing).
function compareStoredReceipt({ receipt, stored }) {
  const dir = mkdtempSync(join(tmpdir(), 'stack-publication-receipt-'));
  try {
    mkdirSync(join(dir, '.platform-publication', RECEIPT_GROUP), { recursive: true });
    writeFileSync(join(dir, '.platform-publication', RECEIPT_GROUP, 'publication-receipt.json'), receipt);
    if (stored !== undefined) {
      mkdirSync(join(dir, '.platform-publication-stored', RECEIPT_GROUP), { recursive: true });
      for (const [name, content] of Object.entries(stored)) {
        writeFileSync(join(dir, '.platform-publication-stored', RECEIPT_GROUP, name), content);
      }
    }
    const outputFile = join(dir, 'github-output');
    writeFileSync(outputFile, '');
    const result = spawnSync('bash', ['-e', '-c', stepRunScript(canaryPublishBlock(), 'Compare with the stored receipt')], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, RELEASE_GROUP: RECEIPT_GROUP, GITHUB_OUTPUT: outputFile },
    });
    return { status: result.status, log: `${result.stdout}${result.stderr}`, output: readFileSync(outputFile, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('preserves platform triggers and cross-branch canary serialization', () => {
  assert.match(workflow, /branches:\s*\[integration\/evidence-v1, next\]/u);
  assert.match(workflow, /release:\s*\n\s+types:\s*\[published\]/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /'stack-npm-publish-canary'/u);
  assert.match(workflow, /stack-npm-publish-stable-\{0\}/u);
  assert.match(workflow, /cancel-in-progress: false/u);
});

test('the canary job directly calls same-SHA platform verification with least privilege', () => {
  const verificationAt = workflow.indexOf('canary-verification:');
  const publishAt = workflow.indexOf('canary-publish:');
  assert.ok(verificationAt > -1 && publishAt > verificationAt);
  const block = workflow.slice(verificationAt, publishAt);
  assert.match(block, /uses: \.\/\.github\/workflows\/platform-verification\.yml/u);
  assert.match(block, /source_sha: \$\{\{ github\.sha \}\}/u);
  assert.match(block, /lane: canary/u);
  for (const permission of ['contents: read', 'id-token: write', 'attestations: write', 'artifact-metadata: write']) {
    assert.ok(block.includes(permission), `missing caller permission ${permission}`);
  }
  assert.doesNotMatch(block, /JINN_MARKETPLACE_FORK_RPC_URL/u);
  assert.match(block, /JINN_PROFILE_MANIFEST_SIGNING_KEY/u);
  assert.doesNotMatch(block, /secrets: inherit/u);
});

test('the canary publisher directly needs exact verification success', () => {
  const publishAt = workflow.indexOf('canary-publish:');
  const refreshAt = workflow.indexOf('canary-host-refresh:');
  const block = workflow.slice(publishAt, refreshAt);
  assert.match(block, /needs: canary-verification/u);
  assert.match(block, /needs\.canary-verification\.result == 'success'/u);
  assert.match(block, /github\.event_name == 'push'/u);
  assert.match(block, /vars\.PLATFORM_CANARY_PUBLISH_ENABLED == 'true'/u);
  assert.match(block, /environment: npm-publish/u);
  assert.equal((workflow.match(/environment: npm-publish/gu) ?? []).length, 1);
});

test('the publisher downloads only the current run verification artifacts and receipt', () => {
  const publishAt = workflow.indexOf('canary-publish:');
  const refreshAt = workflow.indexOf('canary-host-refresh:');
  const block = workflow.slice(publishAt, refreshAt);
  // Two verification inputs, plus the leg's own receipt from an earlier attempt of this run.
  assert.equal((block.match(/uses: actions\/download-artifact@v8/gu) ?? []).length, 3);
  assert.deepEqual(
    [...block.matchAll(/^\s+name: (platform-verification-(?:artifacts|receipt))$/gmu)].map((match) => match[1]).sort(),
    ['platform-verification-artifacts', 'platform-verification-receipt'],
  );
  assert.doesNotMatch(block, /run-id:|github-token:|repository:/u);
  assert.match(block, /node \.github\/scripts\/publish-verified-platform\.mjs/u);
  assert.doesNotMatch(block, /npm\s+pack|publish-stack\.mjs|build-prepublication-bundle|build-profile-root|yarn\s+build/u);
});

test('the publisher verifies strict GitHub provenance policy before its receipt-gated npm driver', () => {
  const publishAt = workflow.indexOf('canary-publish:');
  const refreshAt = workflow.indexOf('canary-host-refresh:');
  const block = workflow.slice(publishAt, refreshAt);
  assert.match(block, /GITHUB_REPOSITORY/u);
  assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(block, /SOURCE_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(block, /JINN_NPM_REGISTRY_RETRY_ATTEMPTS: 541/u);
  assert.match(block, /JINN_NPM_TLOG_CONFLICT_RETRY_ATTEMPTS: 3/u);
  assert.match(block, /--source-sha "\$\{SOURCE_SHA\}"/u);
  assert.match(block, /--registry https:\/\/registry\.npmjs\.org\//u);
  assert.ok(block.includes('--release-group ${{ matrix.release_group }}'));
  assert.ok(block.includes('--verification-receipt ".platform-verification-receipt/${{ matrix.release_group }}/verification-receipt.json"'));
  assert.match(block, /--lane canary/u);
  assert.match(
    block,
    /matrix:\n\s+release_group:\n\s+- sealed-platform-v1\n\s+- implementations-v1\n\s+- benchmarking-product-v1\n/u,
  );
});

test('the canary publisher waits 45 minutes for npm to expose a version it has accepted', () => {
  const publishAt = workflow.indexOf('canary-publish:');
  const refreshAt = workflow.indexOf('canary-host-refresh:');
  const block = workflow.slice(publishAt, refreshAt);
  const attempts = Number(/^ {10}JINN_NPM_REGISTRY_RETRY_ATTEMPTS: (\d+)$/mu.exec(block)?.[1]);
  const delayMs = Number(/^ {10}JINN_NPM_REGISTRY_RETRY_DELAY_MS: (\d+)$/mu.exec(block)?.[1]);
  // The publisher sleeps between queries, so N attempts leave N - 1 waits. npm took about
  // 29 minutes to expose one accepted version on 2026-09-30 (#4919); a 15-minute wait gave up
  // on it and left the rest of the implementations walk unpublished.
  assert.equal((attempts - 1) * delayMs, 45 * 60 * 1000);
});

test('the canary publisher leaves the implementations leg six hours to reach its wave tail', () => {
  const publishAt = workflow.indexOf('canary-publish:');
  const refreshAt = workflow.indexOf('canary-host-refresh:');
  const block = workflow.slice(publishAt, refreshAt);
  assert.match(block, /^ {4}timeout-minutes: 360$/mu);
});

test('only stack-published groups reach the protocol origin, never the canary-only group', () => {
  const stackSelector = 'stackPublishedReleaseGroupIds(loadPlatformCatalog(process.cwd()))';
  const refreshAt = workflow.indexOf('canary-host-refresh:');
  const stableAt = workflow.indexOf('resolve-stable-source:');
  const liveAt = workflow.indexOf('stable-live-host-verification:\n    name:');
  const liveEnd = workflow.indexOf('stable-live-host-attestation:\n    name:');
  assert.ok(refreshAt > -1 && stableAt > refreshAt && liveAt > stableAt && liveEnd > liveAt);
  for (const block of [workflow.slice(refreshAt, stableAt), workflow.slice(liveAt, liveEnd)]) {
    assert.ok(block.includes(stackSelector));
    assert.doesNotMatch(block, /laneReleaseGroupIds|benchmarking-product-v1/u);
  }
});

test('the final deterministic publication receipt is attested and uploaded', () => {
  const publishAt = workflow.indexOf('canary-publish:');
  const refreshAt = workflow.indexOf('canary-host-refresh:');
  const block = workflow.slice(publishAt, refreshAt);
  assert.match(block, /uses: actions\/attest@v4/u);
  assert.ok(block.includes('subject-path: .platform-publication/${{ matrix.release_group }}/publication-receipt.json'));
  assert.match(block, /uses: actions\/upload-artifact@v7/u);
  assert.ok(block.includes('name: platform-publication-receipt-${{ matrix.release_group }}'));
  assert.match(block, /if-no-files-found: error/u);
});

// A rerun's upload of a name an earlier attempt stored is not refused (#5235): upload-artifact
// v7's client keys CreateArtifact by the attempt's own backend id, so the run would gain a
// second artifact of that name. A rerun instead compares against the stored receipt first.
test('a rerun compares its receipt with one an earlier attempt stored before attesting or uploading', () => {
  const block = canaryPublishBlock();
  const findAt = block.indexOf('- name: Find the receipt an earlier attempt of this run stored');
  const compareAt = block.indexOf('- name: Compare with the stored receipt');
  const publishAt = block.indexOf('node .github/scripts/publish-verified-platform.mjs');
  const attestAt = block.indexOf('- name: Attest final publication receipt');
  const uploadAt = block.indexOf('- name: Upload final publication receipt');
  assert.ok(findAt > -1 && compareAt > -1, 'the stored-receipt steps must exist');
  assert.ok(publishAt < findAt && findAt < compareAt && compareAt < attestAt && attestAt < uploadAt);

  // A pattern, not a name: a name that matches nothing fails the step, a pattern downloads
  // nothing and succeeds, which is the first attempt of every run. Same run only.
  const find = block.slice(findAt, compareAt);
  assert.match(find, /uses: actions\/download-artifact@v8/u);
  assert.ok(find.includes('pattern: platform-publication-receipt-${{ matrix.release_group }}\n'));
  assert.ok(find.includes('path: .platform-publication-stored/${{ matrix.release_group }}\n'));
  assert.doesNotMatch(find, /^\s+name: platform|run-id:|github-token:|repository:|merge-multiple:/mu);

  const compare = block.slice(compareAt, attestAt);
  assert.match(compare, /id: stored-receipt/u);
  assert.match(compare, /RELEASE_GROUP: \$\{\{ matrix\.release_group \}\}/u);
  assert.doesNotMatch(stepRunScript(block, 'Compare with the stored receipt'), /\$\{\{/u);

  // The upload runs only when nothing is stored, and never deletes what is.
  const upload = block.slice(uploadAt);
  assert.match(upload, /^ {8}if: steps\.stored-receipt\.outputs\.upload == 'true'$/mu);
  assert.doesNotMatch(upload, /overwrite:/u);
});

test('the stored-receipt comparison uploads a first receipt, skips an identical one, and refuses a different one', () => {
  const receipt = '{"releaseGroup":"benchmarking-product-v1","sourceSha":"a"}\n';

  const first = compareStoredReceipt({ receipt, stored: undefined });
  assert.equal(first.status, 0, first.log);
  assert.equal(first.output, 'upload=true\n');

  const empty = compareStoredReceipt({ receipt, stored: {} });
  assert.equal(empty.status, 0, empty.log);
  assert.equal(empty.output, 'upload=true\n');

  const identical = compareStoredReceipt({ receipt, stored: { 'publication-receipt.json': receipt } });
  assert.equal(identical.status, 0, identical.log);
  assert.equal(identical.output, 'upload=false\n', 'one receipt artifact for the group, not two');
  assert.match(identical.log, /::notice::.*earlier attempt of this run stored this publication receipt/u);

  const different = compareStoredReceipt({
    receipt,
    stored: { 'publication-receipt.json': receipt.replace('"a"', '"b"') },
  });
  assert.equal(different.status, 1, different.log);
  assert.equal(different.output, '', 'a different receipt is neither uploaded nor marked as stored');
  assert.match(different.log, /::error::publication receipt for benchmarking-product-v1 differs from the one an earlier attempt of this run stored/u);
  assert.match(different.log, /docs\/runbooks\/stack-npm-publishing\.md/u);

  for (const stored of [
    { 'other.json': receipt },
    { 'publication-receipt.json': receipt, 'extra.json': '{}\n' },
  ]) {
    const unexpected = compareStoredReceipt({ receipt, stored });
    assert.equal(unexpected.status, 1, `${Object.keys(stored).join(', ')} must fail closed: ${unexpected.log}`);
    assert.equal(unexpected.output, '');
    assert.match(unexpected.log, /::error::/u);
  }
});

test('the runbook says what to do when a leg fails after its receipt was stored', () => {
  const recovery = publishingRunbook.slice(publishingRunbook.indexOf('## Recovery'));
  assert.match(recovery, /\*\*A leg that fails after its publication receipt was stored\*\*/u);
  assert.match(recovery, /publication receipt for <group> differs from the one an earlier attempt of this run stored/u);
  assert.match(recovery, /platform-publication-receipt-<group>/u);
});

test('the canary host refresh copies same-run attested bytes to the host and pushes only on change', () => {
  const refreshAt = workflow.indexOf('canary-host-refresh:');
  const stableAt = workflow.indexOf('resolve-stable-source:');
  assert.ok(refreshAt > -1 && stableAt > refreshAt);
  const block = workflow.slice(refreshAt, stableAt);

  // Gated on verification, not on publication: the host refresh is independent of npm,
  // and canary-publish carries its own unrelated enablement switch.
  assert.match(block, /needs: canary-verification/u);
  assert.doesNotMatch(block, /needs: canary-publish|needs\.canary-publish/u);
  assert.match(block, /needs\.canary-verification\.result == 'success'/u);
  assert.match(block, /github\.event_name == 'push'/u);
  // The workflow also fires on integration/evidence-v1, which must never deploy the
  // public host. This is the first ref discrimination in the workflow.
  assert.match(block, /github\.ref == 'refs\/heads\/next'/u);
  // Unconfigured must skip rather than turn `next` red.
  assert.match(block, /vars\.JINN_PROFILE_HOST_REPOSITORY != ''/u);
  assert.match(block, /LANE: canary/u);
  assert.match(block, /timeout-minutes:/u);

  // Push authority is the PAT, never GITHUB_TOKEN.
  assert.match(block, /permissions:\s*\n\s+contents: read\s*\n/u);
  // ...and that PAT is an ENVIRONMENT secret, not a repository secret every workflow in the
  // repository can read. The job's own `github.ref` gate constrains this job, not the
  // secret's availability, and the workflow also fires on integration/evidence-v1.
  // Precedent: canary-publish's `environment: npm-publish` on the comparable npm surface.
  assert.match(block, /environment: profile-host-publish/u);
  // Pinned at exactly one for the same reason `environment: npm-publish` is: a second
  // declaration would mean a second job reading this push credential, and a dropped one
  // would silently return it to being a repository secret every workflow can read.
  assert.equal((workflow.match(/environment: profile-host-publish/gu) ?? []).length, 1);
  assert.doesNotMatch(block, /id-token: write|attestations: write|artifact-metadata: write/u);

  // Same-run restore by name; never a cross-run download.
  assert.equal((block.match(/uses: actions\/download-artifact@v8/gu) ?? []).length, 1);
  assert.match(block, /name: platform-verification-artifacts/u);
  assert.doesNotMatch(block, /run-id:|github-token:/u);

  // Copy only: no signing key reaches this job, and no document is regenerated here.
  assert.doesNotMatch(block, /JINN_PROFILE_MANIFEST_SIGNING_KEY|JINN_PROFILE_MANIFEST_KEY_ID/u);
  assert.doesNotMatch(block, /build-profile-root\.mjs|sign-profile-manifest\.mjs|npm\s+publish/u);

  // The bundle is built into fresh runner temp space, never into the host checkout --
  // the generator refuses a non-empty --out, and that refusal stays as strong as it is.
  assert.match(block, /node \.github\/scripts\/build-profile-host-bundle\.mjs/u);
  assert.match(block, /--out "\$\{BUNDLE_DIR\}"/u);
  // EVERY declaration, not "at least one". `BUNDLE_DIR` is declared twice -- once on the
  // build step and once on the mirror step -- and a single `match` is satisfied by either,
  // so pointing the build step at the host checkout would have passed a test whose whole
  // claim is that the bundle is never generated there. The duplication cannot be removed:
  // `jobs.<job_id>.env` cannot read the `runner` context, so a job-level declaration is a
  // parse error rather than a simplification.
  const bundleDirDeclarations = block.match(/^\s+BUNDLE_DIR: .*$/gmu) ?? [];
  assert.equal(bundleDirDeclarations.length, 2, 'the build step and the mirror step each declare BUNDLE_DIR');
  for (const declaration of bundleDirDeclarations) {
    assert.match(declaration, /BUNDLE_DIR: \$\{\{ runner\.temp \}\}\/profile-host-bundle$/u);
  }
  // No job-level `env:` in this workflow may name `runner`, for the same reason.
  assert.doesNotMatch(workflow, /^    env:\n(?:      \S.*\n)*      \S+: [^\n]*runner\./mu);

  // The mirror's expected group set is the catalog's answer, carried from the step that
  // passed those roots to the generator -- not a second derivation that could drift, and
  // not the bundle's own directory listing.
  assert.match(block, /printf 'release_groups=%s\\n'/u);
  assert.match(block, /EXPECTED_RELEASE_GROUPS: \$\{\{ steps\.bundle\.outputs\.release_groups \}\}/u);
  assert.ok(
    block.indexOf('id: bundle') < block.indexOf('steps.bundle.outputs.release_groups'),
    'the emitting step must precede the consuming step',
  );

  assert.match(block, /node --test mono\/\.github\/scripts\/refresh-profile-host\.test\.mjs/u);
  assert.match(block, /node mono\/\.github\/scripts\/refresh-profile-host\.mjs/u);
  assert.ok(
    block.indexOf('refresh-profile-host.test.mjs') < block.indexOf('node mono/.github/scripts/refresh-profile-host.mjs'),
    'a broken helper must never reach the host',
  );

  assert.equal((block.match(/^\s+persist-credentials: false$/gmu) ?? []).length, 2);

  // Half-configured is loud, not silent: the guard precedes the host checkout, because
  // the token is needed to read a private host repository.
  const guardAt = block.indexOf('JINN_PROFILE_HOST_PUSH_TOKEN is not configured');
  assert.ok(guardAt > -1, 'the token guard must name the missing secret');
  assert.ok(guardAt < block.indexOf('repository: ${{ env.HOST_REPOSITORY }}'));
  assert.match(block, /::error::/u);
  assert.match(block, /exit 1/u);

  // The push is a plain fast-forward, gated on a real content change.
  assert.match(block, /steps\.mirror\.outputs\.changed == 'true'/u);
  assert.match(block, /HEAD:refs\/heads\/main/u);
  assert.doesNotMatch(block, /--force|push .*\+refs\//u);
  assert.match(block, /GIT_ASKPASS/u);
  assert.match(block, /GIT_TERMINAL_PROMPT=0/u);
  // The credential reaches exactly three steps: the guard, the host checkout (a private
  // host repository must be readable to be mirrored into), and the push. Naming the
  // steps is the actual property; an occurrence count is brittle prose-sensitive noise.
  const tokenSteps = block.split(/\n      - /u).slice(1)
    .filter((step) => step.includes('JINN_PROFILE_HOST_PUSH_TOKEN'))
    .map((step) => step.split('\n')[0].trim());
  assert.deepEqual(tokenSteps, [
    'name: Guard the host push credential',
    'name: Checkout the profile host',
    'name: Push to the host default branch',
  ]);
});

test('the live-host gate explains a stale host without claiming a lane-byte mismatch', () => {
  const liveHostAt = workflow.indexOf('stable-live-host-verification:');
  const attestationAt = workflow.indexOf('stable-live-host-attestation:');
  const block = workflow.slice(liveHostAt, attestationAt);

  assert.match(block, /id: gate/u);
  // Scoped to the gate step: a bare `if: failure()` would explain a stale host after a
  // failed checkout, when the job never reached the network.
  assert.match(block, /if: failure\(\) && steps\.gate\.outcome == 'failure'/u);
  assert.match(block, /host refresh may not have run yet/u);
  assert.match(block, /do not embed lane/u);
  assert.match(block, /identical content writes nothing/u);
  assert.doesNotMatch(block, /never byte-match a stable manifest/u);
  assert.match(block, /docs\/runbooks\/jinn-network-profile-hosting\.md/u);
});

test('stable resolves an exact tag SHA and shares verification without any publication path', () => {
  const resolverAt = workflow.indexOf('resolve-stable-source:');
  const stableVerificationAt = workflow.indexOf('stable-verification:');
  const liveHostAt = workflow.indexOf('stable-live-host-verification:');
  assert.ok(resolverAt > -1 && stableVerificationAt > resolverAt && liveHostAt > stableVerificationAt);
  const resolver = workflow.slice(resolverAt, stableVerificationAt);
  assert.match(resolver, /\^stack-v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
  assert.match(resolver, /git ls-remote origin "refs\/tags\/\$\{RELEASE_TAG\}"/u);
  assert.match(resolver, /git rev-parse "\$\{RELEASE_TAG\}\^\{commit\}"/u);
  assert.match(resolver, /git rev-parse HEAD/u);
  assert.match(resolver, /CHECKED_OUT.*RESOLVED/u);
  assert.match(resolver, /loadStackPublishedCatalogPackages/u);
  assert.doesNotMatch(resolver, /platform-v1/u);
  assert.match(resolver, /TAG_VERSION/u);
  assert.match(resolver, /fixture-immutability\.mjs\s+--registry-baseline\s+--version "\$\{TAG_VERSION\}"/u);
  assert.match(resolver, /source_sha=/u);
  const verification = workflow.slice(stableVerificationAt, liveHostAt);
  assert.match(verification, /uses: \.\/\.github\/workflows\/platform-verification\.yml/u);
  assert.match(verification, /source_sha: \$\{\{ needs\.resolve-stable-source\.outputs\.source_sha \}\}/u);
  assert.match(verification, /lane: stable/u);

  const stableSurface = workflow.slice(resolverAt);
  assert.doesNotMatch(stableSurface, /npm\s+publish|publish-verified-platform|publish-stack\.mjs/u);
  assert.doesNotMatch(stableSurface, /environment: npm-stable-publish/u);
});

test('the unconditional hosting blocker is gone, replaced by a real live-host gate', () => {
  assert.doesNotMatch(workflow, /stable-hosting-blocker/u);
  assert.doesNotMatch(workflow, /Keep Phase A stable publication mechanically disabled/u);
  assert.match(workflow, /^\s{2}stable-live-host-verification:/mu);
  assert.match(workflow, /node \.github\/scripts\/verify-live-profile-host\.mjs/u);
});

test('live-host verification needs the resolved source and the same-run verification', () => {
  const liveHostAt = workflow.indexOf('stable-live-host-verification:');
  const attestationAt = workflow.indexOf('stable-live-host-attestation:');
  const gateAt = workflow.indexOf('stable-publish-gate:');
  assert.ok(liveHostAt > -1 && attestationAt > liveHostAt && gateAt > attestationAt);
  const block = workflow.slice(liveHostAt, attestationAt);

  assert.match(block, /needs:\s*\n\s+- resolve-stable-source\s*\n\s+- stable-verification/u);
  assert.match(block, /github\.event_name == 'release' && startsWith\(github\.event\.release\.tag_name, 'stack-v'\)/u);
  assert.match(block, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(block, /timeout-minutes: 20/u);
  // The job talks to the public network: contents: read and nothing else.
  assert.match(block, /permissions:\s*\n\s+contents: read\s*\n/u);
  assert.doesNotMatch(block, /id-token: write|attestations: write/u);

  assert.match(block, /--lane stable/u);
  assert.match(block, /--release-group "\$\{group\}"/u);
  assert.match(block, /--origin "\$\{PROFILE_HOST_ORIGIN\}"/u);
  assert.match(block, /PROFILE_HOST_ORIGIN: https:\/\/spec\.jinn\.network/u);
  assert.match(block, /--public-key-url "\$\{PUBLIC_KEY_URL\}"/u);
  assert.match(block, /--expect-public-key-sha256 "\$\{PUBLIC_KEY_SHA256\}"/u);
  assert.match(block, /--root "\.platform-verification\/\$\{group\}\/profile-root"/u);
  assert.match(block, /--receipt "\.platform-verification-receipt\/\$\{group\}\/verification-receipt\.json"/u);
  assert.equal((block.match(/uses: actions\/download-artifact@v8/gu) ?? []).length, 2);
  assert.match(block, /name: platform-live-host-receipt/u);
  assert.match(block, /if-no-files-found: error/u);

  const attestation = workflow.slice(attestationAt, gateAt);
  assert.match(attestation, /uses: actions\/attest@v4/u);
  assert.match(attestation, /subject-path: \.platform-live-host-receipt\/\*\*\/live-host-receipt\.json/u);
  for (const permission of ['id-token: write', 'attestations: write', 'artifact-metadata: write']) {
    assert.ok(attestation.includes(permission), `missing attestation permission ${permission}`);
  }
});

test('the publish gate always runs, needs exact success from every proof job, and holds no permissions', () => {
  const gateAt = workflow.indexOf('stable-publish-gate:');
  const gate = workflow.slice(gateAt);
  assert.match(gate, /needs:\s*\n\s+- stable-verification\s*\n\s+- stable-live-host-verification\s*\n\s+- stable-live-host-attestation/u);
  assert.match(gate, /always\(\)/u);
  assert.match(gate, /permissions: \{\}/u);
  assert.match(gate, /needs\.stable-verification\.result/u);
  assert.match(gate, /needs\.stable-live-host-verification\.result/u);
  assert.match(gate, /needs\.stable-live-host-attestation\.result/u);
  assert.match(gate, /!= "success"/u);
  assert.match(gate, /::error::/u);
  assert.match(gate, /exit 1/u);
});

test('no job in the workflow may soften a failure with continue-on-error', () => {
  assert.doesNotMatch(workflow, /continue-on-error/u);
});

test('the Phase A boolean hold and old polling or parallel best-effort jobs are gone', () => {
  assert.doesNotMatch(workflow, /PHASE_A_STACK_CONVERGENCE_VERIFIED/u);
  assert.doesNotMatch(workflow, /workflow_run|listWorkflowRuns|checks\.listForRef/u);
  assert.doesNotMatch(workflow, /^\s{2}(registrations|profile-root):/mu);
  assert.doesNotMatch(workflow, /Trusted-publisher registration list|Profile root artifact/u);
});

test('trusted publishing uses current action majors and no long-lived npm token', () => {
  assert.match(workflow, /actions\/checkout@v7/u);
  assert.match(workflow, /actions\/setup-node@v7/u);
  assert.match(workflow, /npm install -g npm@11\.19\.0/u);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/u);
});
