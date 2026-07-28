import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'trust');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const TRUST_PACKAGES = [
  ['core', '@jinn-network/trust-core'],
];

const JINN_DEPENDENCY_GRAPH = new Map([
  ['core', { dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
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
  const target = TRUST_PACKAGES.find(([, name]) => name === dependencyName);
  assert.ok(target, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), join(packageRoot, target[0])) || '.'}`;
}

test('the trust package inventory is explicit and has one manifest', () => {
  assert.equal(TRUST_PACKAGES.length, 1);
  for (const [directory, expectedName] of TRUST_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/trust/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/trust-/.test(name)
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
    }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...TRUST_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
});

test('trust package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of TRUST_PACKAGES) {
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
