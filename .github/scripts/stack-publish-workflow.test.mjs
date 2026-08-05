import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflowPath = resolve(import.meta.dirname, '../workflows/stack-npm-publish.yml');
const workflow = readFileSync(workflowPath, 'utf8');

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
  assert.match(block, /JINN_MARKETPLACE_FORK_RPC_URL: \$\{\{ secrets\.JINN_MARKETPLACE_FORK_RPC_URL \}\}/u);
  assert.doesNotMatch(block, /secrets: inherit/u);
});

test('the canary publisher directly needs exact verification success', () => {
  const publishAt = workflow.indexOf('canary-publish:');
  const stableAt = workflow.indexOf('resolve-stable-source:');
  const block = workflow.slice(publishAt, stableAt);
  assert.match(block, /needs: canary-verification/u);
  assert.match(block, /needs\.canary-verification\.result == 'success'/u);
  assert.match(block, /github\.event_name == 'push'/u);
  assert.match(block, /vars\.PLATFORM_CANARY_PUBLISH_ENABLED == 'true'/u);
  assert.match(block, /environment: npm-publish/u);
  assert.equal((workflow.match(/environment: npm-publish/gu) ?? []).length, 1);
});

test('the publisher downloads only the current run verification artifacts and receipt', () => {
  const publishAt = workflow.indexOf('canary-publish:');
  const stableAt = workflow.indexOf('resolve-stable-source:');
  const block = workflow.slice(publishAt, stableAt);
  assert.equal((block.match(/uses: actions\/download-artifact@v4/gu) ?? []).length, 2);
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
  const stableAt = workflow.indexOf('resolve-stable-source:');
  const block = workflow.slice(publishAt, stableAt);
  assert.match(block, /GITHUB_REPOSITORY/u);
  assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(block, /SOURCE_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(block, /--source-sha "\$\{SOURCE_SHA\}"/u);
  assert.match(block, /--registry https:\/\/registry\.npmjs\.org\//u);
  assert.match(block, /--release-group platform-v1/u);
  assert.match(block, /--lane canary/u);
});

test('the final deterministic publication receipt is attested and uploaded', () => {
  const publishAt = workflow.indexOf('canary-publish:');
  const stableAt = workflow.indexOf('resolve-stable-source:');
  const block = workflow.slice(publishAt, stableAt);
  assert.match(block, /uses: actions\/attest@v4/u);
  assert.match(block, /subject-path: \.platform-publication\/publication-receipt\.json/u);
  assert.match(block, /uses: actions\/upload-artifact@v4/u);
  assert.match(block, /name: platform-publication-receipt/u);
  assert.match(block, /if-no-files-found: error/u);
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
  assert.match(resolver, /loadCatalogPackages/u);
  assert.match(resolver, /platform-v1/u);
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
  assert.match(block, /--release-group platform-v1/u);
  assert.match(block, /--origin "\$\{PROFILE_HOST_ORIGIN\}"/u);
  assert.match(block, /PROFILE_HOST_ORIGIN: https:\/\/spec\.jinn\.network/u);
  assert.match(block, /--public-key-url "\$\{PUBLIC_KEY_URL\}"/u);
  assert.match(block, /--expect-public-key-sha256 "\$\{PUBLIC_KEY_SHA256\}"/u);
  assert.match(block, /--root \.platform-verification\/profile-root/u);
  assert.match(block, /--receipt \.platform-verification-receipt\/verification-receipt\.json/u);
  assert.equal((block.match(/uses: actions\/download-artifact@v4/gu) ?? []).length, 2);
  assert.match(block, /name: platform-live-host-receipt/u);
  assert.match(block, /if-no-files-found: error/u);

  const attestation = workflow.slice(attestationAt, gateAt);
  assert.match(attestation, /uses: actions\/attest@v4/u);
  assert.match(attestation, /subject-path: \.platform-live-host-receipt\/live-host-receipt\.json/u);
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
