import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'task-supply');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

// C4 (derivation), C5 (posting), and C6 (curation) append their rows here as they land.
const TASK_SUPPLY_PACKAGES = [
  ['admission', '@jinn-network/task-admission'],
];

// Cross-tree Jinn dependencies live outside packages/task-supply; map name -> absolute dir.
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/environment-record', join(root, 'packages', 'environments', 'record')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
]);

// Admission consumes environments/record types + digests and trust-core's DSSE spine, and
// nothing else (design §3.3). Every addition to this graph is a design question first.
const JINN_DEPENDENCY_GRAPH = new Map([
  ['admission', {
    dependencies: ['@jinn-network/environment-record', '@jinn-network/trust-core'],
    devDependencies: [], optionalDependencies: [], peerDependencies: [],
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
  const inTree = TASK_SUPPLY_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the task-supply package inventory is explicit and derives cardinality from the live declaration', () => {
  for (const [directory, expectedName] of TASK_SUPPLY_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/task-supply/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/task-(admission|derivation|posting|curation)$/.test(name)
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
    }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...TASK_SUPPLY_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
  assert.equal(actual.length, TASK_SUPPLY_PACKAGES.length);
});

test('the inventory guard itself contains no hardcoded package-cardinality assertion', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.doesNotMatch(source, /TASK_SUPPLY_PACKAGES\.length\s*,\s*\d+/);
});

test('task-supply package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of TASK_SUPPLY_PACKAGES) {
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
