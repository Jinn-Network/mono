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
    assert.equal(found.length, 50);
    assert.deepEqual(found.map((pkg) => pkg.name), loadCatalogPackages(root, { releaseGroup: 'platform-v1' }).map((pkg) => pkg.name));
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

test('the real repository set is exactly the canonical 50-package platform-v1 group', () => {
  const found = discoverStackPackages(repoRoot);
  const catalogPackages = loadCatalogPackages(repoRoot, { releaseGroup: 'platform-v1' });
  assert.equal(found.length, 50);
  assert.deepEqual(found.map((pkg) => pkg.name), catalogPackages.map((pkg) => pkg.name));
  assert.equal(new Set(found.map((pkg) => pkg.name)).size, 50, 'package names must be unique');
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

  const waves = topologicalWaves(buildDependencyGraph(discoverStackPackages(repoRoot)));
  assert.deepEqual(waves, [
    [
      '@jinn-network/evidence-protocol',
      '@jinn-network/task-execution-protocol',
      '@jinn-network/trust-core',
    ],
    [
      '@jinn-network/benchmarking-records',
      '@jinn-network/evidence-derivation',
      '@jinn-network/evidence-repository',
      '@jinn-network/evidence-trajectory',
      '@jinn-network/record-discovery-protocol',
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/trust-resolve',
    ],
    [
      '@jinn-network/attestation-issuer',
      '@jinn-network/benchmarking-aggregate',
      '@jinn-network/benchmarking-interop',
      '@jinn-network/benchmarking-run',
      '@jinn-network/benchmarking-testing',
      '@jinn-network/evidence-discovery',
      '@jinn-network/evidence-publication',
      '@jinn-network/evidence-repository-ipfs',
      '@jinn-network/evidence-repository-oci',
      '@jinn-network/evidence-trace-decode',
      '@jinn-network/execution-recorder',
      '@jinn-network/marketplace-binding',
      '@jinn-network/record-discovery-client',
      '@jinn-network/record-discovery-facts-benchmarking',
      '@jinn-network/record-discovery-facts-task-execution',
      '@jinn-network/record-discovery-facts-trust',
      '@jinn-network/record-discovery-serve',
      '@jinn-network/record-discovery-testing',
      '@jinn-network/task-execution-supervisor',
      '@jinn-network/task-execution-workspace',
      '@jinn-network/trust-testing',
    ],
    [
      '@jinn-network/evidence-catalog-sqlite',
      '@jinn-network/evidence-contribution',
      '@jinn-network/evidence-retrieval',
      '@jinn-network/execution-recorder-bridge',
      '@jinn-network/marketplace-projector',
      '@jinn-network/record-discovery-facts-evidence',
      '@jinn-network/record-discovery-source-evidence-journal',
      '@jinn-network/record-discovery-transport-http',
      '@jinn-network/task-execution-launchers',
    ],
    [
      '@jinn-network/benchmarking-marketplace',
      '@jinn-network/evidence-local-runtime',
      '@jinn-network/marketplace-venue-base',
      '@jinn-network/task-execution-backend-local',
      '@jinn-network/task-execution-evaluation-harness',
    ],
    [
      '@jinn-network/marketplace-pipeline',
      '@jinn-network/task-execution-evaluator-adapters',
      '@jinn-network/task-execution-testing',
    ],
    ['@jinn-network/marketplace-testing'],
  ]);
  const flattened = waves.flat();
  assert.equal(new Set(flattened).size, flattened.length, 'a package must appear in exactly one wave');
  assert.equal(flattened.length, 50);
});
