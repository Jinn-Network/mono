import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'benchmarking');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const BENCHMARKING_PACKAGES = [
  ['records', '@jinn-network/benchmarking-records'],
  ['testing', '@jinn-network/benchmarking-testing'],
  ['aggregate', '@jinn-network/benchmarking-aggregate'],
  ['run', '@jinn-network/benchmarking-run'],
  ['publication', '@jinn-network/benchmarking-publication'],
  ['interop', '@jinn-network/benchmarking-interop'],
  ['marketplace', '@jinn-network/benchmarking-marketplace'],
  ['local', '@jinn-network/benchmarking-local'],
];

// Cross-tree Jinn dependencies live outside packages/benchmarking; map name -> absolute dir
// (record-discovery-package-inventory.test.mjs precedent, program §7.8).
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/task-execution-backend', join(root, 'packages', 'task-execution', 'backend')],
  ['@jinn-network/task-execution-testing', join(root, 'packages', 'task-execution', 'testing')],
  ['@jinn-network/task-execution-backend-local', join(root, 'packages', 'task-execution', 'backend-local', 'assembly')],
  ['@jinn-network/task-execution-launchers', join(root, 'packages', 'task-execution', 'backend-local', 'launchers')],
  ['@jinn-network/task-execution-supervisor', join(root, 'packages', 'task-execution', 'backend-local', 'supervisor')],
  ['@jinn-network/task-execution-workspace', join(root, 'packages', 'task-execution', 'backend-local', 'workspace')],
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ['@jinn-network/execution-recorder', join(root, 'packages', 'evidence', 'execution-recorder')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/trust-resolve', join(root, 'packages', 'trust', 'resolve')],
  ['@jinn-network/record-discovery-protocol', join(root, 'packages', 'discovery', 'protocol')],
  ['@jinn-network/record-discovery-serve', join(root, 'packages', 'discovery', 'serve')],
  ['@jinn-network/record-publication', join(root, 'packages', 'discovery', 'publication')],
  ['@jinn-network/marketplace-binding', join(root, 'packages', 'marketplace', 'binding')],
  ['@jinn-network/marketplace-projector', join(root, 'packages', 'marketplace', 'projector')],
  ['@jinn-network/marketplace-testing', join(root, 'packages', 'marketplace', 'testing')],
]);

const JINN_DEPENDENCY_GRAPH = new Map([
  ['records', {
    dependencies: ['@jinn-network/task-execution-protocol', '@jinn-network/trust-core'],
    devDependencies: [], optionalDependencies: [], peerDependencies: [],
  }],
  ['testing', {
    dependencies: [
      '@jinn-network/benchmarking-records',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-protocol',
    ],
    devDependencies: ['@jinn-network/benchmarking-aggregate', '@jinn-network/trust-core'],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['aggregate', {
    dependencies: ['@jinn-network/benchmarking-records', '@jinn-network/trust-core'],
    devDependencies: ['@jinn-network/task-execution-protocol'],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['run', {
    dependencies: [
      '@jinn-network/benchmarking-records',
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-protocol',
    ],
    // task-execution-testing pulls backend-local + evidence contracts for yarn install;
    // production `src/` must still never import them (source-boundaries guard).
    devDependencies: [
      '@jinn-network/benchmarking-testing',
      '@jinn-network/evidence-discovery',
      '@jinn-network/evidence-protocol',
      '@jinn-network/evidence-repository',
      '@jinn-network/execution-recorder',
      '@jinn-network/task-execution-backend-local',
      '@jinn-network/task-execution-launchers',
      '@jinn-network/task-execution-supervisor',
      '@jinn-network/task-execution-testing',
      '@jinn-network/task-execution-workspace',
    ],
    portalResolutions: ['@jinn-network/trust-core'],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['publication', {
    dependencies: [
      '@jinn-network/benchmarking-records',
      '@jinn-network/record-publication',
      '@jinn-network/task-execution-protocol',
    ],
    devDependencies: [],
    portalResolutions: [
      '@jinn-network/record-discovery-protocol',
      '@jinn-network/record-discovery-serve',
      '@jinn-network/trust-core',
    ],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['interop', {
    dependencies: [
      '@jinn-network/benchmarking-records',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-protocol',
    ],
    // testing kit is used only for describeExportConformance in the package test suite.
    devDependencies: ['@jinn-network/benchmarking-testing'],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['marketplace', {
    dependencies: [
      '@jinn-network/benchmarking-records',
      '@jinn-network/benchmarking-run',
      '@jinn-network/marketplace-binding',
      '@jinn-network/marketplace-projector',
      '@jinn-network/task-execution-protocol',
    ],
    devDependencies: [
      '@jinn-network/benchmarking-testing',
      '@jinn-network/task-execution-profiles',
    ],
    portalResolutions: [
      '@jinn-network/record-discovery-protocol',
      '@jinn-network/record-discovery-serve',
      '@jinn-network/task-execution-backend',
      '@jinn-network/trust-core',
      '@jinn-network/trust-resolve',
    ],
    optionalDependencies: [], peerDependencies: [],
  }],
  // local (C4) deliberately declares NO backend and NO evidence dependency: the local venue's
  // admission-check and runtime-observation shapes are mirrored structurally, not imported
  // (policy identity design §2 precedent). task-execution-backend/protocol resolve only so
  // benchmarking-run's own portal graph installs.
  ['local', {
    dependencies: [
      '@jinn-network/benchmarking-records',
      '@jinn-network/benchmarking-run',
    ],
    devDependencies: [
      '@jinn-network/benchmarking-testing',
      '@jinn-network/task-execution-profiles',
    ],
    portalResolutions: [
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-protocol',
    ],
    optionalDependencies: [], peerDependencies: [],
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
  const inTree = BENCHMARKING_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the benchmarking package inventory is explicit and derives cardinality from the live declaration', () => {
  for (const [directory, expectedName] of BENCHMARKING_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/benchmarking/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/benchmarking-/.test(name)
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
  }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...BENCHMARKING_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
  assert.equal(actual.length, BENCHMARKING_PACKAGES.length);
});

test('the inventory guard itself contains no hardcoded package-cardinality assertion', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.doesNotMatch(source, /BENCHMARKING_PACKAGES\.length\s*,\s*\d+/);
});

test('benchmarking package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of BENCHMARKING_PACKAGES) {
    const manifest = readPackage(directory);
    const approved = JINN_DEPENDENCY_GRAPH.get(directory);
    assert.ok(approved, `missing dependency graph entry for ${directory}`);
    for (const section of DEPENDENCY_SECTIONS) {
      assert.deepEqual(jinnDependencyNames(manifest, section), approved[section],
        `${directory} has unapproved Jinn ${section}`);
    }
    const declared = DEPENDENCY_SECTIONS.flatMap((section) => jinnDependencyNames(manifest, section)).sort();
    const portalResolutions = [...(approved.portalResolutions ?? [])].sort();
    const resolutions = manifest.resolutions ?? {};
    const resolved = Object.keys(resolutions).filter((name) => name.startsWith('@jinn-network/')).sort();
    assert.deepEqual(resolved, [...declared, ...portalResolutions].sort(),
      `${directory} has unmatched Jinn resolutions`);
    for (const dependencyName of [...declared, ...portalResolutions]) {
      assert.equal(resolutions[dependencyName], expectedPortal(directory, dependencyName),
        `${directory} must resolve ${dependencyName} through its matching portal`);
    }
  }
});
