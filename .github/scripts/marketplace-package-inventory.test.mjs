import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'marketplace');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const MARKETPLACE_PACKAGES = [
  ['binding', '@jinn-network/marketplace-binding'],
  ['projector', '@jinn-network/marketplace-projector'],
  ['pipeline', '@jinn-network/marketplace-pipeline'],
  ['testing', '@jinn-network/marketplace-testing'],
];

// Cross-tree Jinn dependencies live outside packages/marketplace; map name -> absolute dir
// (record-discovery-package-inventory.test.mjs precedent).
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/task-execution-backend', join(root, 'packages', 'task-execution', 'backend')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/task-execution-testing', join(root, 'packages', 'task-execution', 'testing')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/trust-resolve', join(root, 'packages', 'trust', 'resolve')],
  ['@jinn-network/trust-testing', join(root, 'packages', 'trust', 'testing')],
  ['@jinn-network/record-discovery-protocol', join(root, 'packages', 'discovery', 'protocol')],
  ['@jinn-network/record-discovery-serve', join(root, 'packages', 'discovery', 'serve')],
  ['@jinn-network/record-discovery-testing', join(root, 'packages', 'discovery', 'testing')],
]);

// Approved graph, M0+M1 (plan Milestones M0-M1; scaffold + Attempt-URI agreement only -- no
// binding/projector/pipeline source beyond the seam + sealing utils + attempt-uri + the
// type-only two-party-engagement declaration land yet).
//
// binding and projector/pipeline deliberately do NOT devDep marketplace-testing (a documented
// deviation from the plan's M0.1 Step 1 literal preview): declaring it creates a two-way portal
// cycle (component devDep-> testing prod-dep-> component) that empirically breaks Yarn's
// node-modules linker for standalone portal projects (it refuses to write into a portal
// target's node_modules outside the current project root). The rest of the already-built stack
// follows the same one-directional pattern: task-execution-backend/-profiles and trust-resolve
// do not devDep their sibling testing/kit packages either -- only the testing/kit package
// depends on the components it exercises (see binding/testing READMEs for the full rationale).
//
// pipeline additionally omits @jinn-network/task-execution-backend-local (the plan's literal
// M0.1 preview) because that package does not exist yet in this worktree
// (packages/task-execution/backend-local -- Phase 4, not started). The edge lands at Milestone
// M6 (Phase 6) once the assembly package registers (program §7.6 guard-suite ownership: "...
// extended by every later package registration").
const JINN_DEPENDENCY_GRAPH = new Map([
  ['binding', {
    dependencies: [
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-protocol',
      '@jinn-network/trust-core',
      '@jinn-network/trust-resolve',
    ],
    devDependencies: [],
    optionalDependencies: [],
    peerDependencies: [],
  }],
  ['projector', {
    dependencies: [
      '@jinn-network/marketplace-binding',
      '@jinn-network/record-discovery-protocol',
      '@jinn-network/record-discovery-serve',
      '@jinn-network/task-execution-protocol',
    ],
    // Shadow devDependencies: every Jinn package reachable transitively through a declared
    // dependency needs its own top-level portal resolution in a standalone yarn project (no
    // local registry publishes @jinn-network/* packages) -- record-discovery-serve pulls in
    // record-discovery-testing + trust-core (its own devDependencies), and marketplace-binding
    // pulls in task-execution-backend/-profiles + trust-core/-resolve (its own dependencies).
    devDependencies: [
      '@jinn-network/record-discovery-testing',
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/trust-core',
      '@jinn-network/trust-resolve',
    ],
    optionalDependencies: [],
    peerDependencies: [],
  }],
  ['pipeline', {
    dependencies: [
      '@jinn-network/marketplace-binding',
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-protocol',
    ],
    // Shadow devDependencies pulled in transitively via marketplace-binding's own dependencies.
    devDependencies: [
      '@jinn-network/task-execution-profiles',
      '@jinn-network/trust-core',
      '@jinn-network/trust-resolve',
    ],
    optionalDependencies: [],
    peerDependencies: [],
  }],
  ['testing', {
    dependencies: [
      '@jinn-network/marketplace-binding',
      '@jinn-network/marketplace-projector',
      '@jinn-network/record-discovery-testing',
      '@jinn-network/task-execution-testing',
      '@jinn-network/trust-testing',
    ],
    // Shadow devDependencies: the full transitive closure reachable via the five declared
    // dependencies above (marketplace-binding, marketplace-projector, record-discovery-testing,
    // task-execution-testing, trust-testing).
    devDependencies: [
      '@jinn-network/record-discovery-protocol',
      '@jinn-network/record-discovery-serve',
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-protocol',
      '@jinn-network/trust-core',
      '@jinn-network/trust-resolve',
    ],
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
  const inTree = MARKETPLACE_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the marketplace package inventory is explicit and has four manifests', () => {
  assert.equal(MARKETPLACE_PACKAGES.length, 4);
  for (const [directory, expectedName] of MARKETPLACE_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/marketplace/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/marketplace-/.test(name)
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
    }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...MARKETPLACE_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
});

test('marketplace package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of MARKETPLACE_PACKAGES) {
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
