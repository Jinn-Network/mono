import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const tree = join(root, 'plugin');
const runtimeSource = join(tree, 'runtime', 'src');

// Every npm package under plugin/ that the boundary scan must cover. The discovery test
// below proves this list matches the live tree so a new package cannot be inventoried
// while silently omitted from custody and import scans.
const BOUNDARY_SCANNED_PACKAGES = ['runtime'];

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
// design names. PERMITTED_PACKAGES is authoritative for runtime install-time dependency
// declarations (dependencies, optionalDependencies, peerDependencies); devDependencies
// remain free for tooling. Being permitted grants nothing on its own — the inventory
// guard's dependency graph is what admits a Jinn dependency. Anything NOT on this list
// requires a reviewed edit to both the list and the plan.
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

function discoveredPluginPackageDirectories() {
  if (!existsSync(tree)) return [];
  return readdirSync(tree, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === 'node_modules') return [];
    const child = join(tree, entry.name);
    return existsSync(join(child, 'package.json')) ? [entry.name] : [];
  }).sort();
}

function undeclaredRuntimeDependencies(manifest) {
  return ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((section) =>
    Object.keys(manifest[section] ?? {})
      .filter((dependency) => !PERMITTED_PACKAGES.includes(dependency))
      .map((dependency) => `${section}:${dependency}`),
  ).sort();
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
  [/process\s*\[\s*["'](?:env|argv|stdout)["']\s*\]/g, 'process bracket access'],
  [/(?<![\w$."'\x60])console\s*(?:\.|\?\.)\s*(?:log|info|debug|table|dir)\s*\(/g, 'console stdout write'],
];

const PROCESS_MODULE_SPECIFIERS = new Set(['node:process', 'process']);

// Tier-4 runtime may not acquire filesystem or subprocess primitives directly; stack
// packages encapsulate these (custody-boundaries.test.mjs precedent).
const FORBIDDEN_RUNTIME_DIRECT_IMPORTS = [
  'node:fs',
  'fs',
  'node:child_process',
  'child_process',
];

function processModuleImportsInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) =>
    specifiers(readFileSync(file, 'utf8')).flatMap((specifier) =>
      PROCESS_MODULE_SPECIFIERS.has(specifier)
        ? [`${relative(root, file)} -> import ${specifier}`]
        : []),
  ).sort();
}

function processAliasUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const aliases = [...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*process\b/g)]
      .map((match) => match[1]);
    if (aliases.length === 0) return [];
    return aliases.flatMap((alias) => {
      const dotted = new RegExp(String.raw`\b${alias}\s*(?:\.|\?\.)\s*(?:env|argv|stdout)\b`, 'g');
      const bracket = new RegExp(
        String.raw`\b${alias}\s*\[\s*["'](?:env|argv|stdout)["']\s*\]`,
        'g',
      );
      return [...source.matchAll(dotted), ...source.matchAll(bracket)]
        .map(() => `${relative(root, file)} -> process alias ${alias}`);
    });
  }).sort();
}

function processSurfaceUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return PROCESS_SURFACES.flatMap(([pattern, label]) =>
      [...source.matchAll(pattern)].map(() => `${relative(root, file)} -> ${label}`));
  }).sort();
}

function collectProcessCustodyViolations(sourceFiles) {
  return [
    ...processSurfaceUsesInFiles(sourceFiles),
    ...processModuleImportsInFiles(sourceFiles),
    ...processAliasUsesInFiles(sourceFiles),
  ].sort();
}

function directImportForbidden(specifier) {
  return FORBIDDEN_RUNTIME_DIRECT_IMPORTS.some((forbidden) =>
    specifier === forbidden || specifier.startsWith(`${forbidden}/`));
}

function forbiddenDirectImportsInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) =>
    specifiers(readFileSync(file, 'utf8')).flatMap((specifier) =>
      directImportForbidden(specifier) ? [`${relative(root, file)} -> ${specifier}`] : []),
  ).sort();
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

test('the process-surface scanner catches env, argv, stdout, bracket access, and console writes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-custody-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'const home = process.env.JINN_PLUGIN_HOME;',
      'const args = process.argv.slice(2);',
      'process.stdout.write("leak");',
      'const bracket = process["env"];',
      'console.log("leak");',
      'console.info("leak");',
    ].join('\n'));
    assert.equal(processSurfaceUsesInFiles(files(source)).length, 6);
    writeFileSync(join(source, 'clean.ts'), [
      'export const resolve = (env: Record<string, string | undefined>) => env.JINN_PLUGIN_HOME;',
      'console.error("diagnostics go to stderr");',
    ].join('\n'));
    assert.deepEqual(processSurfaceUsesInFiles([join(source, 'clean.ts')]), []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the hardened process-surface scanner catches module imports and alias acquisition', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-custody-bypass-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'import-node.ts'), [
      'import { env, argv, stdout } from "node:process";',
      'export const leak = [env, argv, stdout];',
    ].join('\n'));
    writeFileSync(join(source, 'import-bare.ts'), [
      'import process from "process";',
      'export const args = process.argv;',
    ].join('\n'));
    writeFileSync(join(source, 'alias.ts'), [
      'const p = process;',
      'export const home = p.env;',
    ].join('\n'));
    const scanned = [
      join(source, 'import-node.ts'),
      join(source, 'import-bare.ts'),
      join(source, 'alias.ts'),
    ];
    assert.ok(processModuleImportsInFiles(scanned).length >= 2);
    assert.ok(processAliasUsesInFiles(scanned).length >= 1);
    assert.ok(collectProcessCustodyViolations(scanned).length >= 3);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('production runtime source must not directly import node:fs or node:child_process', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-direct-import-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import { readFileSync } from "node:fs";',
      'import { spawn } from "node:child_process";',
      'import { readFile } from "node:fs/promises";',
      'require("fs");',
    ].join('\n'));
    assert.equal(forbiddenDirectImportsInFiles(files(source)).length, 4);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('undeclared third-party runtime dependencies are rejected', () => {
  assert.deepEqual(
    undeclaredRuntimeDependencies({ dependencies: { zod: '4.4.3' } }),
    [],
  );
  assert.deepEqual(
    undeclaredRuntimeDependencies({ dependencies: { lodash: '4.17.21' } }),
    ['dependencies:lodash'],
  );
  assert.ok(
    undeclaredRuntimeDependencies({
      dependencies: { zod: '4.4.3' },
      devDependencies: { vitest: '4.1.8', lodash: '4.17.21' },
    }).length === 0,
    'devDependencies remain free for tooling',
  );
});

test('every plugin-tree npm package is covered by the source-boundary scan', () => {
  assert.deepEqual(
    discoveredPluginPackageDirectories(),
    [...BOUNDARY_SCANNED_PACKAGES].sort(),
    'every package.json under plugin/ must be listed in BOUNDARY_SCANNED_PACKAGES',
  );
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
    collectProcessCustodyViolations(nonBin),
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
  const production = sourceFiles.filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  const productionNonBin = production.filter((file) => file !== binEntry);
  assert.deepEqual(
    forbiddenDirectImportsInFiles(productionNonBin),
    [],
    'plugin/runtime production source must not directly import node:fs or node:child_process',
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
    types: './dist/index.d.ts',
    import: './dist/index.js',
  });
  assert.deepEqual(runtimeManifest.bin, { 'jinn-plugin-runtime': './dist/bin.js' });
  assert.deepEqual(runtimeManifest.files.sort(), ['README.md', 'dist/']);
  assert.deepEqual(
    undeclaredRuntimeDependencies(runtimeManifest),
    [],
    'every runtime install-time dependency must be on PERMITTED_PACKAGES',
  );
  for (const section of [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  ]) {
    for (const dependency of Object.keys(runtimeManifest[section] ?? {})) {
      assert.ok(
        !FORBIDDEN_PACKAGES.some((forbidden) => packageSpecifierMatches(dependency, forbidden)),
        `runtime may not declare ${dependency} in ${section}`,
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
