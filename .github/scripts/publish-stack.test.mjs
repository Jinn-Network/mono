import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  buildPublishPlan,
  parsePublishArgs,
} from './publish-stack.mjs';
import { fixtureRepo } from './platform-catalog-test-fixture.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const script = resolve(import.meta.dirname, 'publish-stack.mjs');
const SHA = 'b'.repeat(40);

test('argument parsing accepts the canary and stable forms', () => {
  assert.deepEqual(parsePublishArgs(['--mode', 'canary', '--sha', SHA, '--dry-run']), {
    mode: 'canary', sha: SHA, releaseTag: undefined, dryRun: true, npmCommand: 'npm', repoRoot: process.cwd(),
  });
  assert.deepEqual(parsePublishArgs(['--mode', 'stable', '--release-tag', 'stack-v0.1.0', '--root', '/tmp/x']), {
    mode: 'stable', sha: undefined, releaseTag: 'stack-v0.1.0', dryRun: false, npmCommand: 'npm', repoRoot: '/tmp/x',
  });
});

test('argument parsing rejects unknown flags and a missing mode', () => {
  assert.throws(() => parsePublishArgs(['--wat', '1']), /unknown argument: --wat/);
  assert.throws(() => parsePublishArgs(['--sha', SHA]), /--mode is required/);
});

test('the plan covers every package exactly once, in wave order', () => {
  const plan = buildPublishPlan({ repoRoot, mode: 'canary', sha: SHA });
  assert.equal(plan.distTag, 'canary');
  assert.match(plan.version, new RegExp(`^0\\.1\\.0-canary\\.sha\\.${SHA}$`));
  const flattened = plan.waves.flat();
  assert.equal(flattened.length, 50);
  assert.equal(new Set(flattened.map((entry) => entry.name)).size, flattened.length);
  for (const entry of flattened) assert.equal(entry.spec, `${entry.name}@${plan.version}`);
  assert.deepEqual(plan.waves[0].map((entry) => entry.name), [
    '@jinn-network/evidence-protocol',
    '@jinn-network/task-execution-protocol',
    '@jinn-network/trust-core',
  ]);
});

test('the plan refuses a package set whose versions disagree', () => {
  assert.throws(
    () => buildPublishPlan({ repoRoot, mode: 'stable', releaseTag: 'stack-v9.9.9' }),
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
  const result = spawnSync(process.execPath, [script, '--mode', 'canary', '--sha', SHA, '--dry-run', '--root', repoRoot], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wave 0: @jinn-network\/evidence-protocol/);
  assert.match(result.stdout, new RegExp(`publish version 0\\.1\\.0-canary\\.sha\\.${SHA} at canary`));
  const status = spawnSync('git', ['status', '--porcelain', 'packages/'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(status.stdout.trim(), '', 'a dry run must leave the working tree clean');
});
