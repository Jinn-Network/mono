import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'task-supply');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

// C6 (curation) appends its row here as it lands.
const TASK_SUPPLY_PACKAGES = [
  ['admission', '@jinn-network/task-admission'],
  ['curation', '@jinn-network/task-curation'],
  ['derivation', '@jinn-network/task-derivation'],
  ['posting', '@jinn-network/task-posting'],
];

// Cross-tree Jinn dependencies live outside packages/task-supply; map name -> absolute dir.
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/environment-record', join(root, 'packages', 'environments', 'record')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/trust-resolve', join(root, 'packages', 'trust', 'resolve')],
  ['@jinn-network/task-execution-backend', join(root, 'packages', 'task-execution', 'backend')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/marketplace-binding', join(root, 'packages', 'marketplace', 'binding')],
]);

// Admission consumes environments/record types + digests and trust-core's DSSE spine, and
// nothing else (design §3.3). Every addition to this graph is a design question first.
const JINN_DEPENDENCY_GRAPH = new Map([
  ['admission', {
    dependencies: ['@jinn-network/environment-record', '@jinn-network/trust-core'],
    devDependencies: [], optionalDependencies: [], peerDependencies: [],
  }],
  // curation is a pure projection over verdict observations (design §9): it derives
  // per-task pass rates and depends on NO Jinn package — an empty graph is the assertion
  // that projection-never-record holds at the dependency layer too.
  ['curation', {
    dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [],
  }],
  // derivation produces sealed Task + EvaluationSpec pairs, so it consumes the packages
  // that OWN those two kinds' sealing (protocol, profiles) alongside the record type (C1)
  // and the admission surface it pipes candidates through (C3). Planning Finding (a): the
  // design's §3.3 diagram omits this tier-3 -> tier-2 edge; the edge is legal and the
  // diagram amendment is proposed at the program review.
  ['derivation', {
    dependencies: [
      '@jinn-network/environment-record',
      '@jinn-network/task-admission',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-protocol',
    ],
    devDependencies: [], optionalDependencies: [], peerDependencies: [],
    // Transitive portals: yarn resolves a portal dependency's OWN dependencies, and neither
    // trust-core (via admission) nor evidence-protocol (via environments/record) is published.
    // Declared here rather than as dependencies because derivation's source imports neither.
    portalResolutions: ['@jinn-network/trust-core', '@jinn-network/evidence-protocol'],
  }],
  // posting is an application over the binding (design §3.3): it consumes the marketplace
  // binding's posting mechanics plus the D7 on-ramp adapters, the protocol package that owns
  // Submission sealing, and derivation for the pool listing type ONLY (finding F-C5-5 — the
  // source-boundary guard asserts that edge is `import type`).
  ['posting', {
    dependencies: [
      '@jinn-network/marketplace-binding',
      '@jinn-network/task-derivation',
      '@jinn-network/task-execution-protocol',
    ],
    // Shadow devDependencies: marketplace-binding's own portal closure needs top-level
    // resolutions in a standalone yarn project (marketplace inventory guard's documented
    // pattern).
    devDependencies: [
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/trust-core',
      '@jinn-network/trust-resolve',
    ],
    optionalDependencies: [], peerDependencies: [],
    // Transitive portals reached through task-derivation (environments/record and its
    // evidence-protocol dependency, plus task-admission). Posting's source imports none of
    // them; yarn still needs the resolution to build the portal graph.
    portalResolutions: [
      '@jinn-network/environment-record',
      '@jinn-network/evidence-protocol',
      '@jinn-network/task-admission',
    ],
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
