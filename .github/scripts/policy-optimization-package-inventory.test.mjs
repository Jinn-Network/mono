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

// The approved runtime graph for sub-unit C7a (the campaign document + journal).
//
// - `policy-identity` supplies canonicalization, digests, tuple validation, and manifest parsing.
//   The campaign's `frozenAxes` are compared byte-for-byte against execution-policy tuples, so a
//   second canonicalizer here would be a second answer to "are these the same bytes".
// - `benchmarking-records` supplies the committed-benchmark machinery the `DRAFT -> EXPLORING`
//   gate runs on (§6.3) and the calendar-strict RFC 3339 comparison the journal orders by.
//
// Later sub-units add `benchmarking-run`, `benchmarking-local`, `benchmarking-aggregate`, and
// `policy-outcomes`. Each addition edits this map in the PR that needs it, so the graph is never
// wider than the code.
const JINN_DEPENDENCY_GRAPH = new Map([
  ['.', {
    dependencies: [
      '@jinn-network/benchmarking-records',
      '@jinn-network/policy-identity',
    ],
    devDependencies: [], optionalDependencies: [], peerDependencies: [],
    // `benchmarking-records` is itself a portal whose own runtime edge to
    // `task-execution-protocol` must resolve inside this project; it is a transitive resolution,
    // never an import of this package's own (the source-boundary guard bans importing it).
    portalResolutions: ['@jinn-network/task-execution-protocol'],
  }],
]);

const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/benchmarking-records', join(root, 'packages', 'benchmarking', 'records')],
  ['@jinn-network/policy-identity', join(root, 'packages', 'policy', 'identity')],
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
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
