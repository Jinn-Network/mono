import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  buildPublishPlan,
  parsePublishArgs,
} from './publish-stack.mjs';
import { fixtureRepo } from './platform-catalog-test-fixture.mjs';
import { loadCatalogPackages } from './platform-catalog.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const script = resolve(import.meta.dirname, 'publish-stack.mjs');
const SHA = 'b'.repeat(40);

test('argument parsing accepts the canary and stable forms', () => {
  assert.deepEqual(parsePublishArgs(['--mode', 'canary', '--sha', SHA, '--dry-run']), {
    mode: 'canary', sha: SHA, releaseTag: undefined, dryRun: true, repoRoot: process.cwd(), releaseGroup: undefined,
  });
  assert.deepEqual(parsePublishArgs(['--mode', 'stable', '--release-tag', 'stack-v0.1.0', '--root', '/tmp/x', '--release-group', 'other']), {
    mode: 'stable', sha: undefined, releaseTag: 'stack-v0.1.0', dryRun: false, repoRoot: '/tmp/x', releaseGroup: 'other',
  });
});

test('argument parsing rejects unknown flags and a missing mode', () => {
  assert.throws(() => parsePublishArgs(['--wat', '1']), /unknown argument: --wat/);
  assert.throws(() => parsePublishArgs(['--sha', SHA]), /--mode is required/);
});

test('the plan covers every package exactly once, in wave order', () => {
  const plan = buildPublishPlan({ repoRoot, mode: 'canary', sha: SHA, releaseGroup: 'sealed-platform-v1' });
  assert.equal(plan.distTag, 'canary');
  assert.match(plan.version, new RegExp(`^0\\.1\\.0-canary\\.sha\\.${SHA}$`));
  const flattened = plan.waves.flat();
  const expectedNames = loadCatalogPackages(repoRoot, { releaseGroup: 'sealed-platform-v1' })
    .map(({ name }) => name);
  assert.deepEqual(new Set(flattened.map(({ name }) => name)), new Set(expectedNames));
  assert.equal(new Set(flattened.map((entry) => entry.name)).size, flattened.length);
  for (const entry of flattened) assert.equal(entry.spec, `${entry.name}@${plan.version}`);
});

test('the plan refuses a package set whose versions disagree', () => {
  assert.throws(
    () => buildPublishPlan({ repoRoot, mode: 'stable', releaseTag: 'stack-v9.9.9', releaseGroup: 'sealed-platform-v1' }),
    /release tag stack-v9.9.9 resolves to 9.9.9, but the package set is at 0.1.0/,
  );
});

test('--dry-run fails loudly on a genuine planning defect in a catalog-backed package set', () => {
  const brokenRoot = fixtureRepo({
    manifests: {
      'packages/fixture/core-01': {
        name: '@jinn-network/fixture-core-01',
        version: '9.9.9',
      },
    },
  });
  try {
    const result = spawnSync(process.execPath, [script, '--mode', 'canary', '--sha', SHA, '--dry-run', '--root', brokenRoot], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /the platform package set must carry one version/);
  } finally {
    rmSync(brokenRoot, { recursive: true, force: true });
  }
});

test('--dry-run prints the ordered plan and exits 0 without touching the working tree', () => {
  const before = spawnSync('git', ['status', '--porcelain', 'packages/'], { cwd: repoRoot, encoding: 'utf8' });
  const result = spawnSync(process.execPath, [script, '--mode', 'canary', '--sha', SHA, '--dry-run', '--root', repoRoot, '--release-group', 'sealed-platform-v1'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /wave 0: @jinn-network\/chain-environment-record, @jinn-network\/environment-record, @jinn-network\/evidence-protocol, @jinn-network\/task-execution-protocol, @jinn-network\/trust-core/,
  );
  assert.match(result.stdout, /13 packages in 3 waves/);
  assert.match(result.stdout, new RegExp(`publish version 0\\.1\\.0-canary\\.sha\\.${SHA} at canary`));
  const after = spawnSync('git', ['status', '--porcelain', 'packages/'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(after.stdout, before.stdout, 'a dry run must leave the working tree unchanged');
});

function runNonDryWithInjectedCommands(mode) {
  const toolsRoot = mkdtempSync(join(tmpdir(), 'jinn-legacy-publisher-tools-'));
  const callLog = join(toolsRoot, 'npm-calls.jsonl');
  const npmPath = join(toolsRoot, 'npm');
  writeFileSync(npmPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$JINN_TEST_NPM_CALLS"\nexit 99\n', 'utf8');
  chmodSync(npmPath, 0o755);
  const missingRoot = join(toolsRoot, 'missing-repository');
  const args = mode === 'canary'
    ? [script, '--mode', 'canary', '--sha', SHA, '--root', missingRoot]
    : [script, '--mode', 'stable', '--release-tag', 'stack-v0.1.0', '--sha', SHA, '--root', missingRoot];
  try {
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${toolsRoot}:${process.env.PATH}`,
        JINN_TEST_NPM_CALLS: callLog,
      },
    });
    const npmCalls = existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { result, npmCalls };
  } finally {
    rmSync(toolsRoot, { recursive: true, force: true });
  }
}

test('non-dry canary CLI refuses with receipt-gated migration guidance before any npm command', () => {
  const { result, npmCalls } = runNonDryWithInjectedCommands('canary');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /direct publication is disabled.*publish-verified-platform\.mjs/su);
  assert.deepEqual(npmCalls, []);
});

test('non-dry stable CLI refuses with receipt-gated migration guidance before any npm command', () => {
  const { result, npmCalls } = runNonDryWithInjectedCommands('stable');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /direct publication is disabled.*publish-verified-platform\.mjs/su);
  assert.deepEqual(npmCalls, []);
});
