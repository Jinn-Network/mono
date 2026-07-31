import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import {
  APPROVED_RUNTIME_DEPENDENCIES,
  APPROVED_RUNTIME_DEV_DEPENDENCIES,
  APPROVED_RUNTIME_RESOLUTIONS,
  DEPENDENCY_SECTIONS,
  compareCodeUnit,
  discoverPluginPackages,
  exactVersionViolations,
  pluginRoot,
  readPackageManifest,
  resolutionViolations,
  root,
  undeclaredDependencies,
  unconsumedApprovedEntries,
  validateExactDependencySections,
} from './plugin-tree-guard-common.mjs';

const packageRoot = pluginRoot;
const NON_NPM_DIRECTORIES = ['frozen', 'adapter-hermes'];

const PLUGIN_PACKAGES = [
  ['runtime', '@jinn-network/plugin-runtime'],
];

const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ['@jinn-network/evidence-repository-ipfs', join(root, 'packages', 'evidence', 'repository-ipfs')],
  ['@jinn-network/evidence-catalog-sqlite', join(root, 'packages', 'evidence', 'catalog-sqlite')],
  ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
  ['@jinn-network/evidence-local-runtime', join(root, 'packages', 'evidence', 'local-runtime')],
  ['@jinn-network/evidence-retrieval', join(root, 'packages', 'evidence', 'retrieval')],
  ['@jinn-network/evidence-derivation', join(root, 'packages', 'evidence', 'derivation')],
  ['@jinn-network/evidence-trajectory', join(root, 'packages', 'evidence', 'trajectory')],
  ['@jinn-network/evidence-trace-decode', join(root, 'packages', 'evidence', 'trace-decode')],
  ['@jinn-network/execution-recorder', join(root, 'packages', 'evidence', 'execution-recorder')],
  ['@jinn-network/record-discovery-protocol', join(root, 'packages', 'discovery', 'protocol')],
  ['@jinn-network/record-discovery-client', join(root, 'packages', 'discovery', 'client')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/trust-resolve', join(root, 'packages', 'trust', 'resolve')],
]);

const JINN_DEPENDENCY_GRAPH = new Map([
  ['runtime', {
    dependencies: [
      '@jinn-network/evidence-catalog-sqlite',
      '@jinn-network/evidence-discovery',
      '@jinn-network/evidence-local-runtime',
      '@jinn-network/evidence-protocol',
      '@jinn-network/evidence-repository',
      '@jinn-network/evidence-retrieval',
      '@jinn-network/evidence-trajectory',
      '@jinn-network/execution-recorder',
      '@jinn-network/record-discovery-client',
      '@jinn-network/record-discovery-protocol',
      '@jinn-network/trust-core',
    ],
    devDependencies: [],
    optionalDependencies: [],
    peerDependencies: [],
  }],
]);

const COMPLETE_RUNTIME_DEPENDENCIES = { ...APPROVED_RUNTIME_DEPENDENCIES };
const COMPLETE_RUNTIME_DEV_DEPENDENCIES = { ...APPROVED_RUNTIME_DEV_DEPENDENCIES };
const COMPLETE_RUNTIME_RESOLUTIONS = { ...APPROVED_RUNTIME_RESOLUTIONS };

function jinnDependencyNames(manifest, section) {
  return Object.keys(manifest[section] ?? {})
    .filter((name) => name.startsWith('@jinn-network/')).sort();
}

function expectedPortal(directory, dependencyName) {
  const inTree = PLUGIN_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the plugin tree inventory is explicit and derives cardinality from shared discovery', () => {
  for (const [directory, expectedName] of PLUGIN_PACKAGES) {
    const manifest = readPackageManifest(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `plugin/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = discoverPluginPackages()
    .map((pkg) => [pkg.directory, pkg.name])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(
    actual,
    [...PLUGIN_PACKAGES].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    'every package.json under plugin/ must be a declared plugin-tree package',
  );
});

test('nested package discovery is visible to the inventory guard', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-nested-inventory-'));
  try {
    const nested = join(tempRoot, 'nested-pkg');
    mkdirSync(join(nested, 'src'), { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({
      name: '@jinn-network/nested-inventory-fixture',
      version: '0.0.0',
    }, null, 2));
    writeFileSync(join(nested, 'src', 'index.ts'), 'export const probe = 1;\n');
    const discovered = discoverPluginPackages({ root: tempRoot })
      .map((pkg) => [pkg.directory, pkg.name])
      .sort(([leftDirectory], [rightDirectory]) =>
        compareCodeUnit(leftDirectory, rightDirectory));
    const declared = [...PLUGIN_PACKAGES].sort(([leftDirectory], [rightDirectory]) =>
      compareCodeUnit(leftDirectory, rightDirectory));
    assert.notDeepEqual(
      discovered,
      declared,
      'undeclared nested package must diverge from declared inventory',
    );
    assert.deepEqual(discovered, [['nested-pkg', '@jinn-network/nested-inventory-fixture']]);
    assert.deepEqual(
      discoverPluginPackages().map((pkg) => [pkg.directory, pkg.name]),
      [...PLUGIN_PACKAGES],
      'live plugin tree must not include ephemeral nested fixtures',
    );
  } finally { rmSync(tempRoot, { recursive: true, force: true }); }
});

test('the inventory guard itself contains no hardcoded package-cardinality assertion', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.doesNotMatch(source, /PLUGIN_PACKAGES\.length\s*,\s*\d+/);
});

test('the Python adapter directories carry no npm manifest', () => {
  for (const directory of NON_NPM_DIRECTORIES) {
    const candidate = join(packageRoot, directory);
    if (!existsSync(candidate)) continue;
    const manifests = discoverPluginPackages()
      .filter((pkg) => pkg.absoluteDirectory.startsWith(candidate))
      .map((pkg) => pkg.manifestPath);
    assert.deepEqual(manifests, []);
  }
});

test('plugin tree Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of PLUGIN_PACKAGES) {
    const manifest = readPackageManifest(directory);
    const approved = JINN_DEPENDENCY_GRAPH.get(directory);
    assert.ok(approved, `missing dependency graph entry for ${directory}`);
    for (const section of DEPENDENCY_SECTIONS) {
      assert.deepEqual(jinnDependencyNames(manifest, section), approved[section],
        `${directory} has unapproved Jinn ${section}`);
    }
    const declared = DEPENDENCY_SECTIONS
      .flatMap((section) => jinnDependencyNames(manifest, section)).sort();
    const resolutions = manifest.resolutions ?? {};
    const resolved = Object.keys(resolutions)
      .filter((name) => name.startsWith('@jinn-network/')).sort();
    assert.deepEqual(resolved, declared, `${directory} has unmatched Jinn resolutions`);
    for (const dependencyName of declared) {
      const siblingVersion = JSON.parse(readFileSync(join(SIBLING_TREE_DIRS.get(dependencyName), 'package.json'), 'utf8')).version;
      assert.equal(manifest.dependencies?.[dependencyName] ?? manifest.devDependencies?.[dependencyName], siblingVersion,
        `${directory} must declare the exact sibling version for ${dependencyName}`);
      assert.equal(resolutions[dependencyName], expectedPortal(directory, dependencyName),
        `${directory} must resolve ${dependencyName} through its matching portal`);
    }
  }
});

test('runtime dependency versions match the approved exact maps', () => {
  const manifest = readPackageManifest('runtime');
  assert.deepEqual(
    exactVersionViolations(manifest, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    [],
  );
  assert.deepEqual(
    exactVersionViolations(manifest, APPROVED_RUNTIME_DEV_DEPENDENCIES, 'devDependencies'),
    [],
  );
  assert.deepEqual(
    undeclaredDependencies(manifest, APPROVED_RUNTIME_DEV_DEPENDENCIES, 'devDependencies'),
    [],
  );
  assert.deepEqual(
    resolutionViolations(manifest, APPROVED_RUNTIME_RESOLUTIONS),
    [],
  );
  assert.deepEqual(
    unconsumedApprovedEntries(manifest, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    [],
  );
  assert.deepEqual(
    unconsumedApprovedEntries(manifest, APPROVED_RUNTIME_DEV_DEPENDENCIES, 'devDependencies'),
    [],
  );
});

test('closed-world dependency and resolution maps reject undeclared and ranged entries', () => {
  assert.deepEqual(
    undeclaredDependencies({ devDependencies: { eslint: '9.0.0' } }, APPROVED_RUNTIME_DEV_DEPENDENCIES, 'devDependencies'),
    ['devDependencies:eslint'],
  );
  assert.deepEqual(
    exactVersionViolations({ devDependencies: { typescript: '^5.9.3' } }, APPROVED_RUNTIME_DEV_DEPENDENCIES, 'devDependencies'),
    ['devDependencies:typescript=^5.9.3'],
  );
  assert.deepEqual(
    resolutionViolations(
      { resolutions: { ...COMPLETE_RUNTIME_RESOLUTIONS, vite: '^6.4.3' } },
      APPROVED_RUNTIME_RESOLUTIONS,
    ),
    ['resolutions:vite=^6.4.3'],
  );
  const { vite: _vite, ...resolutionsWithoutVite } = COMPLETE_RUNTIME_RESOLUTIONS;
  assert.deepEqual(
    resolutionViolations({ resolutions: resolutionsWithoutVite }, APPROVED_RUNTIME_RESOLUTIONS),
    ['resolutions:vite=<missing>'],
  );
  assert.deepEqual(
    unconsumedApprovedEntries(
      { devDependencies: { typescript: '5.9.3' } },
      APPROVED_RUNTIME_DEV_DEPENDENCIES,
      'devDependencies',
    ),
    ['devDependencies:@types/better-sqlite3', 'devDependencies:@types/node', 'devDependencies:vitest'],
  );
});

test('dependency version probes reject wrong external, sibling, and portal forms', () => {
  assert.deepEqual(
    exactVersionViolations({ dependencies: { zod: '^4.4.3' } }, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    ['dependencies:zod=^4.4.3'],
  );
  assert.deepEqual(
    exactVersionViolations({ dependencies: { zod: '4.4.2' } }, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    ['dependencies:zod=4.4.2'],
  );
  assert.deepEqual(
    unconsumedApprovedEntries({ dependencies: {} }, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    Object.keys(APPROVED_RUNTIME_DEPENDENCIES)
      .map((name) => `dependencies:${name}`)
      .sort(compareCodeUnit),
  );
});

test('R-C3-63 rejects duplicate and ranged entries in every dependency section', () => {
  const completeDev = { ...COMPLETE_RUNTIME_DEV_DEPENDENCIES };
  const completeDeps = { ...COMPLETE_RUNTIME_DEPENDENCIES };
  assert.deepEqual(
    validateExactDependencySections({
      dependencies: completeDeps,
      devDependencies: completeDev,
      optionalDependencies: { zod: '4.4.3' },
    }),
    ['optionalDependencies:zod'],
  );
  assert.deepEqual(
    validateExactDependencySections({
      dependencies: completeDeps,
      devDependencies: completeDev,
      peerDependencies: { zod: '^4.4.3' },
    }),
    ['peerDependencies:zod'],
  );
  assert.deepEqual(
    validateExactDependencySections({
      dependencies: { ...completeDeps, zod: '^4.4.3' },
      devDependencies: completeDev,
    }),
    ['dependencies:zod=^4.4.3'],
  );
});

test('every plugin tree package publishes with trusted-publisher provenance', () => {
  for (const [directory] of PLUGIN_PACKAGES) {
    const manifest = readPackageManifest(directory);
    assert.deepEqual(
      manifest.publishConfig,
      { access: 'public', provenance: true },
      `${directory} must publish publicly with provenance (custody law C5)`,
    );
  }
});
