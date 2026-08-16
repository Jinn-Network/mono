// The Colophon claims product inventory and its deliberately narrow package graph.
//
// Colophon is a Tier 4 product identity.  The platform packages it consumes remain
// @jinn-network packages; no Tier 1-3 package may adopt this product namespace.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = join(root, 'packages', 'benchmark-product');
const architectureCatalogPath = join(root, 'architecture', 'platform-packages.v1.json');
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const COLOPHON_SCOPE = '@colophon-claims/';

const PRODUCT_PACKAGES = [
  ['core', '@colophon-claims/core', 'public'],
  ['cli', '@colophon-claims/cli', 'public'],
  ['verify', '@colophon-claims/verify', 'public'],
  ['web', '@colophon-claims/web', 'private'],
];
const PACKAGE_VERSIONS = new Map([
  ['@colophon-claims/core', '1.0.0'],
  ['@colophon-claims/cli', '1.0.0'],
  ['@colophon-claims/verify', '2.0.0'],
  ['@colophon-claims/web', '0.1.0'],
]);

const CORE_JINN = [
  '@jinn-network/attestation-issuer', '@jinn-network/benchmarking-aggregate',
  '@jinn-network/benchmarking-interop', '@jinn-network/benchmarking-local',
  '@jinn-network/benchmarking-publication', '@jinn-network/benchmarking-records', '@jinn-network/benchmarking-run',
  '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-transport-http', '@jinn-network/record-publication',
  '@jinn-network/task-admission', '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-backend-local', '@jinn-network/task-execution-evaluation-harness',
  '@jinn-network/task-execution-evaluator-adapters', '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-oci-grader', '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-workspace', '@jinn-network/trust-core',
];
const VERIFY_JINN = [
  '@jinn-network/benchmarking-aggregate', '@jinn-network/benchmarking-interop',
  '@jinn-network/benchmarking-local', '@jinn-network/benchmarking-records',
  '@jinn-network/benchmarking-run', '@jinn-network/task-admission',
  '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol',
  '@jinn-network/trust-core',
];
const TRANSITIVE_PORTALS = [
  '@jinn-network/attestation-issuer', '@jinn-network/benchmarking-aggregate',
  '@jinn-network/benchmarking-interop', '@jinn-network/benchmarking-local',
  '@jinn-network/benchmarking-records', '@jinn-network/benchmarking-run',
  '@jinn-network/environment-record', '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
  '@jinn-network/execution-recorder', '@jinn-network/task-admission',
  '@jinn-network/task-execution-backend', '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-evaluation-harness', '@jinn-network/task-execution-evaluator-adapters',
  '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-oci-grader',
  '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
  '@jinn-network/trust-core',
];
const PUBLICATION_PORTALS = [
  '@jinn-network/benchmarking-publication', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-transport-http', '@jinn-network/record-publication',
];
const VERIFY_PORTALS = [
  '@jinn-network/benchmarking-aggregate', '@jinn-network/benchmarking-interop',
  '@jinn-network/benchmarking-local', '@jinn-network/benchmarking-records',
  '@jinn-network/benchmarking-run', '@jinn-network/environment-record',
  '@jinn-network/task-admission',
  '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol',
  '@jinn-network/trust-core',
];

const APPROVED = new Map([
  ['core', { colophon: ['@colophon-claims/verify'], jinn: CORE_JINN, portals: [
    '@colophon-claims/verify', ...CORE_JINN, '@jinn-network/environment-record', '@jinn-network/evidence-discovery',
    '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/execution-recorder',
    '@jinn-network/record-discovery-client',
  ] }],
  ['cli', { colophon: ['@colophon-claims/core', '@colophon-claims/verify'], jinn: [], portals: [
    '@colophon-claims/core', '@colophon-claims/verify', ...TRANSITIVE_PORTALS, ...PUBLICATION_PORTALS,
  ] }],
  ['verify', { colophon: [], jinn: VERIFY_JINN, portals: VERIFY_PORTALS }],
  ['web', { colophon: ['@colophon-claims/core'], jinn: [], portals: [
    // Verify is core's public runtime dependency. Web resolves it only as portal plumbing;
    // source-boundaries still permits web to import core alone.
    '@colophon-claims/core', '@colophon-claims/verify', ...TRANSITIVE_PORTALS, ...PUBLICATION_PORTALS,
  ] }],
]);

const SIBLING_TREE_DIRS = new Map([
  ...PRODUCT_PACKAGES.map(([directory, name]) => [name, join(packageRoot, directory)]),
  ['@jinn-network/attestation-issuer', join(root, 'packages/evidence/attestation-issuer')],
  ['@jinn-network/benchmarking-aggregate', join(root, 'packages/benchmarking/aggregate')],
  ['@jinn-network/benchmarking-interop', join(root, 'packages/benchmarking/interop')],
  ['@jinn-network/benchmarking-local', join(root, 'packages/benchmarking/local')],
  ['@jinn-network/benchmarking-publication', join(root, 'packages/benchmarking/publication')],
  ['@jinn-network/benchmarking-records', join(root, 'packages/benchmarking/records')],
  ['@jinn-network/benchmarking-run', join(root, 'packages/benchmarking/run')],
  ['@jinn-network/environment-record', join(root, 'packages/environments/record')],
  ['@jinn-network/evidence-discovery', join(root, 'packages/evidence/discovery')],
  ['@jinn-network/evidence-protocol', join(root, 'packages/evidence/protocol')],
  ['@jinn-network/evidence-repository', join(root, 'packages/evidence/repository')],
  ['@jinn-network/execution-recorder', join(root, 'packages/evidence/execution-recorder')],
  ['@jinn-network/record-discovery-client', join(root, 'packages/discovery/client')],
  ['@jinn-network/record-discovery-protocol', join(root, 'packages/discovery/protocol')],
  ['@jinn-network/record-discovery-serve', join(root, 'packages/discovery/serve')],
  ['@jinn-network/record-discovery-transport-http', join(root, 'packages/discovery/transport-http')],
  ['@jinn-network/record-publication', join(root, 'packages/discovery/publication')],
  ['@jinn-network/task-admission', join(root, 'packages/task-supply/admission')],
  ['@jinn-network/task-execution-backend', join(root, 'packages/task-execution/backend')],
  ['@jinn-network/task-execution-backend-local', join(root, 'packages/task-execution/backend-local/assembly')],
  ['@jinn-network/task-execution-evaluation-harness', join(root, 'packages/task-execution/evaluation-harness')],
  ['@jinn-network/task-execution-evaluator-adapters', join(root, 'packages/task-execution/evaluator-adapters')],
  ['@jinn-network/task-execution-launchers', join(root, 'packages/task-execution/backend-local/launchers')],
  ['@jinn-network/task-execution-oci-grader', join(root, 'packages/task-execution/oci-grader')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages/task-execution/profiles')],
  ['@jinn-network/task-execution-protocol', join(root, 'packages/task-execution/protocol')],
  ['@jinn-network/task-execution-supervisor', join(root, 'packages/task-execution/backend-local/supervisor')],
  ['@jinn-network/task-execution-workspace', join(root, 'packages/task-execution/backend-local/workspace')],
  ['@jinn-network/trust-core', join(root, 'packages/trust/core')],
]);

function readPackage(directory) {
  const path = join(packageRoot, directory, 'package.json');
  assert.ok(existsSync(path), `missing package manifest: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
function packageManifests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || ['.next', 'dist', 'node_modules'].includes(entry.name)) return [];
    const child = join(directory, entry.name);
    const manifest = join(child, 'package.json');
    return [...(existsSync(manifest) ? [manifest] : []), ...packageManifests(child)];
  });
}
function dependencyNames(manifest, scope) {
  return DEPENDENCY_SECTIONS.flatMap((section) => Object.keys(manifest[section] ?? {})
    .filter((name) => name.startsWith(scope))).sort();
}
function expectedPortal(directory, name) {
  const target = SIBLING_TREE_DIRS.get(name);
  assert.ok(target, `${directory} declares an unknown first-party dependency ${name}`);
  return `portal:${relative(join(packageRoot, directory), target) || '.'}`;
}

test('the Colophon claims inventory is explicit and derives its membership from the live tree', () => {
  const actual = packageManifests(packageRoot).flatMap((manifestPath) => {
    const { name } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof name === 'string' && name.startsWith(COLOPHON_SCOPE)
      ? [[relative(packageRoot, dirname(manifestPath)), name]] : [];
  }).sort();
  assert.deepEqual(actual, PRODUCT_PACKAGES.map(([directory, name]) => [directory, name]).sort());
  for (const [directory, name, visibility] of PRODUCT_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, name);
    assert.equal(manifest.repository?.directory, `packages/benchmark-product/${directory}`);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.version, PACKAGE_VERSIONS.get(name));
    assert.equal(manifest.private === true, visibility === 'private', `${name} visibility drifted`);
    for (const dependency of dependencyNames(manifest, COLOPHON_SCOPE)) {
      assert.equal(manifest.dependencies?.[dependency], PACKAGE_VERSIONS.get(dependency), `${name} must pin public sibling ${dependency} exactly`);
    }
  }
});

test('the public Colophon members and private web have the intended publication posture', () => {
  const expectedBins = new Map([
    ['core', undefined],
    ['cli', { colophon: './dist/bin.js' }],
    ['verify', { 'colophon-verify': './dist/bin.js' }],
  ]);
  for (const [directory, name, visibility] of PRODUCT_PACKAGES) {
    const manifest = readPackage(directory);
    if (visibility === 'public') {
      assert.notEqual(manifest.private, true, `${name} must be packable and publishable`);
      assert.ok(manifest.exports?.['.'], `${name} must expose a public package entry`);
      assert.deepEqual(manifest.bin, expectedBins.get(directory), `${name} has an unexpected executable surface`);
      const installScripts = Object.keys(manifest.scripts ?? {}).filter((script) => /^(?:pre|post)?install$/.test(script));
      assert.deepEqual(installScripts, [], `${name} must not execute an install lifecycle script`);
    } else {
      assert.equal(manifest.private, true, `${name} must remain private`);
      assert.equal(manifest.exports, undefined, `${name} must not acquire a public package entry`);
    }
  }
});

test('the CLI packages web as private build input rather than a public runtime dependency', () => {
  const cli = readPackage('cli');
  assert.equal(cli.dependencies?.['@colophon-claims/web'], undefined);
  const buildScript = readFileSync(join(packageRoot, 'cli', 'scripts', 'build.mjs'), 'utf8');
  assert.match(buildScript, /buildPrivateWeb\(\)/, 'CLI build must build the private web input');
  assert.match(buildScript, /dist["'],\s*["']local-web/, 'CLI build must embed the private web output');
  assert.match(buildScript, /webRoot,\s*["']build/, 'CLI build must invoke the private web build before packing');
});

test('the cross-runner distribution artifact retains the private Next runtime without hidden secrets', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'benchmark-product-ci.yml'), 'utf8');
  const uploadStart = workflow.indexOf('      - name: Upload Benchmark Product runtime distributions');
  const uploadEnd = workflow.indexOf('\n  web:', uploadStart);
  assert.notEqual(uploadStart, -1, 'Benchmark Product CI must upload its runtime distributions');
  assert.notEqual(uploadEnd, -1, 'runtime distribution upload must remain in the product job');
  const upload = workflow.slice(uploadStart, uploadEnd);
  assert.match(upload, /include-hidden-files:\s*true/u, 'the artifact must retain the embedded .next runtime');
  for (const exclusion of [
    '!packages/**/dist/**/.env*',
    '!packages/**/dist/**/.git/**',
    '!packages/**/dist/**/.npmrc',
    '!packages/**/dist/**/.yarnrc*',
  ]) {
    assert.ok(upload.includes(exclusion), `hidden artifact upload must exclude ${exclusion}`);
  }
});

test('Colophon and Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of PRODUCT_PACKAGES) {
    const manifest = readPackage(directory);
    const approved = APPROVED.get(directory);
    assert.ok(approved, `missing dependency graph entry for ${directory}`);
    assert.deepEqual(dependencyNames(manifest, COLOPHON_SCOPE), [...approved.colophon].sort(), `${directory} has unapproved Colophon dependencies`);
    assert.deepEqual(dependencyNames(manifest, '@jinn-network/'), [...approved.jinn].sort(), `${directory} has unapproved Jinn dependencies`);
    const resolved = Object.keys(manifest.resolutions ?? {})
      .filter((name) => name.startsWith(COLOPHON_SCOPE) || name.startsWith('@jinn-network/')).sort();
    assert.deepEqual(resolved, [...approved.portals].sort(), `${directory} has unmatched first-party resolutions`);
    for (const name of approved.portals) {
      assert.equal(manifest.resolutions[name], expectedPortal(directory, name), `${directory} must resolve ${name} through its matching portal`);
    }
  }
});

test('Tier 1-3 packages do not adopt the Tier 4 Colophon identity', () => {
  const catalog = JSON.parse(readFileSync(architectureCatalogPath, 'utf8'));
  const offenders = catalog.packages.filter((entry) => [1, 2, 3].includes(entry.tier)).flatMap((entry) => {
    const manifestPath = join(root, entry.path, 'package.json');
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const references = [manifest.name, ...DEPENDENCY_SECTIONS.flatMap((section) => Object.keys(manifest[section] ?? {}))]
      .filter((value) => typeof value === 'string' && value.startsWith(COLOPHON_SCOPE));
    return references.map((reference) => `${entry.path} -> ${reference}`);
  });
  assert.deepEqual(offenders.sort(), [], 'only Tier 4 packages may use the Colophon package identity');
});

test('no package outside this Tier 4 product depends on Colophon', () => {
  const offenders = packageManifests(join(root, 'packages')).flatMap((manifestPath) => {
    if (manifestPath.startsWith(`${packageRoot}/`)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return dependencyNames(manifest, COLOPHON_SCOPE).map((name) => `${relative(root, manifestPath)} -> ${name}`);
  });
  assert.deepEqual(offenders.sort(), [], 'a non-product package depends on a Tier 4 Colophon package');
});
