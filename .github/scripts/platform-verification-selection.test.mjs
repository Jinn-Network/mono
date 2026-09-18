import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  GATE_DOMAINS,
  GLOBAL_SELECTORS,
  selectVerification,
} from './platform-verification-selection.mjs';
import { loadPlatformCatalog, stackPublishedReleaseGroupIds } from './platform-catalog.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const select = (changedFiles) => selectVerification({ repoRoot, changedFiles });

// Selection matches on path prefix, so a fixture's leaf name is never resolved
// and a phantom path would pass silently. Every fixture path is therefore
// declared as one of two kinds, and the declaration is checked against the tree:
// `real` names a file that must exist, `synthetic` names one that must not.
const real = (path) => {
  assert.ok(existsSync(resolve(repoRoot, path)), `real fixture path does not exist: ${path}`);
  return path;
};
const synthetic = (path) => {
  assert.ok(!existsSync(resolve(repoRoot, path)), `synthetic fixture path exists: ${path}`);
  return path;
};

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
  const result = select([real('packages/evidence/discovery/src/index.ts')]);
  assert.equal(result.run, true);
  assert.ok(
    result.selectedDomains.includes('discovery'),
    `expected the discovery lane via a cross-domain dependent, got ${result.selectedDomains.join(', ')}`,
  );
  assert.ok(result.selectedDomains.includes('evidence'));
});

// `contracts` is excluded: `@jinn-network/contract-abis` is a source-of-truth
// leaf that depends on nothing, so no other package's change can reach its lane
// through the dependency closure. It is selected by its own path (below).
test('a leaf protocol package reaches every verified lane it can reach', () => {
  const result = select([real('packages/evidence/protocol/src/index.ts')]);
  assert.equal(result.run, true);
  assert.deepEqual(
    result.selectedDomains,
    [...new Set(GATE_DOMAINS.values())].filter((domain) => domain !== 'contracts').sort(),
  );
});

test('a contract-abis change selects the contracts lane and its consumers', () => {
  const result = select([real('packages/contract-abis/src/generated/slices/bindingJinnRouterV3.ts')]);
  assert.equal(result.run, true);
  assert.ok(
    result.selectedDomains.includes('contracts'),
    `expected the contracts lane, got ${result.selectedDomains.join(', ')}`,
  );
  assert.ok(result.selectedDomains.includes('marketplace'));
});

test('an unmatched path defaults to full verification', () => {
  const result = select([synthetic('some-uncatalogued-directory/index.ts')]);
  assert.equal(result.run, true);
  assert.match(result.reason, /unmatched paths default to full verification/u);
});

test('an empty change set defaults to full verification', () => {
  const result = select([]);
  assert.equal(result.run, true);
});

test('global selectors force full verification', () => {
  for (const selector of GLOBAL_SELECTORS) {
    const path = selector.endsWith('/') ? synthetic(`${selector}probe.yml`) : real(selector);
    const result = select([path]);
    assert.equal(result.run, true, `${path} must force verification`);
    assert.match(result.reason, /global selector/u);
  }
});

test('generated architecture output does not force verification', () => {
  // `generate-architecture.mjs --check` already guards this in the always-on job.
  const result = select([
    real('architecture/generated/platform-topology.md'),
    real('architecture/generated/platform-topology.v1.json'),
  ]);
  assert.equal(result.run, false);
});

test('operator-only and documentation-only changes skip verification', () => {
  // The motivating case: PRs touching only the operator app and docs paid for all
  // six lanes because `workflow_call` ignores `paths:` filters.
  const result = select([
    real('operator/src/cli/commands/native-requester.ts'),
    real('apps/operator-console/app/page.tsx'),
    real('docs/engineering/handbook.md'),
  ]);
  assert.equal(result.run, false);
  assert.deepEqual(result.selectedDomains, []);
});

// The CLI reads stdin as `buffer.split('\n')`, so an empty stream arrives as
// `['']` — length 1, which slipped past a pre-normalization emptiness check and
// unselected every lane. These pin the documented fail-safe through the entry
// point that actually has the bug (spawn, not a direct function call).
const cli = (stdin, script = resolve(import.meta.dirname, 'platform-verification-selection.mjs')) => {
  const result = spawnSync(
    process.execPath,
    [script, '--repo-root', repoRoot],
    { input: stdin, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `selector exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
};

// #4144: the entry guard compared the raw `argv[1]` with a percent-encoded URL
// pathname, so from a checkout path containing a space the CLI printed nothing, and
// comparing unresolved paths printed nothing through a symlinked directory.
test('the CLI runs from a checkout path containing a space or reached through a symlink (#4144)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinn selector space-'));
  try {
    for (const file of [
      'platform-verification-selection.mjs',
      'platform-catalog.mjs',
      'public-surface-assets.mjs',
      'repository-candidates.mjs',
    ]) {
      copyFileSync(resolve(import.meta.dirname, file), join(dir, file));
    }
    symlinkSync(dir, join(dir, 'via link'));
    for (const script of [join(dir, 'platform-verification-selection.mjs'), join(dir, 'via link', 'platform-verification-selection.mjs')]) {
      assert.equal(typeof cli(`${real('docs/engineering/handbook.md')}\n`, script).run, 'boolean', script);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
  const result = cli(`${real('docs/engineering/handbook.md')}\n`);
  assert.equal(result.run, false);
});

test('blank entries passed directly select full verification', () => {
  const result = select(['', '   ']);
  assert.equal(result.run, true);
  assert.match(result.reason, /no changed files reported/u);
});
