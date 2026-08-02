import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflowsRoot = resolve(import.meta.dirname, '../workflows');
const platformPath = resolve(workflowsRoot, 'platform-verification.yml');
const platform = readFileSync(platformPath, 'utf8');
const domains = new Map([
  ['benchmarking', 'benchmarking-ci.yml'],
  ['discovery', 'record-discovery-ci.yml'],
  ['evidence', 'evidence-ci.yml'],
  ['marketplace', 'marketplace-ci.yml'],
  ['task_execution', 'task-execution-ci.yml'],
  ['trust', 'trust-ci.yml'],
].map(([job, filename]) => [job, {
  filename,
  source: readFileSync(resolve(workflowsRoot, filename), 'utf8'),
}]));

function jobBlock(source, jobId) {
  const start = source.indexOf(`\n  ${jobId}:\n`);
  assert.notEqual(start, -1, `missing job ${jobId}`);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/^  [a-zA-Z0-9_-]+:\n/mu);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('the reusable interface requires source_sha and lane', () => {
  const header = platform.slice(0, platform.indexOf('\njobs:\n'));
  assert.match(header, /workflow_call:\n\s+inputs:\n/u);
  for (const input of ['source_sha', 'lane']) {
    assert.match(header, new RegExp(`${input}:\\n\\s+required: true\\n\\s+type: string`, 'u'));
  }
  assert.match(
    header,
    /secrets:\n\s+JINN_MARKETPLACE_FORK_RPC_URL:\n\s+required: false/u,
    'the reusable interface must name its only optional domain secret',
  );
  assert.match(header, /contents: read/u);
  for (const job of ['artifacts', 'verification_receipt']) {
    const block = jobBlock(platform, job);
    assert.match(block, /id-token: write/u);
    assert.match(block, /attestations: write/u);
    assert.match(block, /artifact-metadata: write/u);
  }
});

test('the new workflow uses the repository release-gate action versions', () => {
  assert.doesNotMatch(platform, /uses: actions\/(?:checkout|setup-node)@v4/u);
  assert.equal((platform.match(/uses: actions\/checkout@v7/gu) ?? []).length, 4);
  assert.equal((platform.match(/uses: actions\/setup-node@v7/gu) ?? []).length, 4);
});

test('catalog validation binds the requested source to the caller SHA and exports the digest', () => {
  const catalog = jobBlock(platform, 'catalog');
  assert.match(catalog, /SOURCE_SHA: \$\{\{ inputs\.source_sha \}\}/u);
  assert.match(catalog, /CALLER_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(catalog, /test "\$\{SOURCE_SHA\}" = "\$\{CALLER_SHA\}"/u);
  assert.match(catalog, /git rev-parse HEAD/u);
  assert.match(catalog, /loadPlatformCatalog/u);
  assert.match(catalog, /catalogSha256/u);
  assert.match(catalog, /catalog_digest: \$\{\{ steps\.catalog\.outputs\.digest \}\}/u);
});

test('all six domain workflows remain independently triggered and become static reusable calls', () => {
  for (const [jobId, { filename, source }] of domains) {
    const header = source.slice(0, source.indexOf('\npermissions:\n'));
    assert.match(header, /pull_request:/u, `${filename} lost pull_request`);
    assert.match(header, /push:/u, `${filename} lost push`);
    assert.match(header, /workflow_call:/u, `${filename} is not reusable`);

    const block = jobBlock(platform, jobId);
    assert.match(block, /needs: catalog/u);
    assert.match(block, new RegExp(`uses: \\.\\/.github/workflows/${filename.replace('.', '\\.')}\\n`, 'u'));
    assert.doesNotMatch(block, /secrets: inherit/u);
    if (jobId === 'marketplace') {
      assert.match(
        block,
        /secrets:\n\s+JINN_MARKETPLACE_FORK_RPC_URL: \$\{\{ secrets\.JINN_MARKETPLACE_FORK_RPC_URL \}\}/u,
      );
      assert.match(
        source.slice(0, source.indexOf('\npermissions:\n')),
        /workflow_call:\n\s+secrets:\n\s+JINN_MARKETPLACE_FORK_RPC_URL:\n\s+required: false/u,
      );
    } else {
      assert.doesNotMatch(block, /\n\s+secrets:/u, `${filename} must receive no caller secrets`);
    }
  }
  assert.match(domains.get('task_execution').source, /workflow_dispatch:/u);
});

test('artifacts build public/profile/pack outputs and attest every prepublication subject', () => {
  const artifacts = jobBlock(platform, 'artifacts');
  assert.match(artifacts, /build-platform-public-surface\.mjs/u);
  assert.match(artifacts, /build-profile-root\.mjs/u);
  assert.match(artifacts, /build-prepublication-bundle\.mjs/u);
  assert.match(artifacts, /--source-sha "\$\{SOURCE_SHA\}"/u);
  assert.match(artifacts, /--catalog-digest "\$\{CATALOG_DIGEST\}"/u);
  assert.match(artifacts, /--lane "\$\{LANE\}"/u);
  assert.match(artifacts, /uses: actions\/attest@v4/u);
  assert.match(artifacts, /\.platform-verification\/pack\/tarballs\/\*\.tgz/u);
  assert.match(artifacts, /\.platform-verification\/public-surface-manifest\.json/u);
  assert.match(artifacts, /\.platform-verification\/profile-root\/\*\*/u);
  assert.match(artifacts, /uses: actions\/upload-artifact@v4/u);
  assert.match(
    artifacts,
    /uses: actions\/upload-artifact@v4[\s\S]*?include-hidden-files: true/u,
    'the dot-directory artifact must opt in to hidden files',
  );
});

test('external consumer accepts only the downloaded same-run tarball bundle', () => {
  const consumer = jobBlock(platform, 'external_consumer');
  assert.match(consumer, /needs: artifacts/u);
  assert.match(consumer, /uses: actions\/download-artifact@v4/u);
  assert.match(consumer, /prepublication-external-consumer\.mjs/u);
  assert.match(consumer, /\.platform-verification\/pack\/manifest\.json/u);
});

test('the always-running receipt receives every exact job conclusion and is uploaded/attested only on success', () => {
  const receipt = jobBlock(platform, 'verification_receipt');
  assert.match(receipt, /if: always\(\)/u);
  for (const need of [
    'catalog',
    'benchmarking',
    'discovery',
    'evidence',
    'marketplace',
    'task_execution',
    'trust',
    'artifacts',
    'external_consumer',
  ]) {
    assert.match(receipt, new RegExp(`needs\\.${need}\\.result`, 'u'), `receipt omits ${need}`);
  }
  for (const gate of [
    'catalog',
    'benchmarking',
    'record-discovery',
    'evidence',
    'marketplace',
    'task-execution',
    'trust',
    'artifacts',
    'external-consumer',
  ]) {
    assert.match(receipt, new RegExp(`--gate "${gate}=\\$\\{[A-Z_]+_RESULT\\}"`, 'u'));
  }
  assert.match(receipt, /platform-verification-receipt\.mjs/u);
  assert.match(receipt, /uses: actions\/attest@v4/u);
  assert.match(receipt, /uses: actions\/upload-artifact@v4/u);
  assert.match(
    receipt,
    /uses: actions\/upload-artifact@v4[\s\S]*?include-hidden-files: true/u,
    'the dot-directory receipt must opt in to hidden files',
  );
  assert.equal((receipt.match(/if: success\(\)/gu) ?? []).length, 2);
});

test('prepublication verification cannot publish or wait permissively for a registry', () => {
  assert.doesNotMatch(platform, /npm\s+publish|publish-stack\.mjs(?![^\n]*--dry-run)/u);
  assert.doesNotMatch(platform, /\bsleep\b|\buntil\b|\bwhile\b/u);
  assert.doesNotMatch(platform, /stack-npm-publish\.yml/u);
});
