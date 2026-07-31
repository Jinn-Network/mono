import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'environments');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const ENVIRONMENT_PACKAGES = [
  ['record', '@jinn-network/environment-record'],
  ['verification', '@jinn-network/environment-verification'],
];

// Cross-tree Jinn dependencies live outside packages/environments; map name -> absolute dir
// (benchmarking-package-inventory.test.mjs precedent).
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/trust-resolve', join(root, 'packages', 'trust', 'resolve')],
  ['@jinn-network/trust-testing', join(root, 'packages', 'trust', 'testing')],
]);

const JINN_DEPENDENCY_GRAPH = new Map([
  // `record` is tier 2 and depends on NO Jinn package at runtime (design §3.3: zod +
  // noble-class primitives only). evidence-protocol is a *test-only* devDependency: the
  // cross-package seal-equivalence fixtures (program §5 contract 3) compare this package's
  // locally re-implemented digest against the evidence tree's `recordDigest`. Production
  // source never imports it; the source-boundary guard enforces that separately.
  ['record', {
    dependencies: [],
    devDependencies: ['@jinn-network/evidence-protocol'],
    optionalDependencies: [],
    peerDependencies: [],
  }],
  // `verification` is tier 3 and takes exactly the two package edges design §3.3 gives it:
  // the record kind it verifies, and trust/core for DSSE + JCS + hashing. `trust-testing` is
  // a test-only devDependency: the conformance kit signs with real deterministic keys.
  // (This map records Jinn dependencies only; `vitest` is an optional peer, asserted below.)
  ['verification', {
    dependencies: [
      '@jinn-network/environment-record',
      '@jinn-network/trust-core',
    ],
    // `trust-resolve` is install-graph only: `trust-testing` is portal-consumed, and a
    // portal's own resolutions do not apply, so its Jinn dependency must be resolved here.
    // The source-boundary guard bans importing it from anywhere in this package.
    devDependencies: ['@jinn-network/trust-resolve', '@jinn-network/trust-testing'],
    optionalDependencies: [],
    peerDependencies: [],
  }],
]);

function readPackage(directory) {
  const packageJson = join(packageRoot, directory, 'package.json');
  assert.ok(existsSync(packageJson), `missing package manifest: ${packageJson}`);
  return JSON.parse(readFileSync(packageJson, 'utf8'));
}

function packageManifests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === 'node_modules') return [];
    const child = join(directory, entry.name);
    const packageJson = join(child, 'package.json');
    return [
      ...(existsSync(packageJson) ? [packageJson] : []),
      ...packageManifests(child),
    ];
  });
}

function jinnDependencyNames(manifest, section) {
  return Object.keys(manifest[section] ?? {})
    .filter((name) => name.startsWith('@jinn-network/')).sort();
}

function expectedPortal(directory, dependencyName) {
  const inTree = ENVIRONMENT_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the environments package inventory is explicit and has one manifest per package', () => {
  assert.equal(ENVIRONMENT_PACKAGES.length, JINN_DEPENDENCY_GRAPH.size);
  for (const [directory, expectedName] of ENVIRONMENT_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/environments/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages', 'environments'))
    .map((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return [relative(packageRoot, dirname(packageJson)), name];
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(
    actual,
    [...ENVIRONMENT_PACKAGES].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
});

test('environments package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of ENVIRONMENT_PACKAGES) {
    const manifest = readPackage(directory);
    const approved = JINN_DEPENDENCY_GRAPH.get(directory);
    assert.ok(approved, `missing dependency graph entry for ${directory}`);
    for (const section of DEPENDENCY_SECTIONS) {
      assert.deepEqual(jinnDependencyNames(manifest, section), approved[section],
        `${directory} has unapproved Jinn ${section}`);
    }
    const declared = DEPENDENCY_SECTIONS.flatMap((section) => jinnDependencyNames(manifest, section)).sort();
    const resolutions = manifest.resolutions ?? {};
    const resolved = Object.keys(resolutions).filter((name) => name.startsWith('@jinn-network/')).sort();
    assert.deepEqual(resolved, declared, `${directory} has unmatched Jinn resolutions`);
    for (const dependencyName of declared) {
      assert.equal(resolutions[dependencyName], expectedPortal(directory, dependencyName),
        `${directory} must resolve ${dependencyName} through its matching portal`);
    }
  }
});

test('every environments package declares Vitest as an exact optional peer where it ships a kit', () => {
  const expectedExports = new Map([
    ['record', ['.', './fixtures/*', './schemas/*', './testing']],
    ['verification', ['.', './fixtures/*', './testing']],
  ]);
  assert.equal(expectedExports.size, ENVIRONMENT_PACKAGES.length);
  for (const [directory] of ENVIRONMENT_PACKAGES) {
    const manifest = readPackage(directory);
    assert.deepEqual(Object.keys(manifest.exports).sort(), expectedExports.get(directory),
      `${directory} has an unapproved export map`);
    assert.equal(manifest.peerDependencies?.vitest, '^4.1.8');
    assert.deepEqual(manifest.peerDependenciesMeta, { vitest: { optional: true } });
  }
});
