import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { loadCatalogPackages } from './platform-catalog.mjs';
import { fixtureRepo } from './platform-catalog-test-fixture.mjs';
import * as stackPackageGraph from './stack-package-graph.mjs';

const { buildDependencyGraph, discoverStackPackages, topologicalWaves } = stackPackageGraph;

const repoRoot = resolve(import.meta.dirname, '../..');

test('the compatibility entry point selects only the controlled catalog platform-v1 group', () => {
  const root = fixtureRepo();
  try {
    const found = discoverStackPackages(root);
    const expected = loadCatalogPackages(root, { releaseGroup: 'platform-v1' });
    assert.equal(found.length, expected.length);
    assert.deepEqual(found.map((pkg) => pkg.name), expected.map((pkg) => pkg.name));
    assert.deepEqual(Object.keys(found[0]).sort(), ['directory', 'manifest', 'manifestPath', 'name']);
    assert.equal(found.some((pkg) => pkg.name === '@jinn-network/record-discovery-facts-environments'), false);
    assert.equal(found.some((pkg) => pkg.name === '@jinn-network/core'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the compatibility module exports no physical-root membership authority', () => {
  assert.equal('STACK_ROOTS' in stackPackageGraph, false);
});

test('the real repository set is exactly the catalog-selected platform-v1 group', () => {
  const found = discoverStackPackages(repoRoot);
  const catalogPackages = loadCatalogPackages(repoRoot, { releaseGroup: 'platform-v1' });
  assert.equal(found.length, catalogPackages.length);
  assert.deepEqual(found.map((pkg) => pkg.name), catalogPackages.map((pkg) => pkg.name));
  assert.equal(new Set(found.map((pkg) => pkg.name)).size, found.length, 'package names must be unique');
  assert.equal(found.some((pkg) => pkg.name === '@jinn-network/record-discovery-facts-environments'), false);
});

test('the graph keeps runtime in-set edges, ignores dev-only edges, and drops external edges', () => {
  const packages = [
    { directory: 'packages/trust/core', name: '@jinn-network/trust-core', manifest: { dependencies: { zod: '4.4.3' } } },
    {
      directory: 'packages/trust/resolve',
      name: '@jinn-network/trust-resolve',
      manifest: {
        dependencies: { '@jinn-network/trust-core': '0.1.0', zod: '4.4.3' },
        devDependencies: { '@jinn-network/trust-testing': '0.1.0', vitest: '4.1.8' },
        peerDependencies: { '@jinn-network/trust-peer': '0.1.0', vitest: '^4.1.8' },
        optionalDependencies: { '@jinn-network/trust-optional': '0.1.0' },
      },
    },
    { directory: 'packages/trust/testing', name: '@jinn-network/trust-testing', manifest: { dependencies: { '@jinn-network/trust-core': '0.1.0' } } },
    { directory: 'packages/trust/peer', name: '@jinn-network/trust-peer', manifest: {} },
    { directory: 'packages/trust/optional', name: '@jinn-network/trust-optional', manifest: {} },
  ];
  const graph = buildDependencyGraph(packages);
  assert.deepEqual([...graph.get('@jinn-network/trust-core')], []);
  assert.deepEqual(
    [...graph.get('@jinn-network/trust-resolve')].sort(),
    ['@jinn-network/trust-core', '@jinn-network/trust-optional', '@jinn-network/trust-peer'],
  );
});

test('a self-edge is ignored rather than reported as a cycle', () => {
  const graph = buildDependencyGraph([
    { directory: 'packages/trust/core', name: '@jinn-network/trust-core', manifest: { peerDependencies: { '@jinn-network/trust-core': '0.1.0' } } },
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

test('a dev-only relationship does not create a publication wave', () => {
  const graph = buildDependencyGraph([
    { name: '@jinn-network/a', manifest: { devDependencies: { '@jinn-network/b': '0.1.0' } } },
    { name: '@jinn-network/b', manifest: {} },
  ]);
  assert.deepEqual(topologicalWaves(graph), [['@jinn-network/a', '@jinn-network/b']]);
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

test('the real repository graph is runtime-closed and has deterministic topological waves', () => {
  const packages = discoverStackPackages(repoRoot);
  const names = new Set(packages.map((pkg) => pkg.name));
  const missingRuntimeDependencies = [];
  for (const pkg of packages) {
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(pkg.manifest[section] ?? {})) {
        if (dependency.startsWith('@jinn-network/') && !names.has(dependency)) {
          missingRuntimeDependencies.push(`${pkg.name} -> ${dependency} (${section})`);
        }
      }
    }
  }
  assert.deepEqual(missingRuntimeDependencies, []);

  const graph = buildDependencyGraph(packages);
  const waves = topologicalWaves(graph);
  assert.deepEqual(waves, topologicalWaves(buildDependencyGraph(discoverStackPackages(repoRoot))));
  for (const wave of waves) assert.deepEqual(wave, [...wave].sort());
  const flattened = waves.flat();
  assert.equal(new Set(flattened).size, flattened.length, 'a package must appear in exactly one wave');
  assert.deepEqual(new Set(flattened), names);
  const waveByPackage = new Map(waves.flatMap((wave, index) => wave.map((name) => [name, index])));
  for (const [name, dependencies] of graph) {
    for (const dependency of dependencies) {
      assert.ok(waveByPackage.get(dependency) < waveByPackage.get(name), `${dependency} must precede ${name}`);
    }
  }
});
