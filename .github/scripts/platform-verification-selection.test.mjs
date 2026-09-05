import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  GATE_DOMAINS,
  GLOBAL_SELECTORS,
  selectVerification,
} from './platform-verification-selection.mjs';
import { loadPlatformCatalog, stackPublishedReleaseGroupIds } from './platform-catalog.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const select = (changedFiles) => selectVerification({ repoRoot, changedFiles });

test('every required gate of stack-published groups maps to a catalog domain', () => {
  const catalog = loadPlatformCatalog(repoRoot);
  const declared = [...new Set(
    stackPublishedReleaseGroupIds(catalog)
      .flatMap((groupId) => catalog.releaseGroups[groupId].requiredGateIds),
  )].sort();
  assert.deepEqual([...GATE_DOMAINS.keys()].sort(), declared);

  const domains = new Set(catalog.packages.map((pkg) => pkg.domain));
  for (const domain of GATE_DOMAINS.values()) {
    assert.ok(domains.has(domain), `gate domain ${domain} is not a catalog domain`);
  }
});

test('a changed package selects lanes through its dependents, not its own domain label', () => {
  // `packages/evidence/discovery` is domain `evidence`, but
  // `packages/discovery/facts/evidence` consumes it. A label-only gate would skip
  // `discovery` here; the dependency closure must not.
  const result = select(['packages/evidence/discovery/src/index.ts']);
  assert.equal(result.run, true);
  assert.ok(
    result.selectedDomains.includes('discovery'),
    `expected the discovery lane via a cross-domain dependent, got ${result.selectedDomains.join(', ')}`,
  );
  assert.ok(result.selectedDomains.includes('evidence'));
});

test('a leaf protocol package reaches every verified lane', () => {
  const result = select(['packages/evidence/protocol/src/index.ts']);
  assert.equal(result.run, true);
  assert.deepEqual(result.selectedDomains, [...new Set(GATE_DOMAINS.values())].sort());
});

test('an unmatched path defaults to full verification', () => {
  const result = select(['some-uncatalogued-directory/index.ts']);
  assert.equal(result.run, true);
  assert.match(result.reason, /unmatched paths default to full verification/u);
});

test('an empty change set defaults to full verification', () => {
  const result = select([]);
  assert.equal(result.run, true);
});

test('global selectors force full verification', () => {
  for (const selector of GLOBAL_SELECTORS) {
    const path = selector.endsWith('/') ? `${selector}probe.yml` : selector;
    const result = select([path]);
    assert.equal(result.run, true, `${path} must force verification`);
    assert.match(result.reason, /global selector/u);
  }
});

test('generated architecture output does not force verification', () => {
  // `generate-architecture.mjs --check` already guards this in the always-on job.
  const result = select([
    'architecture/generated/platform-topology.md',
    'architecture/generated/platform-topology.v1.json',
  ]);
  assert.equal(result.run, false);
});

test('operator-only and documentation-only changes skip verification', () => {
  // The motivating case: PRs touching only the operator app and docs paid for all
  // six lanes because `workflow_call` ignores `paths:` filters.
  const result = select([
    'operator/src/cli/commands/native-requester.ts',
    'apps/operator-console/app/page.tsx',
    'docs/engineering/handbook.md',
  ]);
  assert.equal(result.run, false);
  assert.deepEqual(result.selectedDomains, []);
});

// The CLI reads stdin as `buffer.split('\n')`, so an empty stream arrives as
// `['']` — length 1, which slipped past a pre-normalization emptiness check and
// unselected every lane. These pin the documented fail-safe through the entry
// point that actually has the bug (spawn, not a direct function call).
const cli = (stdin) => {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'platform-verification-selection.mjs'), '--repo-root', repoRoot],
    { input: stdin, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `selector exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
};

test('empty stdin selects full verification through the CLI', () => {
  const result = cli('');
  assert.equal(result.run, true);
  assert.match(result.reason, /no changed files reported/u);
  assert.deepEqual(result.selectedDomains, [...new Set(GATE_DOMAINS.values())].sort());
});

test('blank-lines-only stdin selects full verification through the CLI', () => {
  const result = cli('\n\n   \n\t\n');
  assert.equal(result.run, true);
  assert.match(result.reason, /no changed files reported/u);
});

test('the CLI still unselects for a genuinely irrelevant diff', () => {
  // Control: the fail-safe must not have been widened into selecting everything.
  const result = cli('docs/engineering/handbook.md\n');
  assert.equal(result.run, false);
});

test('blank entries passed directly select full verification', () => {
  const result = select(['', '   ']);
  assert.equal(result.run, true);
  assert.match(result.reason, /no changed files reported/u);
});
