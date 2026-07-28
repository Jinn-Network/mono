import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'evidence');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const EVIDENCE_PACKAGES = [
  ['protocol', '@jinn-network/evidence-protocol'],
  ['repository', '@jinn-network/evidence-repository'],
  ['repository-oci', '@jinn-network/evidence-repository-oci'],
  ['repository-ipfs', '@jinn-network/evidence-repository-ipfs'],
  ['discovery', '@jinn-network/evidence-discovery'],
  ['catalog-sqlite', '@jinn-network/evidence-catalog-sqlite'],
  ['execution-recorder', '@jinn-network/execution-recorder'],
  ['attestation-issuer', '@jinn-network/attestation-issuer'],
  ['derivation', '@jinn-network/evidence-derivation'],
  ['publication', '@jinn-network/evidence-publication'],
  ['local-runtime', '@jinn-network/evidence-local-runtime'],
  ['execution-recorder-bridge', '@jinn-network/execution-recorder-bridge'],
  ['retrieval', '@jinn-network/evidence-retrieval'],
  ['contribution', '@jinn-network/evidence-contribution'],
];

const JINN_DEPENDENCY_GRAPH = new Map([
  ['protocol', { dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['repository', { dependencies: ['@jinn-network/evidence-protocol'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['repository-oci', { dependencies: ['@jinn-network/evidence-repository'], devDependencies: ['@jinn-network/evidence-protocol'], optionalDependencies: [], peerDependencies: [] }],
  ['repository-ipfs', { dependencies: ['@jinn-network/evidence-repository'], devDependencies: ['@jinn-network/evidence-protocol'], optionalDependencies: [], peerDependencies: [] }],
  ['discovery', { dependencies: ['@jinn-network/evidence-protocol', '@jinn-network/evidence-repository'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['catalog-sqlite', { dependencies: ['@jinn-network/evidence-discovery', '@jinn-network/evidence-repository'], devDependencies: ['@jinn-network/evidence-protocol'], optionalDependencies: [], peerDependencies: [] }],
  ['execution-recorder', { dependencies: ['@jinn-network/evidence-protocol', '@jinn-network/evidence-repository'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['attestation-issuer', { dependencies: ['@jinn-network/evidence-protocol', '@jinn-network/evidence-repository'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['derivation', { dependencies: ['@jinn-network/evidence-protocol'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['publication', { dependencies: ['@jinn-network/evidence-repository'], devDependencies: ['@jinn-network/evidence-protocol'], optionalDependencies: [], peerDependencies: [] }],
  ['local-runtime', { dependencies: ['@jinn-network/evidence-catalog-sqlite', '@jinn-network/evidence-discovery', '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository'], devDependencies: ['@jinn-network/execution-recorder'], optionalDependencies: [], peerDependencies: [] }],
  ['execution-recorder-bridge', { dependencies: ['@jinn-network/evidence-repository', '@jinn-network/execution-recorder'], devDependencies: ['@jinn-network/evidence-protocol'], optionalDependencies: [], peerDependencies: [] }],
  ['retrieval', {
    dependencies: [
      '@jinn-network/evidence-discovery',
      '@jinn-network/evidence-protocol',
      '@jinn-network/evidence-repository',
    ],
    devDependencies: [],
    optionalDependencies: [],
    peerDependencies: [],
  }],
  ['contribution', {
    dependencies: [
      '@jinn-network/evidence-derivation',
      '@jinn-network/evidence-protocol',
      '@jinn-network/evidence-publication',
      '@jinn-network/evidence-repository',
    ],
    devDependencies: [],
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
  const target = EVIDENCE_PACKAGES.find(([, name]) => name === dependencyName);
  assert.ok(target, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), join(packageRoot, target[0])) || '.'}`;
}

test('the evidence package inventory is explicit and has fourteen manifests', () => {
  assert.equal(EVIDENCE_PACKAGES.length, 14);
  for (const [directory, expectedName] of EVIDENCE_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/evidence/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/evidence-/.test(name)
        || name === '@jinn-network/execution-recorder'
        || name === '@jinn-network/attestation-issuer'
        || name === '@jinn-network/execution-recorder-bridge'
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
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

test('testing entrypoints declare Vitest as an exact optional peer', () => {
  for (const directory of ['derivation', 'retrieval']) {
    const manifest = readPackage(directory);
    assert.deepEqual(manifest.peerDependencies, { vitest: '^4.1.8' });
    assert.deepEqual(manifest.peerDependenciesMeta, {
      vitest: { optional: true },
    });
  }
});
