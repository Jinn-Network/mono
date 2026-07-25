import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const EVIDENCE_PACKAGES = [
  ['evidence-protocol', '@jinn-network/evidence-protocol'],
  ['evidence-repository', '@jinn-network/evidence-repository'],
  ['evidence-repository-oci', '@jinn-network/evidence-repository-oci'],
  ['evidence-discovery', '@jinn-network/evidence-discovery'],
  ['evidence-catalog-sqlite', '@jinn-network/evidence-catalog-sqlite'],
  ['execution-recorder', '@jinn-network/execution-recorder'],
  ['attestation-issuer', '@jinn-network/attestation-issuer'],
  ['evidence-local-runtime', '@jinn-network/evidence-local-runtime'],
];

const JINN_DEPENDENCY_GRAPH = new Map([
  ['evidence-protocol', { dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['evidence-repository', { dependencies: ['@jinn-network/evidence-protocol'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['evidence-repository-oci', { dependencies: ['@jinn-network/evidence-repository'], devDependencies: ['@jinn-network/evidence-protocol'], optionalDependencies: [], peerDependencies: [] }],
  ['evidence-discovery', { dependencies: ['@jinn-network/evidence-protocol', '@jinn-network/evidence-repository'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['evidence-catalog-sqlite', { dependencies: ['@jinn-network/evidence-discovery', '@jinn-network/evidence-repository'], devDependencies: ['@jinn-network/evidence-protocol'], optionalDependencies: [], peerDependencies: [] }],
  ['execution-recorder', { dependencies: ['@jinn-network/evidence-protocol', '@jinn-network/evidence-repository'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['attestation-issuer', { dependencies: ['@jinn-network/evidence-protocol', '@jinn-network/evidence-repository'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['evidence-local-runtime', { dependencies: ['@jinn-network/evidence-catalog-sqlite', '@jinn-network/evidence-discovery', '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository'], devDependencies: ['@jinn-network/execution-recorder'], optionalDependencies: [], peerDependencies: [] }],
]);

function readPackage(directory) {
  const packageJson = join(packageRoot, directory, 'package.json');
  assert.ok(existsSync(packageJson), `missing package manifest: ${packageJson}`);
  return JSON.parse(readFileSync(packageJson, 'utf8'));
}

function jinnDependencyNames(manifest, section) {
  return Object.keys(manifest[section] ?? {})
    .filter((name) => name.startsWith('@jinn-network/')).sort();
}

function expectedPortal(directory, dependencyName) {
  const target = EVIDENCE_PACKAGES.find(([, name]) => name === dependencyName);
  assert.ok(target, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), join(packageRoot, target[0])) || '.'}`;
}

test('the evidence package inventory is explicit and has eight manifests', () => {
  assert.equal(EVIDENCE_PACKAGES.length, 8);
  for (const [directory, expectedName] of EVIDENCE_PACKAGES) {
    assert.equal(readPackage(directory).name, expectedName);
  }
  const actual = readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packageJson = join(packageRoot, entry.name, 'package.json');
      if (!existsSync(packageJson)) return [];
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/evidence-/.test(name)
        || name === '@jinn-network/execution-recorder'
        || name === '@jinn-network/attestation-issuer' ? [[entry.name, name]] : [];
    }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...EVIDENCE_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
});

test('evidence package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of EVIDENCE_PACKAGES) {
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
