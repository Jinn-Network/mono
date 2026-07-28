import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'discovery');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const DISCOVERY_PACKAGES = [
  ['protocol', '@jinn-network/record-discovery-protocol'],
  ['testing', '@jinn-network/record-discovery-testing'],
  ['serve', '@jinn-network/record-discovery-serve'],
  ['client', '@jinn-network/record-discovery-client'],
];

// Cross-tree Jinn dependencies live outside packages/discovery; map name -> absolute dir.
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
]);

const JINN_DEPENDENCY_GRAPH = new Map([
  ['protocol', { dependencies: ['@jinn-network/trust-core'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  // testing's own source only ever imports record-discovery-protocol (plan
  // Task 9: "no cross-tree deps"). trust-core is a *shadow* devDependency +
  // portal resolution -- yarn's per-project resolution step for this
  // standalone project resolves protocol's transitive `trust-core` npm
  // dependency too (no local registry publishes @jinn-network/*), and
  // that requires a matching top-level override here even though testing
  // never imports it (trust-testing's package.json shows the same
  // precedent: every Jinn package anywhere in the graph gets its own
  // resolutions entry). Recorded as a plan/mechanics deviation, not a
  // silent addition.
  ['testing', { dependencies: ['@jinn-network/record-discovery-protocol'], devDependencies: ['@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // serve's own source only ever imports record-discovery-protocol (plan
  // Task 14). It takes record-discovery-testing as a devDependency (M5's
  // conformance-kit-driven tests, `runSourceConformance`) plus the same
  // shadow trust-core devDependency + portal resolution `testing` needed
  // (see the comment above): protocol's transitive `trust-core` npm
  // dependency needs a matching top-level override in every standalone
  // per-package project that portals to protocol, even when serve's own
  // source never imports trust-core directly.
  ['serve', { dependencies: ['@jinn-network/record-discovery-protocol'], devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // client's own source imports protocol + trust-core (plan Task 18: the
  // verification driver wires trust-core key-binding resolution). It
  // declares no facts/* dependency -- the facts leaves are reached only
  // through host-assembled runtime injection (Task 18 note, program §7.13).
  ['client', { dependencies: ['@jinn-network/record-discovery-protocol', '@jinn-network/trust-core'], devDependencies: ['@jinn-network/record-discovery-testing'], optionalDependencies: [], peerDependencies: [] }],
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
  const inTree = DISCOVERY_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the record discovery package inventory is explicit and has one manifest per package', () => {
  assert.equal(DISCOVERY_PACKAGES.length, 4);
  for (const [directory, expectedName] of DISCOVERY_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/discovery/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/record-discovery-/.test(name)
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
    }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...DISCOVERY_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
});

test('record discovery package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of DISCOVERY_PACKAGES) {
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
