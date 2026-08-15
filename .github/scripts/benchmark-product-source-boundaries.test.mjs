// Import boundary for the Tier 4 Colophon claims product.  Jinn remains the lower-tier
// platform namespace; Colophon imports are permitted only between the four product members.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = join(root, 'packages', 'benchmark-product');
const architectureCatalogPath = join(root, 'architecture', 'platform-packages.v1.json');
const PRIVATE_RUNTIME_IDENTIFIERS = [
  'jinn.network/benchmark-product/host-connection/1', 'jinn.network/benchmark-product/inspect-cell-summary/1',
  'jinn.network/benchmark-product/inspect-sandbox/1', 'jinn.network/benchmark-product/inspect-selection/1',
  'jinn.network/benchmark-product/inspect-selection/2', 'jinn.network/inspect-arm',
  'jinn.network/inspect-sandbox-host/1', 'jinn.network/model-broker/1',
  'jinn.network/profiles/inspect-evaluation/1',
];
const CORE_JINN = [
  '@jinn-network/attestation-issuer', '@jinn-network/benchmarking-aggregate', '@jinn-network/benchmarking-interop', '@jinn-network/benchmarking-local', '@jinn-network/benchmarking-publication', '@jinn-network/benchmarking-records', '@jinn-network/benchmarking-run', '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-transport-http', '@jinn-network/record-publication', '@jinn-network/task-admission', '@jinn-network/task-execution-backend', '@jinn-network/task-execution-backend-local', '@jinn-network/task-execution-evaluation-harness', '@jinn-network/task-execution-evaluator-adapters', '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-oci-grader', '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace', '@jinn-network/trust-core',
];
const VERIFY_JINN = [
  '@jinn-network/benchmarking-aggregate', '@jinn-network/benchmarking-interop', '@jinn-network/benchmarking-local', '@jinn-network/benchmarking-records', '@jinn-network/benchmarking-run', '@jinn-network/task-admission', '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol', '@jinn-network/trust-core',
];
const MEMBER_ALLOWED = new Map([
  ['core', [...CORE_JINN, '@colophon-claims/verify']],
  ['cli', ['@colophon-claims/core', '@colophon-claims/verify']],
  ['verify', VERIFY_JINN],
  ['web', ['@colophon-claims/core']],
]);
const WEB_CORE = '@colophon-claims/core';
const FORBIDDEN_ROOTS = [
  join(root, 'operator'), join(root, 'apps'), join(root, 'plugin'), join(root, 'scripts'),
  ...readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'benchmark-product' && entry.name !== 'node_modules')
    .map((entry) => join(root, 'packages', entry.name)),
];

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.next'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}
function allFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['.git', '.next', '.yarn', 'build', 'coverage', 'dist', 'node_modules'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? allFiles(path) : entry.isFile() ? [path] : [];
  });
}
function sourceRoots() {
  return [...MEMBER_ALLOWED.keys()].map((member) => join(packageRoot, member, 'src')).filter(existsSync);
}
function privateRuntimeViolations(roots) {
  return roots.flatMap(allFiles).flatMap((file) => {
    const bytes = readFileSync(file);
    if (bytes.includes(0)) return [];
    return PRIVATE_RUNTIME_IDENTIFIERS.filter((identifier) => bytes.toString('utf8').includes(identifier))
      .map((identifier) => `${relative(root, file)} -> ${identifier}`);
  }).sort();
}
function specifiers(source) {
  const trivia = String.raw`(?:(?:\s+)|(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n|$)))*`;
  return [new RegExp(String.raw`\bfrom${trivia}["']([^"']+)["']`, 'g'), new RegExp(String.raw`\bimport${trivia}["']([^"']+)["']`, 'g'), new RegExp(String.raw`\bimport${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g'), new RegExp(String.raw`\brequire${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g')]
    .flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}
function matches(specifier, packageName) { return specifier === packageName || specifier.startsWith(`${packageName}/`); }
function packageManifests(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || ['.git', '.yarn', 'node_modules'].includes(entry.name)) return [];
    const child = join(directory, entry.name);
    const manifest = join(child, 'package.json');
    return [...(existsSync(manifest) ? [manifest] : []), ...packageManifests(child)];
  });
}
const FIRST_PARTY_MANIFESTS = new Map(
  packageManifests(join(root, 'packages')).flatMap((path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    return typeof manifest.name === 'string' ? [[manifest.name, manifest]] : [];
  }),
);
function isPublicEntry(specifier, packageName) {
  if (specifier === packageName) return true;
  if (!specifier.startsWith(`${packageName}/`)) return false;
  const manifest = FIRST_PARTY_MANIFESTS.get(packageName);
  const requested = `./${specifier.slice(packageName.length + 1)}`;
  const exports = manifest?.exports;
  if (exports === undefined || exports === null || typeof exports !== 'object' || Array.isArray(exports)) return false;
  if (Object.hasOwn(exports, requested)) return true;
  return Object.keys(exports).some((key) => key.endsWith('*') && requested.startsWith(key.slice(0, -1)));
}
function inside(child, parent) { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !path.startsWith('/')); }
function violations(sourceFiles, allowed, forbiddenRoots = []) {
  return sourceFiles.flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const firstParty = specifier.startsWith('@jinn-network/') || specifier.startsWith('@colophon-claims/');
    const deep = firstParty && /^@(?:jinn-network|colophon-claims)\/[^/]+\/(?:src|dist)(?:\/|$)/.test(specifier);
    const unapproved = firstParty && !deep && !allowed.some((name) => isPublicEntry(specifier, name));
    const pathEscape = specifier.startsWith('.') && forbiddenRoots.some((forbidden) => existsSync(forbidden) && inside(resolve(dirname(file), specifier), forbidden));
    return deep || unapproved || pathEscape ? [`${relative(root, file)} -> ${specifier}`] : [];
  })).sort();
}

test('scanner catches package, unpublished subpath, deep-import, and local path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'colophon-boundary-'));
  try {
    mkdirSync(join(fixture, 'src')); mkdirSync(join(fixture, 'forbidden'));
    writeFileSync(join(fixture, 'src', 'source.ts'), 'import "@colophon-claims/no"; import "@jinn-network/x/src/a.js"; import "@jinn-network/benchmarking-records/not-exported"; import "../forbidden/a.js";');
    assert.equal(violations(files(join(fixture, 'src')), ['@jinn-network/benchmarking-records'], [join(fixture, 'forbidden')]).length, 4);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('each product member imports only its approved public package entries', () => {
  for (const directory of sourceRoots()) {
    const member = relative(packageRoot, directory).split('/')[0];
    assert.deepEqual(violations(files(directory), MEMBER_ALLOWED.get(member), FORBIDDEN_ROOTS), [], `${member} crosses its declared dependency boundary`);
  }
});

test('the declared source boundaries have live imports', () => {
  for (const directory of sourceRoots()) {
    const member = relative(packageRoot, directory).split('/')[0];
    const imported = files(directory).flatMap((file) => specifiers(readFileSync(file, 'utf8')));
    for (const name of MEMBER_ALLOWED.get(member)) {
      assert.ok(imported.some((specifier) => matches(specifier, name)), `${member} does not import approved dependency ${name}`);
    }
  }
});

test('web keeps core server-only and exposes only its fixed public archive route', () => {
  const webFiles = files(join(packageRoot, 'web', 'src'));
  const clientImports = webFiles.filter((file) => /^\s*["']use client["'];/m.test(readFileSync(file, 'utf8')))
    .flatMap((file) => specifiers(readFileSync(file, 'utf8')).filter((specifier) => matches(specifier, WEB_CORE)).map((specifier) => `${relative(root, file)} -> ${specifier}`));
  assert.deepEqual(clientImports, []);
  const unguarded = webFiles.filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => specifiers(readFileSync(file, 'utf8')).some((specifier) => matches(specifier, WEB_CORE)))
    .filter((file) => !/^\s*import\s+["']server-only["'];/m.test(readFileSync(file, 'utf8')) && !/^\s*["']use server["'];/m.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file));
  assert.deepEqual(unguarded, []);
  assert.deepEqual(
    webFiles.filter((file) => /(?:^|\/)app(?:\/.*)?\/route\.[cm]?[jt]sx?$/.test(file)).map((file) => relative(root, file)),
    ['packages/benchmark-product/web/src/app/publication/[...path]/route.ts'],
    'only the fixed same-workspace public archive route is allowed',
  );
  const duplicated = webFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [
      /\b(?:const|let|var)\s+PRODUCT_BRANDING\b/,
      /\b(?:const|let|var)\s+GATED_OPERATIONS\b/,
      /\b(?:const|let|var)\s+ASSURANCE_PRESETS\b/,
      /\bfunction\s+(?:runPreview|runQuote|runLock|runLaunch|runResume|runCancel|runStatus|runCollect|runResults|runReport|runVerify|createDraft|updateDraft)\b/,
    ].some((pattern) => pattern.test(source)) ? [relative(root, file)] : [];
  });
  assert.deepEqual(duplicated, [], 'web duplicates core-owned product semantics');
  const clientTestControls = webFiles
    .filter((file) => /^\s*["']use client["'];/m.test(readFileSync(file, 'utf8')))
    .filter((file) => /BENCHMARK_PRODUCT_(?:ENABLE_TEST_CONTROLS|TEST_SOLVE_DELAY_MS)/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file));
  assert.deepEqual(clientTestControls, [], 'server-only real-venue test controls leak into a client module');
  const productContext = readFileSync(join(packageRoot, 'web', 'src', 'lib', 'server', 'product-context.ts'), 'utf8');
  assert.match(productContext, /ENABLE_TEST_CONTROLS_ENV\]\?\.trim\(\) !== "1"/,
    'the solve-delay control must fail closed unless its independent enable flag is exact');
  assert.match(productContext, /delay > 60_000/,
    'the web solve-delay control must not admit values beyond core local-venue authority');
});

test('Tier 1-3 source does not import the Tier 4 Colophon namespace', () => {
  const catalog = JSON.parse(readFileSync(architectureCatalogPath, 'utf8'));
  const offenders = catalog.packages.filter((entry) => [1, 2, 3].includes(entry.tier))
    .flatMap((entry) => files(join(root, entry.path, 'src')).flatMap((file) => specifiers(readFileSync(file, 'utf8'))
      .filter((specifier) => specifier.startsWith('@colophon-claims/')).map((specifier) => `${relative(root, file)} -> ${specifier}`)));
  assert.deepEqual(offenders.sort(), [], 'only Tier 4 product source may import Colophon packages');
});

test('Tier 1-3 packages do not normalize Colophon-private runtime interfaces', () => {
  const catalog = JSON.parse(readFileSync(architectureCatalogPath, 'utf8'));
  const roots = catalog.packages.filter((entry) => [1, 2, 3].includes(entry.tier)).map((entry) => join(root, entry.path));
  assert.deepEqual(privateRuntimeViolations(roots), [], 'a lower-tier package adopted a private product runtime interface');
  const productSource = privateRuntimeViolations([packageRoot]).map((entry) => entry.slice(entry.indexOf(' -> ') + 4));
  for (const identifier of PRIVATE_RUNTIME_IDENTIFIERS) assert.ok(productSource.includes(identifier), `private runtime guard is vacuous for ${identifier}`);
});

test('the live sweep covers all four product members', () => {
  assert.deepEqual(sourceRoots().map((directory) => relative(packageRoot, directory)).sort(), ['cli/src', 'core/src', 'verify/src', 'web/src']);
});
