// Import boundary for the Tier 4 Colophon claims product.  Jinn remains the lower-tier
// platform namespace; Colophon imports are permitted only between the four product members.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripComments } from './js-source-scanner.mjs';

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
  '@jinn-network/attestation-issuer', '@jinn-network/benchmarking-aggregate', '@jinn-network/benchmarking-evaluation', '@jinn-network/benchmarking-evidence', '@jinn-network/benchmarking-interop', '@jinn-network/benchmarking-local', '@jinn-network/benchmarking-native-capture', '@jinn-network/benchmarking-protocol', '@jinn-network/benchmarking-publication', '@jinn-network/benchmarking-records', '@jinn-network/benchmarking-run', '@jinn-network/evidence-protocol', '@jinn-network/execution-evidence-builder', '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-transport-http', '@jinn-network/record-publication', '@jinn-network/task-admission', '@jinn-network/task-execution-backend', '@jinn-network/task-execution-backend-local', '@jinn-network/task-execution-evaluation-harness', '@jinn-network/task-execution-evaluator-adapters', '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-oci-grader', '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace', '@jinn-network/trust-core', '@jinn-network/trust-testing',
];
const VERIFY_JINN = [
  '@jinn-network/benchmarking-aggregate', '@jinn-network/benchmarking-evidence', '@jinn-network/benchmarking-interop', '@jinn-network/benchmarking-local', '@jinn-network/benchmarking-protocol', '@jinn-network/benchmarking-records', '@jinn-network/benchmarking-run', '@jinn-network/task-admission', '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol', '@jinn-network/trust-core', '@jinn-network/trust-testing',
];
// `@jinn-network/trust-testing` is the Trust layer's conformance kit and a
// devDependency only, in BOTH `verify` and `core`: verify runs the anchor-proof
// contract suite (anchor-evidence design §11) against its own `node:crypto` ports,
// and core pins its producer-side `.ots` serializer against the kit's byte-verified
// builder and committed real-calendar capture (§6.2). It is admitted in both member
// lists above so the live-imports sweep sees it, and pinned to test sources below so
// it can never reach either published `dist/` -- each package's `tsconfig.build.json`
// excludes `src/**/*.test.ts` and `src/**/testing/**`, and this guard is what keeps
// that exclusion load-bearing.
//
// A `testing/` directory is a test source for this purpose: it holds synthetic bundle
// fixtures that drive real operations, which no consumer of a published `dist/` may
// reach, and which several sibling test files share -- so they cannot be named
// `*.test.ts` without a test runner collecting them.
const TEST_ONLY_JINN = ['@jinn-network/trust-testing'];
const isTestSource = (file) => /\.test\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)testing\//.test(file);
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

test('test-only dependencies are imported only from test sources', () => {
  const offenders = sourceRoots().flatMap((directory) => files(directory)
    .filter((file) => !isTestSource(file))
    .flatMap((file) => specifiers(readFileSync(file, 'utf8'))
      .filter((specifier) => TEST_ONLY_JINN.some((name) => matches(specifier, name)))
      .map((specifier) => `${relative(root, file)} -> ${specifier}`)));
  assert.deepEqual(offenders.sort(), [], 'a test-only dependency is imported from shipped source');
  const live = sourceRoots().flatMap((directory) => files(directory)
    .flatMap((file) => specifiers(readFileSync(file, 'utf8'))));
  for (const name of TEST_ONLY_JINN) {
    assert.ok(live.some((specifier) => matches(specifier, name)), `test-only guard is vacuous for ${name}`);
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

// `jinn.benchmarking.method/` is the §9.2 registry's namespace: an identifier under it names an
// implementation in `packages/benchmarking/aggregate`. Shipped product source that hand-types one
// of those strings asserts "this is the method that ran" without going anywhere near the code that
// would make it true -- which is how Demo-1's sealed analysis plan came to cite `paired-delta@1`, a
// clustered BCa bootstrap over binary pass rates, for numbers a local paired Student-t module had
// computed, and to cite `manipulation-check` and `variance-decomposition` under a namespace that
// registers neither (issue #2973). Source that genuinely delegates to a registered method imports
// `BENCHMARKING_METHOD_IDS` from `@jinn-network/benchmarking-records` and cites the constant, so a
// rename of the thing it names cannot pass silently; a product-local analysis owns its own
// identifier namespace instead. Test sources are exempt: their literals are fixtures for the
// registry's own methods, not published citations.
const REGISTERED_METHOD_NAMESPACE = 'jinn.benchmarking.method/';
const REGISTERED_METHOD_IDS_SOURCE = join(root, 'packages', 'benchmarking', 'records', 'src', 'identifiers.ts');
function registeredMethodIds() {
  const block = readFileSync(REGISTERED_METHOD_IDS_SOURCE, 'utf8').match(/BENCHMARKING_METHOD_IDS = \{([\s\S]*?)\} as const;/);
  assert.ok(block, 'BENCHMARKING_METHOD_IDS is no longer readable from the records identifiers module');
  const ids = [...block[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(ids.length > 0, 'the registered method identifier list parsed empty');
  return ids;
}
function hardcodedMethodIds(sourceFiles) {
  const pattern = new RegExp(`${REGISTERED_METHOD_NAMESPACE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9._-]*`, 'g');
  return sourceFiles.filter((file) => !isTestSource(file)).flatMap((file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    return [...new Set(code.match(pattern) ?? [])].map((id) => `${relative(root, file)} -> ${id}`);
  }).sort();
}

test('method-identifier scanner reads code and ignores comments', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'colophon-method-id-'));
  try {
    mkdirSync(join(fixture, 'src'));
    writeFileSync(join(fixture, 'src', 'cited.ts'), 'export const plan = [{ id: "jinn.benchmarking.method/paired-delta" }];\n');
    writeFileSync(join(fixture, 'src', 'described.ts'), '// not jinn.benchmarking.method/paired-delta\n/* nor jinn.benchmarking.method/wilson */\nexport const x = 1;\n');
    writeFileSync(join(fixture, 'src', 'cited.test.ts'), 'const id = "jinn.benchmarking.method/wilson";\n');
    assert.deepEqual(
      hardcodedMethodIds(files(join(fixture, 'src'))),
      [`${relative(root, join(fixture, 'src', 'cited.ts'))} -> jinn.benchmarking.method/paired-delta`],
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('method-identifier scanner does not read a quote inside a regex literal as opening a string', () => {
  // The over-report direction, and the reason this guard reads through the shared scanner rather
  // than a local copy of it: a quote-first scanner enters string mode at the apostrophe of
  // `/['"]/`, consumes to the next apostrophe anywhere in the file, and hands the intervening
  // comment back as live code -- reddening the guard on a comment. The shared scanner resolves the
  // `/` as a regex literal first, so the comment after it is still a comment.
  const fixture = mkdtempSync(join(tmpdir(), 'colophon-method-id-regex-'));
  try {
    mkdirSync(join(fixture, 'src'));
    writeFileSync(
      join(fixture, 'src', 'described.ts'),
      'const quoted = /[\'"]/u;\n// cites jinn.benchmarking.method/paired-delta in prose\nexport const x = quoted;\n',
    );
    assert.deepEqual(hardcodedMethodIds(files(join(fixture, 'src'))), []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('shipped product source cites a §9.2 method identifier only through the records constant', () => {
  const ids = registeredMethodIds();
  assert.ok(ids.includes(`${REGISTERED_METHOD_NAMESPACE}paired-delta`), 'the identifier from issue #2973 is no longer registered');
  const outsideNamespace = ids.filter((id) => !id.startsWith(REGISTERED_METHOD_NAMESPACE));
  assert.deepEqual(outsideNamespace, [], 'the registry moved off the namespace this guard polices');
  assert.deepEqual(
    sourceRoots().flatMap((directory) => hardcodedMethodIds(files(directory))),
    [],
    'shipped source hand-types a §9.2 method identifier instead of citing the registry constant',
  );
});

test('the live sweep covers all four product members', () => {
  assert.deepEqual(sourceRoots().map((directory) => relative(packageRoot, directory)).sort(), ['cli/src', 'core/src', 'verify/src', 'web/src']);
});
