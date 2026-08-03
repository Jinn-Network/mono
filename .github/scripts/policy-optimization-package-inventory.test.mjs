// The Policy Optimization product's inventory and Jinn-dependency graph.
//
// Same shape as `policy-package-inventory.test.mjs`: the row list is explicit, the cardinality is
// derived from the live tree, and a package added under `packages/policy-optimization/` without a
// row here fails rather than being silently admitted.
//
// The product is tier 4 (product design §2), so unlike the policy tree it MAY depend on anything.
// "May" is not "does": every runtime edge is a design question answered once, here, and the
// source-boundary guard enforces the same list at the import level.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'policy-optimization');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const PRODUCT_PACKAGES = [
  ['.', '@jinn-network/policy-optimization'],
];

// The approved runtime graph for sub-units C7a (the campaign document + journal) and C7b (the wave
// engine).
//
// - `policy-identity` supplies canonicalization, digests, tuple validation, manifest parsing, and
//   the §4.1 expression rule that turns a candidate's tuple into a Run arm's pinning. The
//   campaign's `frozenAxes` are compared byte-for-byte against execution-policy tuples, so a
//   second canonicalizer here would be a second answer to "are these the same bytes".
// - `benchmarking-records` supplies the committed-benchmark machinery the `DRAFT -> EXPLORING`
//   gate runs on (§6.3), the calendar-strict RFC 3339 comparison the journal orders by, and the
//   Benchmark/Run/Matrix/Report records a wave is made of.
// - `benchmarking-run` plans, launches, and assembles; `benchmarking-local` supplies the local
//   venue's port bundle and the treatment-fidelity bridge; `benchmarking-aggregate` owns every
//   statistic (program ruling R3). C7b composes all three and re-implements none of them.
// - `task-execution-backend` is the **contract** the injected backend satisfies — a type, never a
//   binding. `task-execution-testing` is dev-only: the conformance kit's in-memory fake.
//
// `policy-outcomes` is added by sub-unit C8 (the two observation adapters, program §1 C8):
// the policy-outcomes adapter's output type (`PolicyOutcomeObservation`/`PolicyOutcomeInputRef`/
// `PerAxisStatus`) is imported directly rather than mirrored, unlike the discovery/marketplace/
// task-supply shapes those adapters otherwise mirror (source-boundary guard denies those three
// trees outright). Each addition edits this map in the PR that needs it, so the graph is never
// wider than the code.
const JINN_DEPENDENCY_GRAPH = new Map([
  ['.', {
    dependencies: [
      '@jinn-network/benchmarking-aggregate',
      '@jinn-network/benchmarking-local',
      '@jinn-network/benchmarking-records',
      '@jinn-network/benchmarking-run',
      '@jinn-network/policy-identity',
      '@jinn-network/policy-outcomes',
      '@jinn-network/task-execution-backend',
    ],
    devDependencies: ['@jinn-network/task-execution-testing'],
    optionalDependencies: [], peerDependencies: [],
    // Portals whose own edges must resolve inside this project. None of these is imported here --
    // the source-boundary guard denies every one of them by name -- but a `portal:` dependency
    // brings its own dependency graph, and an unresolved transitive Jinn package sends `install`
    // to a registry version that does not exist.
    //
    // The tail of this list is FINDING F-C7b-4: `task-execution-testing` carries the local
    // backend's conformance slice as *runtime* dependencies, so consuming the in-memory fake drags
    // the assembly/launchers/supervisor/workspace packages and their evidence edges into a tier-4
    // product's install graph. `benchmarking-run` takes the same medicine for the same reason.
    portalResolutions: [
      '@jinn-network/evidence-discovery',
      '@jinn-network/evidence-protocol',
      '@jinn-network/evidence-repository',
      '@jinn-network/execution-recorder',
      '@jinn-network/task-execution-backend-local',
      '@jinn-network/task-execution-launchers',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-protocol',
      '@jinn-network/task-execution-supervisor',
      '@jinn-network/task-execution-workspace',
      '@jinn-network/trust-core',
    ],
  }],
]);

const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/benchmarking-aggregate', join(root, 'packages', 'benchmarking', 'aggregate')],
  ['@jinn-network/benchmarking-local', join(root, 'packages', 'benchmarking', 'local')],
  ['@jinn-network/benchmarking-records', join(root, 'packages', 'benchmarking', 'records')],
  ['@jinn-network/benchmarking-run', join(root, 'packages', 'benchmarking', 'run')],
  ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ['@jinn-network/execution-recorder', join(root, 'packages', 'evidence', 'execution-recorder')],
  ['@jinn-network/policy-identity', join(root, 'packages', 'policy', 'identity')],
  ['@jinn-network/policy-outcomes', join(root, 'packages', 'policy', 'outcomes')],
  ['@jinn-network/task-execution-backend', join(root, 'packages', 'task-execution', 'backend')],
  ['@jinn-network/task-execution-backend-local', join(root, 'packages', 'task-execution', 'backend-local', 'assembly')],
  ['@jinn-network/task-execution-launchers', join(root, 'packages', 'task-execution', 'backend-local', 'launchers')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/task-execution-supervisor', join(root, 'packages', 'task-execution', 'backend-local', 'supervisor')],
  ['@jinn-network/task-execution-testing', join(root, 'packages', 'task-execution', 'testing')],
  ['@jinn-network/task-execution-workspace', join(root, 'packages', 'task-execution', 'backend-local', 'workspace')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
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
  const inTree = PRODUCT_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the policy-optimization inventory is explicit and derives cardinality from the live tree', () => {
  for (const [directory, expectedName] of PRODUCT_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      directory === '.' ? 'packages/policy-optimization' : `packages/policy-optimization/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const packageJson = join(packageRoot, 'package.json');
  const actual = [
    ...(existsSync(packageJson) ? [packageJson] : []),
    ...packageManifests(packageRoot),
  ].flatMap((manifestPath) => {
    const { name } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof name === 'string' && name.startsWith('@jinn-network/policy-optimization')
      ? [[relative(packageRoot, dirname(manifestPath)) || '.', name]]
      : [];
  }).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(actual, [...PRODUCT_PACKAGES].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  assert.equal(actual.length, PRODUCT_PACKAGES.length);
});

test('the inventory guard itself contains no hardcoded package-cardinality assertion', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.doesNotMatch(source, /PRODUCT_PACKAGES\.length\s*,\s*\d+/);
});

test('policy-optimization Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of PRODUCT_PACKAGES) {
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

test('the product never publishes', () => {
  // Product design §2: classification `product`, release group `transitional-or-private`,
  // publication disabled. A package that quietly acquires a stable version or a public access
  // posture would be the first sign that posture slipped.
  for (const [directory, expectedName] of PRODUCT_PACKAGES) {
    const manifest = readPackage(directory);
    assert.match(manifest.version, /^0\./, `${expectedName} claims a non-experimental version`);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.engines?.node, '>=22');
    assert.equal(manifest.publishConfig?.access, 'restricted',
      `${expectedName} must not declare public publication access`);
  }
});

test('no other package in the repository depends on the product', () => {
  // The tier boundary, from the other side (product design §2: "nothing in tiers 1-3 may reference
  // it, and no tier-1-3 kit, guard, or fixture does"). Stated as a repository-wide sweep rather
  // than as trust in the tier-4 packages' own restraint.
  const offenders = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const child = join(directory, entry.name);
      const manifestPath = join(child, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.name === '@jinn-network/policy-optimization') { walk(child); continue; }
        for (const section of DEPENDENCY_SECTIONS) {
          if (Object.hasOwn(manifest[section] ?? {}, '@jinn-network/policy-optimization')) {
            offenders.push(`${relative(root, child)} (${section})`);
          }
        }
      }
      walk(child);
    }
  };
  walk(join(root, 'packages'));
  for (const adjacent of ['client', 'apps', 'plugin', 'scripts']) {
    const directory = join(root, adjacent);
    if (existsSync(directory)) walk(directory);
  }
  assert.deepEqual(offenders.sort(), [], 'a package depends on the tier-4 product');
});
