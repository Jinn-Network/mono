import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'plugin');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

// The tier-4 product tree (plugin reconciliation design §6.1, program §4). Every npm
// package under plugin/ is declared here; the discovery test below proves the list is
// complete rather than trusting it.
const PLUGIN_PACKAGES = [
  ['runtime', '@jinn-network/plugin-runtime'],
];

// Directories inside plugin/ that are deliberately NOT npm packages:
//   frozen         — C0's relocated Hermes adapter (Python; frozen per spec §4.1)
//   adapter-hermes — C7's clean-slate Hermes adapter (Python; mirrored, never published)
// Both are asserted manifest-free rather than listed above. Absence is fine: this guard
// must pass whether or not C0 or C7 has landed.
const NON_NPM_DIRECTORIES = ['frozen', 'adapter-hermes'];

// Cross-tree Jinn dependencies live outside plugin/; map name -> absolute directory so a
// later component adding one only adds its JINN_DEPENDENCY_GRAPH row
// (benchmarking-package-inventory.test.mjs precedent). Pre-seeded with the whole
// composition table of design §6.1 plus the two packages C1 and C2 commission — an entry
// here grants nothing on its own; the graph is what admits a dependency.
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ['@jinn-network/evidence-repository-ipfs', join(root, 'packages', 'evidence', 'repository-ipfs')],
  ['@jinn-network/evidence-catalog-sqlite', join(root, 'packages', 'evidence', 'catalog-sqlite')],
  // Local Runtime re-exports `EvidenceCatalogReader` only as a type
  // (packages/evidence/local-runtime/src/types.ts:4), and it is declared in Discovery
  // (packages/evidence/discovery/src/catalog/types.ts). Any consumer of
  // `LocalEvidenceRuntime.catalog` needs Discovery resolvable for tsc.
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

// C3 wires no capability, so the runtime declares no Jinn dependency yet. C4/C5/C6/C7
// each add their row here together with a matching portal: resolution.
const JINN_DEPENDENCY_GRAPH = new Map([
  ['runtime', {
    dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [],
  }],
]);

function readPackage(directory) {
  const packageJson = join(packageRoot, directory, 'package.json');
  assert.ok(existsSync(packageJson), `missing package manifest: ${packageJson}`);
  return JSON.parse(readFileSync(packageJson, 'utf8'));
}

function packageManifests(directory) {
  if (!existsSync(directory)) return [];
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
  const inTree = PLUGIN_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the plugin tree inventory is explicit and derives cardinality from the live declaration', () => {
  for (const [directory, expectedName] of PLUGIN_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `plugin/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(packageRoot)
    .map((packageJson) => [
      relative(packageRoot, dirname(packageJson)),
      JSON.parse(readFileSync(packageJson, 'utf8')).name,
    ])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(
    actual,
    [...PLUGIN_PACKAGES].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    'every package.json under plugin/ must be a declared plugin-tree package',
  );
});

test('the inventory guard itself contains no hardcoded package-cardinality assertion', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.doesNotMatch(source, /PLUGIN_PACKAGES\.length\s*,\s*\d+/);
});

test('the Python adapter directories carry no npm manifest', () => {
  for (const directory of NON_NPM_DIRECTORIES) {
    const candidate = join(packageRoot, directory);
    if (!existsSync(candidate)) continue;
    assert.deepEqual(
      packageManifests(candidate).map((path) => relative(root, path)),
      [],
      `plugin/${directory} is a Python directory (C0 frozen adapter / C7 clean-slate adapter); `
        + 'it is mirrored, never npm-published, and must not grow a package manifest',
    );
  }
});

test('plugin tree Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of PLUGIN_PACKAGES) {
    const manifest = readPackage(directory);
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
      assert.equal(resolutions[dependencyName], expectedPortal(directory, dependencyName),
        `${directory} must resolve ${dependencyName} through its matching portal`);
    }
  }
});

test('every plugin tree package publishes with trusted-publisher provenance', () => {
  for (const [directory] of PLUGIN_PACKAGES) {
    const manifest = readPackage(directory);
    assert.deepEqual(
      manifest.publishConfig,
      { access: 'public', provenance: true },
      `${directory} must publish publicly with provenance (custody law C5)`,
    );
  }
});
