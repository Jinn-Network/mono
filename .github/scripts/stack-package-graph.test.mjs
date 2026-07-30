import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { STACK_ROOTS, discoverStackPackages } from './stack-package-graph.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

function fixtureRepo(packages) {
  const root = mkdtempSync(join(tmpdir(), 'jinn-stack-graph-'));
  for (const [directory, manifest] of Object.entries(packages)) {
    const dir = join(root, directory);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return root;
}

const publishable = (name, extra = {}) => ({
  name,
  version: '0.1.0',
  publishConfig: { access: 'public' },
  ...extra,
});

test('STACK_ROOTS names exactly the six platform trees', () => {
  assert.deepEqual(STACK_ROOTS, [
    'packages/benchmarking',
    'packages/discovery',
    'packages/evidence',
    'packages/marketplace',
    'packages/task-execution',
    'packages/trust',
  ]);
});

test('discovers nested packages at any depth and sorts by directory', () => {
  const root = fixtureRepo({
    'packages/evidence/protocol': publishable('@jinn-network/evidence-protocol'),
    'packages/task-execution/backend-local/workspace': publishable('@jinn-network/task-execution-workspace'),
    'packages/trust/core': publishable('@jinn-network/trust-core'),
  });
  try {
    const found = discoverStackPackages(root);
    assert.deepEqual(found.map((p) => p.directory), [
      'packages/evidence/protocol',
      'packages/task-execution/backend-local/workspace',
      'packages/trust/core',
    ]);
    assert.equal(found[0].name, '@jinn-network/evidence-protocol');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skips node_modules trees', () => {
  const root = fixtureRepo({
    'packages/trust/core': publishable('@jinn-network/trust-core'),
    'packages/trust/core/node_modules/left-pad': { name: 'left-pad', version: '1.0.0' },
  });
  try {
    assert.deepEqual(discoverStackPackages(root).map((p) => p.name), ['@jinn-network/trust-core']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a platform package that is not publishable', () => {
  const root = fixtureRepo({
    'packages/trust/core': { name: '@jinn-network/trust-core', version: '0.1.0' },
  });
  try {
    assert.throws(
      () => discoverStackPackages(root),
      /packages\/trust\/core: platform packages must declare publishConfig.access "public"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a platform package outside the @jinn-network scope', () => {
  const root = fixtureRepo({
    'packages/trust/core': publishable('trust-core'),
  });
  try {
    assert.throws(
      () => discoverStackPackages(root),
      /packages\/trust\/core: platform packages must be named under @jinn-network\//,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real repository set is discovered without a hard-coded list', () => {
  const found = discoverStackPackages(repoRoot);
  assert.ok(found.length >= 45, `expected at least 45 platform packages, found ${found.length}`);
  assert.equal(new Set(found.map((p) => p.name)).size, found.length, 'package names must be unique');
  for (const root of STACK_ROOTS) {
    assert.ok(
      found.some((p) => p.directory.startsWith(`${root}/`)),
      `no packages discovered under ${root}`,
    );
  }
});
