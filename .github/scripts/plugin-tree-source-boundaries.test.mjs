import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const tree = join(root, 'plugin');
const runtimeSource = join(tree, 'runtime', 'src');

// Floor on how many files the real-tree scan visits, so a future source move cannot make
// the scan silently pass zero files (custody-boundaries.test.mjs precedent).
const MIN_SCANNED_FILES = 8;

// The frozen trio (spec §4). Nothing in this tree may import them, ever: the clean-slate
// product supersedes them rather than migrating them. They are banned by package name,
// by subpath, and by relative path into their source trees.
const FROZEN_TRIO = [
  '@jinn-network/core',
  '@jinn-network/jinn-layer',
  '@jinn-network/plugin',
];
const FROZEN_TRIO_ROOTS = [
  join(root, 'packages', 'core'),
  join(root, 'packages', 'layer'),
  join(root, 'packages', 'plugin'),
];

// The composition table of design §6.1, plus the two packages the program commissions
// (C1 evidence-trajectory, C2 evidence-trace-decode) and the third-party libraries the
// design names. Being permitted here grants nothing on its own — the inventory guard's
// dependency graph is what admits a dependency. This list exists so that a normal
// dependency addition by C4-C7 needs no edit to the boundary contract, and so that
// anything NOT on it is a deliberate, reviewed decision.
const PERMITTED_PACKAGES = [
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-retrieval',
  '@jinn-network/evidence-trace-decode',
  '@jinn-network/evidence-trajectory',
  '@jinn-network/execution-recorder',
  '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-protocol',
  '@jinn-network/trust-core',
  '@jinn-network/trust-resolve',
  '@modelcontextprotocol/sdk',
  '@noble/hashes',
  'better-sqlite3',
  'zod',
];

const FORBIDDEN_PACKAGES = [
  ...FROZEN_TRIO,
  // Applications and legacy surfaces. The product is a peer of these, never a consumer.
  '@jinn-network/autopilot',
  '@jinn-network/client',
  '@jinn-network/indexer',
  '@jinn-network/indexer-enrichment',
  '@jinn-network/sdk',
  'hermes-agent',
  // The outbound lane is PARKED (spec §5, §13): captured records are publishable by
  // construction, and un-parking is a consent surface plus derivation-scrub at the
  // boundary — a reviewed decision that edits this list, never a silent import.
  '@jinn-network/evidence-contribution',
  '@jinn-network/evidence-publication',
  // No issuance surface in this scope.
  '@jinn-network/attestation-issuer',
  // Family bans by prefix, so they hold the moment any member registers. The launcher
  // contract needs no change and the plugin attaches beside the launchers, never inside
  // them (spec §6.5); there is no marketplace or benchmarking surface in scope (§13).
  '@jinn-network/benchmarking-*',
  '@jinn-network/marketplace-*',
  '@jinn-network/task-execution-*',
  // No chain surface: the runtime is read-plus-local-write and holds no keys (§8.5).
  'viem',
];

const FORBIDDEN_ROOTS = [
  ...FROZEN_TRIO_ROOTS,
  join(root, 'apps'),
  join(root, 'client'),
  // C0's relocated frozen adapter. This entry is pure path arithmetic and is correct
  // whether or not C0 has landed — insideForbiddenRoot() falls through to a relative()
  // computation when the root does not exist on disk.
  join(tree, 'frozen'),
];

// Canonical bytes must not depend on the host locale or the bundled ICU data: an ordering
// or formatting decision made with these APIs can change a record's digest between two
// hosts running identical code. Fail-closed by default; a presentation surface that
// genuinely needs locale formatting lands as an explicit, reviewed carve-out here.
const LOCALE_SENSITIVE_APIS = [
  'localeCompare',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
];
const localeSensitiveMember = new RegExp(
  String.raw`(?:\.|\?\.)\s*(?:${LOCALE_SENSITIVE_APIS.join('|')})\s*\(`,
  'g',
);
const localeSensitiveIntl = new RegExp(
  String.raw`(?<![\w$."'\x60])Intl\s*(?:\.|\?\.)`,
  'g',
);

function localeSensitiveUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [
      ...[...source.matchAll(localeSensitiveMember)],
      ...[...source.matchAll(localeSensitiveIntl)],
    ].map((match) => `${relative(root, file)} -> ${match[0].trim()}`);
  }).sort();
}

function files(directory) {
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isFile()) return /\.(?:[cm]?[jt]sx?)$/.test(directory) ? [directory] : [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

function specifiers(source) {
  const trivia = String.raw`(?:(?:\s+)|(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n|$)))*`;
  return [
    new RegExp(String.raw`\bfrom${trivia}["']([^"']+)["']`, 'g'),
    new RegExp(String.raw`\bimport${trivia}["']([^"']+)["']`, 'g'),
    new RegExp(String.raw`\bimport${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g'),
    new RegExp(String.raw`\brequire${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g'),
    new RegExp(String.raw`\bimport${trivia}\(${trivia}\x60((?:(?!\$\{)[^\x60])*)\x60${trivia}\)`, 'g'),
    new RegExp(String.raw`\brequire${trivia}\(${trivia}\x60((?:(?!\$\{)[^\x60])*)\x60${trivia}\)`, 'g'),
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

function sourceModuleStem(path) {
  return path.replace(/\.[cm]?[jt]sx?$/u, '');
}

function insideForbiddenRoot(path, forbiddenRoot) {
  return existsSync(forbiddenRoot) && lstatSync(forbiddenRoot).isFile()
    ? sourceModuleStem(path) === sourceModuleStem(forbiddenRoot)
    : inside(path, forbiddenRoot);
}

// A forbidden entry ending in `*` bans a whole package-name family by prefix; one ending
// in `/` bans by literal prefix; otherwise it must match the specifier exactly or as its
// subpath root (benchmarking-source-boundaries.test.mjs precedent).
function packageSpecifierMatches(specifier, forbidden) {
  if (forbidden.endsWith('*')) return specifier.startsWith(forbidden.slice(0, -1));
  if (forbidden.endsWith('/')) return specifier.startsWith(forbidden);
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

function forbiddenImportsInFiles(sourceFiles, forbiddenPackages, forbiddenRoots = []) {
  return sourceFiles.flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const packageMatch = forbiddenPackages.some((forbidden) => packageSpecifierMatches(specifier, forbidden));
    const pathMatch = specifier.startsWith('.') && forbiddenRoots.some((forbiddenRoot) =>
      insideForbiddenRoot(resolve(dirname(file), specifier), forbiddenRoot));
    return packageMatch || pathMatch ? [`${relative(root, file)} -> ${specifier}`] : [];
  })).sort();
}

function forbiddenImports(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  return forbiddenImportsInFiles(files(sourceRoot), forbiddenPackages, forbiddenRoots);
}

function assertBoundary(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  assert.deepEqual(forbiddenImportsInFiles(files(sourceRoot), forbiddenPackages, forbiddenRoots), [],
    `${relative(root, sourceRoot)} crosses a plugin tree architecture boundary`);
}

function manifest(directory) {
  return JSON.parse(readFileSync(join(tree, directory, 'package.json'), 'utf8'));
}

/** A `./`-prefixed relative specifier from `fixtureDir` to `target`. */
function localSpecifier(fixtureDir, target) {
  const specifier = relative(fixtureDir, target).replaceAll('\\', '/');
  return specifier.startsWith('.') ? specifier : `./${specifier}`;
}

const binEntry = join(runtimeSource, 'bin.ts');

// Custody law C2: no ambient authority acquisition. The runtime reads the environment in
// exactly one place — the binary — and hands the result to a pure resolver. `process` in
// any other file is a boundary violation, not a style question.
//
// The same confinement protects the wire: stdout is reserved for the MCP stdio transport
// (design §6.2), so a stray write anywhere else would corrupt the protocol stream.
const PROCESS_SURFACES = [
  [/process\s*(?:\.|\?\.)\s*env\b/g, 'process.env'],
  [/process\s*(?:\.|\?\.)\s*argv\b/g, 'process.argv'],
  [/process\s*(?:\.|\?\.)\s*stdout\b/g, 'process.stdout'],
  [/(?<![\w$."'\x60])console\s*(?:\.|\?\.)\s*(?:log|info|debug|table|dir)\s*\(/g, 'console stdout write'],
];

function processSurfaceUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return PROCESS_SURFACES.flatMap(([pattern, label]) =>
      [...source.matchAll(pattern)].map(() => `${relative(root, file)} -> ${label}`));
  }).sort();
}

// Custody law C3: signer objects only. Key-construction helpers and key-material
// parameter names are refused in any position (custody-boundaries.test.mjs precedent).
// The runtime is read-plus-local-write and holds no keys (design §8.5).
const KEY_MATERIAL_PATTERNS = [
  [/privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey/g, 'key-construction helper'],
  [/\b(?:privateKey|mnemonic|seedPhrase)\s*[:?]/gi, 'key-material parameter or property'],
];

function keyMaterialUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return KEY_MATERIAL_PATTERNS.flatMap(([pattern, label]) =>
      [...source.matchAll(pattern)].map(() => `${relative(root, file)} -> ${label}`));
  }).sort();
}

test('the process-surface scanner catches env, argv, stdout, and console writes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-custody-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'const home = process.env.JINN_PLUGIN_HOME;',
      'const args = process.argv.slice(2);',
      'process.stdout.write("leak");',
      'console.log("leak");',
      'console.info("leak");',
    ].join('\n'));
    assert.equal(processSurfaceUsesInFiles(files(source)).length, 5);
    writeFileSync(join(source, 'clean.ts'), [
      'export const resolve = (env: Record<string, string | undefined>) => env.JINN_PLUGIN_HOME;',
      'console.error("diagnostics go to stderr");',
    ].join('\n'));
    assert.deepEqual(processSurfaceUsesInFiles([join(source, 'clean.ts')]), []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the key-material scanner catches construction helpers and parameter names', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-keys-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import { privateKeyToAccount } from "somewhere";',
      'export function sign(options: { privateKey: string; mnemonic?: string }) {',
      '  return privateKeyToAccount(options.privateKey);',
      '}',
    ].join('\n'));
    assert.ok(keyMaterialUsesInFiles(files(source)).length >= 4);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('ambient process surfaces are confined to the binary, and no key material exists', () => {
  const sourceFiles = files(runtimeSource);
  const nonBin = sourceFiles.filter((file) => file !== binEntry);
  assert.deepEqual(
    processSurfaceUsesInFiles(nonBin),
    [],
    'only plugin/runtime/src/bin.ts may read the ambient environment or write stdout — '
      + 'configuration is injected (custody law C2) and stdout is reserved for the MCP '
      + 'stdio transport (design §6.2)',
  );
  assert.ok(existsSync(binEntry), 'plugin/runtime/src/bin.ts must exist to hold the confinement');
  assert.deepEqual(
    keyMaterialUsesInFiles(sourceFiles),
    [],
    'the runtime holds no keys and accepts no key material in any parameter position '
      + '(custody law C3)',
  );
});

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-boundary-'));
  try {
    const source = join(fixture, 'src');
    const forbidden = join(fixture, 'forbidden');
    mkdirSync(source); mkdirSync(forbidden);
    writeFileSync(join(source, 'source.ts'), [
      'import value from "@jinn-network/forbidden";',
      'export { value } from "@jinn-network/forbidden/export";',
      'await import("@jinn-network/forbidden/dynamic");',
      'require("@jinn-network/forbidden/require");',
      'await import(/* webpackIgnore: true */ "@jinn-network/forbidden/commented-dynamic");',
      'export { value } from /* boundary */ "@jinn-network/forbidden/commented-export";',
      'await import(// boundary',
      '  "@jinn-network/forbidden/line-comment");',
      'export { value } from /* first */ /* second */ "@jinn-network/forbidden/multiple-comments";',
      'await import(`@jinn-network/forbidden/template-dynamic`);',
      'require(`@jinn-network/forbidden/template-require`);',
      'import "../forbidden/local.js";',
    ].join('\n'));
    assert.equal(forbiddenImports(source, ['@jinn-network/'], [forbidden]).length, 11);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the family wildcard bans every member of a banned package family', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-wildcard-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import "@jinn-network/marketplace-binding";',
      'import "@jinn-network/benchmarking-records";',
      'import "@jinn-network/task-execution-launchers";',
    ].join('\n'));
    assert.equal(forbiddenImports(source, FORBIDDEN_PACKAGES).length, 3);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the guard refuses the frozen trio by name, by subpath, and by relative path', () => {
  // Created INSIDE the repository so that relative-path escapes resolve against the real
  // forbidden roots (repository-ipfs production-boundary test precedent).
  const fixture = mkdtempSync(join(tree, '.plugin-tree-frozen-boundary-'));
  try {
    const source = join(fixture, 'source.ts');
    writeFileSync(source, [
      'import "@jinn-network/core";',
      'import "@jinn-network/jinn-layer";',
      'import "@jinn-network/plugin";',
      'export * from "@jinn-network/core/scrub";',
      'await import("@jinn-network/plugin/ports");',
      'require("@jinn-network/jinn-layer/publish");',
      `import ${JSON.stringify(localSpecifier(fixture, join(root, 'packages', 'core', 'src')))};`,
      `import ${JSON.stringify(localSpecifier(fixture, join(root, 'packages', 'layer', 'src')))};`,
      `import ${JSON.stringify(localSpecifier(fixture, join(root, 'packages', 'plugin', 'src')))};`,
      `import ${JSON.stringify(localSpecifier(fixture, join(tree, 'frozen', 'jinn_layer.py')))};`,
    ].join('\n'));
    const findings = forbiddenImportsInFiles([source], FORBIDDEN_PACKAGES, FORBIDDEN_ROOTS);
    const label = relative(root, source);
    assert.deepEqual(findings, [
      `${label} -> ../../packages/core/src`,
      `${label} -> ../../packages/layer/src`,
      `${label} -> ../../packages/plugin/src`,
      `${label} -> @jinn-network/core`,
      `${label} -> @jinn-network/core/scrub`,
      `${label} -> @jinn-network/jinn-layer`,
      `${label} -> @jinn-network/jinn-layer/publish`,
      `${label} -> @jinn-network/plugin`,
      `${label} -> @jinn-network/plugin/ports`,
      `${label} -> ../frozen/jinn_layer.py`,
    ].sort());
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the frozen-root ban holds before C0 relocates the adapter', () => {
  // C0 is a sibling stack root; this tree must refuse plugin/frozen imports whether or
  // not that directory exists yet.
  assert.equal(existsSync(join(tree, 'frozen')) ? 'present' : 'absent', existsSync(join(tree, 'frozen')) ? 'present' : 'absent');
  const fixture = mkdtempSync(join(tree, '.plugin-tree-frozen-absent-'));
  try {
    const source = join(fixture, 'source.ts');
    writeFileSync(source, `import ${JSON.stringify(localSpecifier(fixture, join(tree, 'frozen', 'plugin.yaml')))};`);
    assert.equal(
      forbiddenImportsInFiles([source], [], [join(tree, 'frozen')]).length,
      1,
      'the plugin/frozen ban is path arithmetic and must not depend on the directory existing',
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the permitted allowlist and the forbidden list are disjoint', () => {
  const collisions = PERMITTED_PACKAGES.filter((permitted) =>
    FORBIDDEN_PACKAGES.some((forbidden) => packageSpecifierMatches(permitted, forbidden)));
  assert.deepEqual(collisions, [], 'a package may not be both permitted and forbidden');
  for (const frozen of FROZEN_TRIO) {
    assert.ok(FORBIDDEN_PACKAGES.includes(frozen), `${frozen} must be forbidden by name`);
    assert.ok(!PERMITTED_PACKAGES.includes(frozen), `${frozen} must not be permitted`);
  }
});

test('locale-sensitive API detection catches member calls, optional chaining, and Intl', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-locale-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      ...LOCALE_SENSITIVE_APIS.flatMap((api) => [`left.${api}(right);`, `left?.${api}(right);`]),
      'new Intl.Collator("en-US").compare(left, right);',
      'Intl?.Collator;',
    ].join('\n'));
    assert.equal(
      localeSensitiveUsesInFiles(files(source)).length,
      LOCALE_SENSITIVE_APIS.length * 2 + 2,
    );
    writeFileSync(join(source, 'clean.ts'), [
      'export function compareCodeUnitStrings(left, right) {',
      '  return left < right ? -1 : left > right ? 1 : 0;',
      '}',
      '// localeCompare is banned; this comment must not trip the scanner.',
    ].join('\n'));
    assert.deepEqual(localeSensitiveUsesInFiles([join(source, 'clean.ts')]), []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('plugin tree source boundaries hold and the manifest matches the approved shape', () => {
  const sourceFiles = files(runtimeSource);
  assert.ok(
    sourceFiles.length >= MIN_SCANNED_FILES,
    `expected at least ${MIN_SCANNED_FILES} source files scanned, got ${sourceFiles.length} — `
      + 'the runtime may have moved sources out of src/',
  );
  assertBoundary(runtimeSource, FORBIDDEN_PACKAGES, FORBIDDEN_ROOTS);

  const production = sourceFiles.filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  assert.deepEqual(
    localeSensitiveUsesInFiles(production),
    [],
    'plugin/runtime production source must not depend on the host locale or ICU data',
  );

  const runtimeManifest = manifest('runtime');
  assert.deepEqual(
    Object.keys(runtimeManifest.exports).sort(),
    ['.'],
    'the runtime publishes one entrypoint: tier 4 carries no conformance kit, so there is '
      + 'no ./testing export (spec §9.4)',
  );
  assert.deepEqual(runtimeManifest.exports['.'], {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  });
  assert.deepEqual(runtimeManifest.bin, { 'jinn-plugin-runtime': './dist/bin.js' });
  assert.deepEqual(runtimeManifest.files.sort(), ['README.md', 'dist/']);
  for (const section of [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  ]) {
    for (const dependency of Object.keys(runtimeManifest[section] ?? {})) {
      assert.ok(
        !FORBIDDEN_PACKAGES.some((forbidden) => packageSpecifierMatches(dependency, forbidden)),
        `runtime may not declare ${dependency} in ${section}`,
      );
      assert.ok(
        PERMITTED_PACKAGES.includes(dependency) || !dependency.startsWith('@jinn-network/'),
        `runtime declares Jinn dependency ${dependency}, which is not on the permitted list`,
      );
    }
  }
  assert.deepEqual(
    forbiddenImportsInFiles([join(runtimeSource, 'index.ts')], [], [binEntry]),
    [],
    'the runtime root entrypoint must not export bin.ts, which reads the ambient '
      + 'environment, installs signal handlers, and executes on import',
  );
});
