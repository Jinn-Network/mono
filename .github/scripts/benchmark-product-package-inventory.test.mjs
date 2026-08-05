// The Benchmark Product's inventory and Jinn-dependency graph.
//
// Same shape as `policy-optimization-package-inventory.test.mjs`: the row list is explicit, the
// cardinality is derived from the live tree, and a package added under
// `packages/benchmark-product/` without a row here fails rather than being silently admitted.
//
// The product is tier 4 (product design §2, program plan §4.1): it lives under the two mechanical
// tier-4 rules (nothing in tiers 1-3 imports it; no tier-1-3 kit, guard, or fixture references it).
// Its consumption contract (product design §3) is REUSE-only, so unlike a tier-1-3 package this
// tree's own approved Jinn dependency graph is a short, deliberately-grown list -- every edge here
// is a decision made once, and the source-boundary guard enforces the same list at the import
// level.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'benchmark-product');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const PRODUCT_PACKAGES = [
  ['core', '@jinn-network/benchmark-product-core'],
];

// The approved runtime graph for the M0 skeleton (BP-01). Product design §3 admits a wider REUSE
// surface eventually; this packet's `core` tree imports exactly one Jinn package
// (`@jinn-network/benchmarking-records`, from `src/platform.ts`) and nothing else runs yet. New
// edges are added deliberately, one PR at a time, in this map and in the source-boundary guard's
// allow-list together.
const JINN_DEPENDENCY_GRAPH = new Map([
  ['core', {
    dependencies: ['@jinn-network/benchmarking-records'],
    devDependencies: [],
    optionalDependencies: [], peerDependencies: [],
    // Portals whose own edges must resolve inside this project. `task-execution-protocol` is not
    // imported here -- the source-boundary guard denies it by name -- but `benchmarking-records`
    // depends on it, and it is not published to a registry, so its portal resolution has to be
    // declared here too or `install` sends it to a version that does not exist.
    portalResolutions: ['@jinn-network/task-execution-protocol'],
  }],
]);

const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/benchmarking-records', join(root, 'packages', 'benchmarking', 'records')],
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

test('the benchmark-product inventory is explicit and derives cardinality from the live tree', () => {
  for (const [directory, expectedName] of PRODUCT_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/benchmark-product/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(packageRoot).flatMap((manifestPath) => {
    const { name } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof name === 'string' && /^@jinn-network\/benchmark-product-/.test(name)
      ? [[relative(packageRoot, dirname(manifestPath)), name]]
      : [];
  }).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(actual, [...PRODUCT_PACKAGES].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  assert.equal(actual.length, PRODUCT_PACKAGES.length);
});

test('the inventory guard itself contains no hardcoded package-cardinality assertion', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.doesNotMatch(source, /PRODUCT_PACKAGES\.length\s*,\s*\d+/);
});

test('benchmark-product Jinn dependencies and portal resolutions match the approved graph', () => {
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
  // publication disabled (`publishPolicy: "never"`). Unlike policy-optimization (public,
  // `publishConfig.access: "restricted"`), this product is `private: true` -- npm refuses to
  // publish it at all. A package that quietly dropped `private` would be the first sign that
  // posture slipped.
  for (const [directory, expectedName] of PRODUCT_PACKAGES) {
    const manifest = readPackage(directory);
    assert.match(manifest.version, /^0\./, `${expectedName} claims a non-experimental version`);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.engines?.node, '>=22');
    assert.equal(manifest.private, true, `${expectedName} must be marked private`);
  }
});

test('no other package in the repository depends on the product', () => {
  // The tier boundary, from the other side (product design §2: "nothing in tiers 1-3 imports it").
  // Stated as a repository-wide sweep rather than as trust in the tier-4 packages' own restraint.
  // Family-wide: any `@jinn-network/benchmark-product-*` name is checked, not only today's row, so
  // a future family package is covered without editing this test.
  const offenders = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const child = join(directory, entry.name);
      const manifestPath = join(child, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.name === 'string' && /^@jinn-network\/benchmark-product-/.test(manifest.name)) {
          walk(child);
          continue;
        }
        for (const section of DEPENDENCY_SECTIONS) {
          for (const name of jinnDependencyNames(manifest, section)) {
            if (/^@jinn-network\/benchmark-product/.test(name)) {
              offenders.push(`${relative(root, child)} (${section}: ${name})`);
            }
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
