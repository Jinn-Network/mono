import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { STACK_ROOTS, buildDependencyGraph, discoverStackPackages, topologicalWaves } from './stack-package-graph.mjs';

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

test('the graph keeps in-set edges from all four dependency sections and drops the rest', () => {
  const packages = [
    { directory: 'packages/trust/core', name: '@jinn-network/trust-core', manifest: { dependencies: { zod: '4.4.3' } } },
    {
      directory: 'packages/trust/resolve',
      name: '@jinn-network/trust-resolve',
      manifest: {
        dependencies: { '@jinn-network/trust-core': '0.1.0', zod: '4.4.3' },
        devDependencies: { '@jinn-network/trust-testing': '0.1.0', vitest: '4.1.8' },
        peerDependencies: { vitest: '^4.1.8' },
        optionalDependencies: {},
      },
    },
    { directory: 'packages/trust/testing', name: '@jinn-network/trust-testing', manifest: { dependencies: { '@jinn-network/trust-core': '0.1.0' } } },
  ];
  const graph = buildDependencyGraph(packages);
  assert.deepEqual([...graph.get('@jinn-network/trust-core')], []);
  assert.deepEqual(
    [...graph.get('@jinn-network/trust-resolve')].sort(),
    ['@jinn-network/trust-core', '@jinn-network/trust-testing'],
  );
});

test('a self-edge is ignored rather than reported as a cycle', () => {
  const graph = buildDependencyGraph([
    { directory: 'packages/trust/core', name: '@jinn-network/trust-core', manifest: { devDependencies: { '@jinn-network/trust-core': '0.1.0' } } },
  ]);
  assert.deepEqual([...graph.get('@jinn-network/trust-core')], []);
  assert.deepEqual(topologicalWaves(graph), [['@jinn-network/trust-core']]);
});

test('waves are dependency-first and each wave is sorted', () => {
  const graph = new Map([
    ['c', new Set(['a', 'b'])],
    ['b', new Set(['a'])],
    ['a', new Set()],
    ['d', new Set(['a'])],
  ]);
  assert.deepEqual(topologicalWaves(graph), [['a'], ['b', 'd'], ['c']]);
});

test('a cycle throws and names every member', () => {
  const graph = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
    ['c', new Set()],
  ]);
  assert.throws(
    () => topologicalWaves(graph),
    /dependency cycle among platform packages: a, b/,
  );
});

test('the real repository graph is acyclic and its first wave is the three sealed protocols', () => {
  const waves = topologicalWaves(buildDependencyGraph(discoverStackPackages(repoRoot)));
  assert.deepEqual(waves[0], [
    '@jinn-network/evidence-protocol',
    '@jinn-network/task-execution-protocol',
    '@jinn-network/trust-core',
  ]);
  const flattened = waves.flat();
  assert.equal(new Set(flattened).size, flattened.length, 'a package must appear in exactly one wave');
  assert.ok(flattened.length >= 45);
});
