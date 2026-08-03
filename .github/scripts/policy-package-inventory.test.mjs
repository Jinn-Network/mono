// The policy tree's inventory and Jinn-dependency graph.
//
// Same shape as `task-supply-package-inventory.test.mjs`: the row list is explicit, the
// cardinality is derived from the live tree, and a package added under `packages/policy/` without
// a row here fails rather than being silently admitted.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'policy');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

// C2 (`@jinn-network/policy-outcomes`) appends its row here as it lands.
const POLICY_PACKAGES = [
  ['identity', '@jinn-network/policy-identity'],
];

// Substrate §2: both policy packages are pure and depend on protocol/record layers only, and
// `identity` in fact depends on NO Jinn package — the requirements-merge semantics are
// reproduced in-package (`src/merge.ts`, pinned against drift by
// `policy-identity-guards.test.mjs`) and the evidence-retrieval envelope shapes are mirrored,
// never imported. An empty graph is the assertion that "pure substrate" holds at the dependency
// layer too. C2's `outcomes` will carry exactly one edge, to `identity`.
const JINN_DEPENDENCY_GRAPH = new Map([
  ['identity', {
    dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [],
  }],
]);

// Cross-tree Jinn dependencies would live outside packages/policy; map name -> absolute dir.
// Empty today, and deliberately so: every addition is a design question first.
const SIBLING_TREE_DIRS = new Map([]);

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
  const inTree = POLICY_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the policy package inventory is explicit and derives cardinality from the live declaration', () => {
  for (const [directory, expectedName] of POLICY_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/policy/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/policy-(identity|outcomes)$/.test(name)
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
    }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...POLICY_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
  assert.equal(actual.length, POLICY_PACKAGES.length);
});

test('the inventory guard itself contains no hardcoded package-cardinality assertion', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.doesNotMatch(source, /POLICY_PACKAGES\.length\s*,\s*\d+/);
});

test('policy package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of POLICY_PACKAGES) {
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

test('every policy package publishes through the disabled-publication posture', () => {
  // The `experimental-policy` release group is publication-disabled (substrate §2/§10). A package
  // that quietly acquires a stable version or drops `publishConfig` would be the first sign that
  // posture slipped.
  for (const [directory, expectedName] of POLICY_PACKAGES) {
    const manifest = readPackage(directory);
    assert.match(manifest.version, /^0\./, `${expectedName} claims a non-experimental version`);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.engines?.node, '>=22');
  }
});
