import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import { packageSpecifierMatches, scanSourceFile } from './plugin-tree-ast-custody.mjs';
import {
  APPROVED_RUNTIME_DEPENDENCIES,
  APPROVED_RUNTIME_DEV_DEPENDENCIES,
  APPROVED_RUNTIME_RESOLUTIONS,
  compareCodeUnit,
  derivePublicCodeEntrypoints,
  discoverPluginPackages,
  exactVersionViolations,
  pluginRoot,
  readPackageManifest,
  relativeFromRoot,
  resolutionViolations,
  root,
  undeclaredDependencies,
  undeclaredInstallTimeDependencies,
  undeclaredProductionDependencies,
  unconsumedApprovedEntries,
  validateExactDependencySections,
} from './plugin-tree-guard-common.mjs';
import { scanProductionSources } from './plugin-tree-ast-custody.mjs';

const tree = pluginRoot;
const DECLARED_PLUGIN_PACKAGES = ['runtime'];
const MIN_SCANNED_FILES = 9;

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
  '@jinn-network/autopilot',
  '@jinn-network/client',
  '@jinn-network/indexer',
  '@jinn-network/indexer-enrichment',
  '@jinn-network/sdk',
  'hermes-agent',
  '@jinn-network/evidence-contribution',
  '@jinn-network/evidence-publication',
  '@jinn-network/attestation-issuer',
  '@jinn-network/benchmarking-*',
  '@jinn-network/marketplace-*',
  '@jinn-network/task-execution-*',
  'viem',
];

const FORBIDDEN_ROOTS = [
  ...FROZEN_TRIO_ROOTS,
  join(root, 'apps'),
  join(root, 'client'),
  join(tree, 'frozen'),
];

const binEntry = join(tree, 'runtime', 'src', 'bin.ts');

function scanOptions(overrides = {}) {
  return {
    repoRoot: root,
    forbiddenPackages: FORBIDDEN_PACKAGES,
    forbiddenRoots: FORBIDDEN_ROOTS,
    readFile: (filePath) => readFileSync(filePath, 'utf8'),
    ...overrides,
  };
}

function scanFixtureSource(fixtureDir, fileName, content, { isBinEntry = false } = {}) {
  const sourceDir = join(fixtureDir, 'src');
  mkdirSync(sourceDir, { recursive: true });
  const filePath = join(sourceDir, fileName);
  writeFileSync(filePath, content);
  return scanSourceFile(filePath, content, {
    ...scanOptions(),
    isBinEntry,
  });
}

function importViolations(violations) {
  return violations.filter((entry) => !entry.includes('process.')
    && !entry.includes('locale-sensitive')
    && !entry.includes(' -> Intl')
    && !entry.includes('Intl alias')
    && !entry.includes('network module')
    && !entry.includes('network global')
    && !entry.includes('console ')
    && !entry.includes('dynamic evaluation')
    && !entry.includes('dynamic computed')
    && !entry.includes('destructured'));
}

function localSpecifier(fixtureDir, target) {
  const specifier = relative(fixtureDir, target).replaceAll('\\', '/');
  return specifier.startsWith('.') ? specifier : `./${specifier}`;
}

test('the AST custody scanner catches process destructuring, module imports, aliases, and bracket access', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-ast-process-'));
  try {
    const violations = scanFixtureSource(fixture, 'bypass.ts', [
      'const { env } = process;',
      'import { env, argv, stdout } from "node:process";',
      'import process from "process";',
      'const p = process;',
      'export const leak = p.env;',
      'const bracket = process["env"];',
      'globalThis.process.stderr.write("x");',
      'const g = globalThis;',
      'export const viaGlobal = g.process.env;',
    ].join('\n'));
    assert.ok(violations.some((entry) => entry.includes('import node:process')));
    assert.ok(violations.some((entry) => entry.includes('import process')));
    assert.ok(violations.some((entry) => entry.includes('process.env')));
    assert.ok(violations.some((entry) => entry.includes('process.stderr')));
    assert.ok(
      violations.some((entry) => entry.includes('process reference') || entry.includes('destructured process authority')),
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the AST custody scanner catches dynamic evaluation and nonliteral imports', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-ast-dynamic-'));
  try {
    const violations = scanFixtureSource(fixture, 'bypass.ts', [
      'const key = "env";',
      'export const dynamic = process[key];',
      'const runtime = Function("return process")();',
      'export const viaFn = runtime.exit(1);',
      'await import(moduleName);',
      'require(dynamicPath);',
      'eval("process.exit(1)");',
    ].join('\n'));
    assert.ok(violations.some((entry) => entry.includes('nonliteral')));
    assert.ok(violations.some((entry) => entry.includes('dynamic evaluation')));
    assert.ok(violations.some((entry) => entry.includes('dynamic computed')));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the AST custody scanner catches network modules, globals, and locale APIs', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-ast-network-'));
  try {
    const violations = scanFixtureSource(fixture, 'bypass.ts', [
      'import "node:http";',
      'import "undici";',
      'export const callFetch = fetch("https://example.com");',
      'export const socket = new WebSocket("wss://example.com");',
      'export const events = new EventSource("/events");',
      'const g = globalThis;',
      'export const aliasFetch = g.fetch;',
      'left.localeCompare(right);',
      'new Intl.Collator("en-US").compare(left, right);',
    ].join('\n'));
    assert.ok(violations.some((entry) => entry.includes('network module')));
    assert.ok(violations.some((entry) => entry.includes('network global fetch')));
    assert.ok(violations.some((entry) => entry.includes('locale-sensitive localeCompare')));
    assert.ok(violations.some((entry) => entry.includes('Intl')));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('production runtime source must not directly import forbidden fs or child_process', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-direct-import-'));
  try {
    const violations = scanFixtureSource(fixture, 'source.ts', [
      'import { readFileSync } from "node:fs";',
      'import { spawn } from "node:child_process";',
      'import { readFile } from "node:fs/promises";',
      'require("fs");',
    ].join('\n'));
    assert.equal(violations.length, 4);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('bin.ts allows only the exact realpathSync import and rejects other fs or child_process', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-bin-fs-'));
  try {
    const allowed = scanFixtureSource(fixture, 'bin.ts', [
      'import { realpathSync } from "node:fs";',
      'process.stdout.write("ok");',
    ].join('\n'), { isBinEntry: true });
    assert.deepEqual(allowed, []);

    const overreach = scanFixtureSource(fixture, 'bin-overreach.ts', [
      'import { readFileSync } from "node:fs";',
      'import { spawn } from "node:child_process";',
      'fetch("https://example.com");',
    ].join('\n'), { isBinEntry: true });
    assert.ok(overreach.length >= 3);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('undeclared third-party runtime dependencies and malformed versions are rejected', () => {
  assert.deepEqual(
    undeclaredRuntimeDependencies({ dependencies: { zod: '4.4.3' } }),
    [],
  );
  assert.deepEqual(
    undeclaredRuntimeDependencies({ dependencies: { lodash: '4.17.21' } }),
    ['dependencies:lodash'],
  );
  assert.deepEqual(
    undeclaredRuntimeDependencies({ dependencies: { 'better-sqlite3': '13.0.1' } }),
    [],
  );
  assert.deepEqual(
    exactVersionViolations(
      { dependencies: { 'better-sqlite3': '12.0.0' } },
      APPROVED_RUNTIME_DEPENDENCIES,
      'dependencies',
    ),
    ['dependencies:better-sqlite3=12.0.0'],
  );
  assert.deepEqual(
    exactVersionViolations(
      { dependencies: { 'better-sqlite3': '^12.0.0' } },
      APPROVED_RUNTIME_DEPENDENCIES,
      'dependencies',
    ),
    ['dependencies:better-sqlite3=^12.0.0'],
  );
  assert.deepEqual(
    undeclaredRuntimeDependencies({ optionalDependencies: { zod: '4.4.3' } }),
    [],
  );
  assert.deepEqual(
    undeclaredRuntimeDependencies({ optionalDependencies: { '@modelcontextprotocol/sdk': '1.0.0' } }),
    ['optionalDependencies:@modelcontextprotocol/sdk'],
  );
  assert.deepEqual(
    undeclaredRuntimeDependencies({ peerDependencies: { '@noble/hashes': '1.0.0' } }),
    ['peerDependencies:@noble/hashes'],
  );
  for (const pkg of PERMITTED_PACKAGES.filter((name) => !(name in APPROVED_RUNTIME_DEPENDENCIES))) {
    assert.deepEqual(
      undeclaredRuntimeDependencies({ dependencies: { [pkg]: '1.0.0' } }),
      [`dependencies:${pkg}`],
      `${pkg} must not pass production dependency allowlist via PERMITTED_PACKAGES`,
    );
  }
  assert.deepEqual(
    exactVersionViolations({ dependencies: { zod: '^4.4.3' } }, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    ['dependencies:zod=^4.4.3'],
  );
  assert.deepEqual(
    exactVersionViolations({ dependencies: { zod: '4.4.2' } }, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    ['dependencies:zod=4.4.2'],
  );
  assert.deepEqual(
    exactVersionViolations(
      { devDependencies: { typescript: '^5.9.3' } },
      APPROVED_RUNTIME_DEV_DEPENDENCIES,
      'devDependencies',
    ),
    ['devDependencies:typescript=^5.9.3'],
  );
});

function undeclaredRuntimeDependencies(manifest) {
  return undeclaredProductionDependencies(manifest);
}

test('every plugin-tree npm package is discovered recursively by the shared helper', () => {
  assert.deepEqual(
    discoverPluginPackages().map((pkg) => pkg.directory),
    [...DECLARED_PLUGIN_PACKAGES].sort(),
    'every package.json under plugin/ must be discoverable by plugin-tree-guard-common',
  );
});

test('nested package discovery drives production scanning', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-nested-boundary-'));
  try {
    const nested = join(tempRoot, 'nested-pkg');
    mkdirSync(join(nested, 'src'), { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({
      name: '@jinn-network/nested-boundary-fixture',
      version: '0.0.0',
    }, null, 2));
    writeFileSync(join(nested, 'src', 'leak.ts'), 'const home = process.env.HOME;\n');
    const discovered = discoverPluginPackages({ root: tempRoot }).find((pkg) => pkg.directory === 'nested-pkg');
    assert.ok(discovered, 'nested fixture package must be discovered');
    const violations = scanProductionSources([discovered], scanOptions());
    assert.ok(violations.length >= 1);
  } finally { rmSync(tempRoot, { recursive: true, force: true }); }
});

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-boundary-'));
  try {
    const source = join(fixture, 'src');
    const forbidden = join(fixture, 'forbidden');
    mkdirSync(source); mkdirSync(forbidden);
    const content = [
      'import value from "@jinn-network/forbidden";',
      'export { value } from "@jinn-network/forbidden/export";',
      'await import("@jinn-network/forbidden/dynamic");',
      'require("@jinn-network/forbidden/require");',
      'import "../forbidden/local.js";',
    ].join('\n');
    writeFileSync(join(source, 'source.ts'), content);
    const violations = importViolations(scanSourceFile(join(source, 'source.ts'), content, {
      ...scanOptions(),
      forbiddenPackages: ['@jinn-network/'],
      forbiddenRoots: [forbidden],
    }));
    assert.equal(violations.length, 5);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the family wildcard bans every member of a banned package family', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-wildcard-'));
  try {
    const content = [
      'import "@jinn-network/marketplace-binding";',
      'import "@jinn-network/benchmarking-records";',
      'import "@jinn-network/task-execution-launchers";',
    ].join('\n');
    const filePath = join(fixture, 'src', 'source.ts');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    const violations = importViolations(scanSourceFile(filePath, content, {
      ...scanOptions(),
      forbiddenPackages: FORBIDDEN_PACKAGES,
    }));
    assert.equal(violations.length, 3);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the guard refuses the frozen trio by name, by subpath, and by relative path', () => {
  const fixture = mkdtempSync(join(tree, '.plugin-tree-frozen-boundary-'));
  try {
    const source = join(fixture, 'source.ts');
    const content = [
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
    ].join('\n');
    writeFileSync(source, content);
    const findings = importViolations(scanSourceFile(source, content, scanOptions()));
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
  const fixture = mkdtempSync(join(tree, '.plugin-tree-frozen-absent-'));
  try {
    const source = join(fixture, 'source.ts');
    const content = `import ${JSON.stringify(localSpecifier(fixture, join(tree, 'frozen', 'plugin.yaml')))};`;
    writeFileSync(source, content);
    assert.equal(
      importViolations(scanSourceFile(source, content, scanOptions())).length,
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
    const content = [
      'left.localeCompare(right);',
      'left?.localeCompare(right);',
      'new Intl.Collator("en-US").compare(left, right);',
      'Intl?.Collator;',
    ].join('\n');
    const filePath = join(fixture, 'src', 'source.ts');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    const violations = scanSourceFile(filePath, content, scanOptions());
    assert.ok(violations.some((entry) => entry.includes('locale-sensitive localeCompare')));
    assert.ok(violations.some((entry) => entry.includes('Intl')));
    const clean = scanSourceFile(join(fixture, 'src', 'clean.ts'), [
      'export function compareCodeUnitStrings(left, right) {',
      '  return left < right ? -1 : left > right ? 1 : 0;',
      '}',
    ].join('\n'), scanOptions());
    assert.deepEqual(clean, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-18 catches execPath, import-equals require, comma eval, and locale aliases', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-18-'));
  try {
    const violations = scanFixtureSource(fixture, 'bypass.ts', [
      'import fs = require("node:fs");',
      'const execPath = process.execPath;',
      'const F = Function;',
      'const runner = (0, eval);',
      'runner("1");',
      'const lc = value["localeCompare"];',
      'lc(left, right);',
      'const { WebSocket: WS } = globalThis;',
      'new WS("wss://example.com");',
    ].join('\n'));
    assert.ok(violations.some((entry) => entry.includes('process.execPath')));
    assert.ok(violations.some((entry) => entry.includes('node:fs')));
    assert.ok(violations.some((entry) => entry.includes('dynamic evaluation')));
    assert.ok(violations.some((entry) => entry.includes('locale-sensitive localeCompare')));
    assert.ok(violations.some((entry) => entry.includes('network global WS')));

    const shadowed = scanFixtureSource(fixture, 'shadow.ts', [
      'function probe() {',
      '  const process = { env: {} };',
      '  return process.env;',
      '}',
    ].join('\n'));
    assert.deepEqual(shadowed, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-19 bin.ts positive allowlist passes shipped shapes and rejects one mutation each', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-19-'));
  try {
    const allowed = scanFixtureSource(fixture, 'bin.ts', [
      'import { realpathSync } from "node:fs";',
      'import { homedir } from "node:os";',
      'import { join } from "node:path";',
      'import { fileURLToPath, pathToFileURL } from "node:url";',
      'process.argv.slice(2);',
      'process.env.JINN_PLUGIN_HOME;',
      'process.stdout.write("ok\\n");',
      'process.stderr.write("warn\\n");',
      'process.exitCode = 1;',
      'process.once("SIGINT", () => {});',
      'process.off("SIGTERM", () => {});',
    ].join('\n'), { isBinEntry: true });
    assert.deepEqual(allowed, []);

    for (const [name, content, needle] of [
      ['kill.ts', 'process.kill(process.pid, "SIGTERM");', 'forbidden bin process.kill'],
      ['node-process.ts', 'import { env } from "node:process";', 'import node:process'],
      ['console.ts', 'console.log("x");', 'console log'],
      ['exit.ts', 'process.exit(1);', 'forbidden bin process.exit'],
    ]) {
      const violations = scanFixtureSource(fixture, name, content, { isBinEntry: true });
      assert.ok(violations.some((entry) => entry.includes(needle)), `${name} must fail on ${needle}`);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-20 parse diagnostics fail-closed for every supported extension', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-20-'));
  try {
    for (const fileName of ['bad.ts', 'bad.tsx', 'bad.js', 'bad.jsx', 'bad.mjs', 'bad.cjs']) {
      const violations = scanFixtureSource(fixture, fileName, 'const value = ;\n');
      assert.ok(
        violations.some((entry) => entry.includes('parse error')),
        `${fileName} must surface a parse error violation`,
      );
    }
    const valid = scanFixtureSource(fixture, 'good.ts', 'export const ok = 1;\n');
    assert.deepEqual(valid, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-21 key-material canary catches parameters, properties, and construction helpers', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-21-'));
  try {
    const violations = scanFixtureSource(fixture, 'keys.ts', [
      'function sign(privateKey: string) {}',
      'function load({ seed_phrase }: { seed_phrase: string }) {}',
      'const account = privateKeyToAccount("0x");',
      'const wallet = mnemonicToAccount("test test test");',
    ].join('\n'));
    assert.ok(violations.some((entry) => entry.includes('key-material parameter: privateKey')));
    assert.ok(violations.some((entry) => entry.includes('key-material parameter: seed_phrase')));
    assert.ok(violations.some((entry) => entry.includes('key-construction helper privateKeyToAccount')));

    const benign = scanFixtureSource(fixture, 'clean.ts', [
      'function compare(left: string, right: string) { return left < right; }',
    ].join('\n'));
    assert.deepEqual(benign, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-22 discovery fails on symlinks and rejects wildcard exports', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-22-'));
  try {
    const nested = join(tempRoot, 'symlink-pkg');
    mkdirSync(join(nested, 'src'), { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({
      name: '@jinn-network/symlink-fixture',
      version: '0.0.0',
    }, null, 2));
    writeFileSync(join(nested, 'src', 'index.ts'), 'export const x = 1;\n');
    symlinkSync(join(nested, 'src', 'index.ts'), join(nested, 'src', 'alias.ts'));
    assert.throws(
      () => discoverPluginPackages({ root: tempRoot }),
      /symlink in source tree/,
    );
  } finally { rmSync(tempRoot, { recursive: true, force: true }); }
});

test('R-C3-24 derives explicit public code entrypoints and rejects wildcards', () => {
  const runtimeManifest = readPackageManifest('runtime');
  assert.deepEqual(
    derivePublicCodeEntrypoints(runtimeManifest).map((entry) => entry.subpath),
    ['.'],
  );
  assert.throws(
    () => derivePublicCodeEntrypoints({
      name: '@jinn-network/wildcard-fixture',
      exports: { './*': './dist/*.js' },
    }),
    /wildcard/,
  );
});

test('R-C3-29 catches wrapper bypasses, createRequire, data imports, block scope leak, and bin aliases', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-29-'));
  try {
    const violations = scanFixtureSource(fixture, 'bypass.ts', [
      '(globalThis as typeof globalThis).process.env;',
      'const runner = globalThis.eval;',
      'runner("1");',
      'import { createRequire } from "node:module";',
      'const req = createRequire(import.meta.url);',
      'req("node:fs");',
      'await import("data:text/javascript,export%20const%20x%3D1");',
    ].join('\n'));
    assert.ok(violations.some((entry) => entry.includes('process.env')));
    assert.ok(violations.some((entry) => entry.includes('globalThis.eval')));
    assert.ok(violations.some((entry) => entry.includes('code-loading createRequire')));
    assert.ok(violations.some((entry) => entry.includes('code-loading module node:module')));
    assert.ok(violations.some((entry) => entry.includes('code-loading url data:')));

    const blockLeak = scanFixtureSource(fixture, 'block-leak.ts', [
      'export function probe() {',
      '  { const process = { env: {} }; }',
      '  return process.env;',
      '}',
    ].join('\n'));
    assert.ok(blockLeak.some((entry) => entry.includes('process.env')));

    const binAlias = scanFixtureSource(fixture, 'bin.ts', [
      'const { env } = process;',
      'env.JINN_PLUGIN_HOME;',
    ].join('\n'), { isBinEntry: true });
    assert.ok(binAlias.some((entry) => entry.includes('forbidden bin process alias')));

    const binMutation = scanFixtureSource(fixture, 'bin-mut.ts', [
      'process.env.FOO = "bar";',
    ].join('\n'), { isBinEntry: true });
    assert.ok(binMutation.some((entry) => entry.includes('forbidden bin process.env mutation')));

    const binDefaultFs = scanFixtureSource(fixture, 'bin-fs.ts', [
      'import fs from "node:fs";',
      'fs.realpathSync(".");',
    ].join('\n'), { isBinEntry: true });
    assert.ok(binDefaultFs.some((entry) => entry.includes('node:fs')));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-30 discovers .plugin-tree-* under temp roots and hidden sources fail custody', () => {
  assert.doesNotThrow(() => discoverPluginPackages(), 'live plugin tree must not contain ephemeral guard fixture directories');

  const tempRoot = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-30-temp-'));
  try {
    const hiddenPkg = join(tempRoot, '.plugin-tree-hidden');
    mkdirSync(join(hiddenPkg, 'src'), { recursive: true });
    writeFileSync(join(hiddenPkg, 'package.json'), JSON.stringify({
      name: '@jinn-network/hidden-temp-fixture',
      version: '0.0.0',
    }, null, 2));
    writeFileSync(join(hiddenPkg, 'src', 'index.ts'), 'process.env.LEAK;\n');
    const discovered = discoverPluginPackages({ root: tempRoot });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].name, '@jinn-network/hidden-temp-fixture');
    assert.ok(!DECLARED_PLUGIN_PACKAGES.includes(discovered[0].directory));
    const violations = scanProductionSources(discovered, scanOptions());
    assert.ok(violations.some((entry) => entry.includes('process.env')));
  } finally { rmSync(tempRoot, { recursive: true, force: true }); }
});

test('R-C3-31 rejects unsupported export shapes outside the reviewed contract', () => {
  assert.throws(
    () => derivePublicCodeEntrypoints({
      name: '@jinn-network/outside',
      exports: { '.': { types: '../outside.d.ts', import: '../outside.js' } },
    }),
    /relative|dist/,
  );
  assert.throws(
    () => derivePublicCodeEntrypoints({
      name: '@jinn-network/condition',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' } },
    }),
    /types before import|unsupported condition/,
  );
});

test('R-C3-36 catches parameter defaults, dynamic global access, and tagged templates', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-36-'));
  try {
    const violations = scanFixtureSource(fixture, 'authority.ts', [
      'function f(x = process.env.HOME) { return x; }',
      'const key = "fetch";',
      'globalThis[key]("https://example.com");',
      'Function`return process`;',
      'const F = globalThis.Function;',
      'F`return 1`;',
    ].join('\n'));
    assert.ok(violations.some((entry) => entry.includes('process.env')));
    assert.ok(violations.some((entry) => entry.includes('dynamic computed global access')));
    assert.ok(violations.some((entry) => entry.includes('dynamic evaluation tagged template')));

    const shadowed = scanFixtureSource(fixture, 'shadow.ts', [
      'function probe() {',
      '  const globalThis = { fetch() {} };',
      '  globalThis["fetch"]("local");',
      '}',
    ].join('\n'));
    assert.deepEqual(shadowed, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-37 bin env/argv direct-read-only rejects aliases and mutations', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-37-'));
  try {
    const allowed = scanFixtureSource(fixture, 'bin.ts', [
      'process.env.JINN_PLUGIN_HOME;',
      'process.argv.slice(2);',
    ].join('\n'), { isBinEntry: true });
    assert.deepEqual(allowed, []);

    for (const [name, content, needle] of [
      ['env-alias.ts', 'const env = process.env;\nenv.LEAK = "yes";', 'forbidden bin process.env alias'],
      ['argv-push.ts', 'process.argv.push("--bad");', 'forbidden bin process.argv mutation'],
      ['env-inc.ts', 'process.env.COUNT++;', 'forbidden bin process.env mutation'],
    ]) {
      const violations = scanFixtureSource(fixture, name, content, { isBinEntry: true });
      assert.ok(violations.some((entry) => entry.includes(needle)), `${name} must fail on ${needle}`);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-39 rejects reordered export conditions and encoded traversal targets', () => {
  assert.throws(
    () => derivePublicCodeEntrypoints({
      name: '@jinn-network/reordered',
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    }),
    /types before import/,
  );
  for (const [importTarget, expectPattern] of [
    ['./dist/%2e%2e/outside.js', /percent encoding/],
    ['./dist/%252e%252e/outside.js', /percent encoding/],
    ['./dist/%2f/index.js', /percent encoding/],
    ['./dist/%5c/index.js', /percent encoding/],
    ['./dist\\index.js', /backslashes/],
    ['./outside.js', /dist/],
    ['./dist/index.js?query=1', /query or fragment/],
    ['./dist/index.js#frag', /query or fragment/],
  ]) {
    assert.throws(
      () => derivePublicCodeEntrypoints({
        name: '@jinn-network/escape',
        exports: {
          '.': {
            types: importTarget.replace('.js', '.d.ts'),
            import: importTarget,
          },
        },
      }),
      expectPattern,
    );
  }
});

test('R-C3-43 rejects indirect ambient via reflection, sequence, and call wrappers', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-43-'));
  try {
    for (const [name, content, needle] of [
      ['reflect-process.ts', 'export const leak = Reflect.get(globalThis, "process").env.SECRET;', 'Reflect.get globalThis.process'],
      ['reflect-nonliteral.ts', 'const key = "fetch"; export const leak = Reflect.get(globalThis, key);', 'dynamic computed Reflect.get'],
      ['comma-require.ts', 'export const fs = (0, require)("node:fs");', 'node:fs'],
      ['require-call.ts', 'export const fs = require.call(null, "node:fs");', 'node:fs|nonliteral dynamic import'],
      ['module-require.ts', 'export const fs = module.require("node:fs");', 'node:fs'],
      ['fn-proto-call.ts', 'export const leak = Function.prototype.call.call(eval, null, "1");', 'dynamic evaluation'],
    ]) {
      const violations = scanFixtureSource(fixture, name, content);
      const needles = needle.split('|');
      assert.ok(
        needles.some((part) => violations.some((entry) => entry.includes(part))),
        `${name} must fail on ${needle}: ${violations.join('; ')}`,
      );
    }

    const safeLocal = scanFixtureSource(fixture, 'safe-reflect.ts', [
      'const local = { secret: 1 };',
      'export const ok = Reflect.get(local, "secret");',
    ].join('\n'));
    assert.deepEqual(safeLocal, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-44 rejects every ambient process mutation shape in bin', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-44-'));
  try {
    for (const [name, content, needle] of [
      ['nullish-assign.ts', 'process.env.HOME ??= "/tmp";', 'forbidden bin process env mutation'],
      ['logical-assign.ts', 'process.argv[0] ||= "node";', 'forbidden bin process argv mutation'],
      ['object-assign.ts', 'Object.assign(process.env, { LEAK: "yes" });', 'forbidden bin process env mutation'],
      ['reflect-set-argv.ts', 'Reflect.set(process.argv, 0, "bad");', 'forbidden bin process argv mutation'],
      ['reflect-set-env-root.ts', 'Reflect.set(process, "env", {});', 'forbidden bin process process mutation'],
      ['argv-push.ts', 'process.argv.push("--bad");', 'forbidden bin process.argv mutation'],
    ]) {
      const violations = scanFixtureSource(fixture, name, content, { isBinEntry: true });
      assert.ok(violations.some((entry) => entry.includes(needle)), `${name} must fail on ${needle}`);
    }

    const allowed = scanFixtureSource(fixture, 'bin-read.ts', [
      'process.env.JINN_PLUGIN_HOME;',
      'process.argv.slice(2);',
      'process.exitCode = 1;',
    ].join('\n'), { isBinEntry: true });
    assert.deepEqual(allowed, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-50 lexical shadowing resolves bindings not identifier text', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-50-'));
  try {
    mkdirSync(join(fixture, 'src'), { recursive: true });
    writeFileSync(join(fixture, 'src', 'local-process.js'), 'export const env = { SAFE: "1" };\n');
    const safe = scanFixtureSource(fixture, 'shadow.ts', [
      'function localFetch() { const fetch = () => "local"; return fetch(); }',
      'function localEval() { const eval = () => "local"; return eval(); }',
      'function localIntl() { const Intl = { Collator: class { compare() { return 0; } } }; return new Intl.Collator().compare("a", "b"); }',
      'function localProcess() { const process = { env: { SAFE: "1" } }; return process.env.SAFE; }',
      'import * as process from "./local-process.js";',
      'export const viaNamespace = process.env.SAFE;',
    ].join('\n'));
    assert.deepEqual(safe.filter((entry) => entry.includes('process.env') || entry.includes('network global fetch') || entry.includes('Intl') || entry.includes('dynamic evaluation')), []);

    const ambient = scanFixtureSource(fixture, 'ambient.ts', [
      'export const viaFetch = fetch("https://example.com");',
      'export const viaEval = eval("1");',
      'new Intl.Collator("en-US").compare("a", "b");',
      'export const viaProcess = process.env.HOME;',
    ].join('\n'));
    assert.ok(ambient.some((entry) => entry.includes('network global fetch')));
    assert.ok(ambient.some((entry) => entry.includes('dynamic evaluation eval')));
    assert.ok(ambient.some((entry) => entry.includes('Intl')));
    assert.ok(ambient.some((entry) => entry.includes('process.env')));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-51 rejects syntax-independent callable authority bypasses', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-51-'));
  try {
    for (const [name, content, needle] of [
      ['reflect-fetch.ts', 'Reflect.get(globalThis, "fetch")();', 'network global alias call'],
      ['reflect-fn.ts', 'Reflect.get(globalThis, "Function")("return 1");', 'dynamic evaluation alias call'],
      ['comma-global.ts', 'export const leak = (0, globalThis).process.env.HOME;', 'process.env'],
      ['fn-constructor.ts', 'Function.prototype.constructor("return 1")();', 'dynamic evaluation alias call'],
      ['vm-default.ts', 'import vm from "node:vm"; vm.runInThisContext("1");', 'code-loading module node:vm'],
      ['vm-named.ts', 'import { runInNewContext } from "node:vm"; runInNewContext("1");', 'code-loading module node:vm'],
    ]) {
      const violations = scanFixtureSource(fixture, name, content);
      assert.ok(violations.some((entry) => entry.includes(needle)), `${name} must fail on ${needle}`);
    }

    const safe = scanFixtureSource(fixture, 'safe-reflect.ts', [
      'const local = { secret: 1 };',
      'export const ok = Reflect.get(local, "secret");',
    ].join('\n'));
    assert.deepEqual(safe, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-52 rejects bin computed members, delete, and mutator aliases', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-52-'));
  try {
    for (const [name, content, needle] of [
      ['argv-computed.ts', 'process.argv["push"]("--bad");', 'forbidden bin process.argv mutation'],
      ['delete-argv.ts', 'delete process.argv[0];', 'forbidden bin process argv mutation'],
      ['argv-alias.ts', 'const push = process.argv.push; push("--bad");', 'forbidden bin process alias call'],
      ['argv-bind.ts', 'const bound = process.argv.push.bind(process.argv); bound("--bad");', 'forbidden bin process.bind'],
    ]) {
      const violations = scanFixtureSource(fixture, name, content, { isBinEntry: true });
      assert.ok(violations.some((entry) => entry.includes(needle)), `${name} must fail on ${needle}`);
    }

    const allowed = scanFixtureSource(fixture, 'bin-read.ts', [
      'process.argv.slice(2);',
      'process.env.JINN_PLUGIN_HOME;',
    ].join('\n'), { isBinEntry: true });
    assert.deepEqual(allowed, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-53 TypeChecker resolves lexical scope without identifier-text false positives', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-53-'));
  try {
    const afterLoop = scanFixtureSource(fixture, 'loop.ts', [
      'for (let i = 0; i < 1; i++) { const fetch = () => "inner"; fetch(); }',
      'export const ambient = fetch("https://example.com");',
    ].join('\n'));
    assert.ok(afterLoop.some((entry) => entry.includes('network global fetch')));

    const blockShadow = scanFixtureSource(fixture, 'block.ts', [
      '{ const eval = () => "local"; eval(); }',
      'export const ambient = eval("1");',
    ].join('\n'));
    assert.ok(blockShadow.some((entry) => entry.includes('dynamic evaluation eval')));

    const safe = scanFixtureSource(fixture, 'local.ts', [
      'function localFetch() { const fetch = () => "local"; return fetch(); }',
    ].join('\n'));
    assert.deepEqual(safe.filter((entry) => entry.includes('network global fetch')), []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-54 rejects malformed export keys, string targets, and misleading extensions', () => {
  for (const [subpath, pattern] of [
    ['./foo#bar', /#/],
    ['./https://host/path', /wildcard|:|malformed/],
    ['././foo', /malformed/],
    ['./dist//index.js', /malformed/],
  ]) {
    assert.throws(
      () => derivePublicCodeEntrypoints({
        name: '@jinn-network/bad-subpath',
        exports: { [subpath]: { types: './dist/index.d.ts', import: './dist/index.js' } },
      }),
      pattern,
    );
  }
  for (const [target, pattern] of [
    ['./dist/index.js', /must be an object/],
    [{ types: './dist/index.d.ts.js', import: './dist/index.js' }, /misleading extension|must end with \.d\.ts/],
    [{ types: './dist/index.d.ts', import: './dist/index.js.d.ts' }, /misleading extension|must end with \.js/],
  ]) {
    assert.throws(
      () => derivePublicCodeEntrypoints({
        name: '@jinn-network/bad-target',
        exports: { '.': target },
      }),
      pattern,
    );
  }
});

test('R-C3-58 rejects indirect compiler-symbol authority bypasses', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-58-'));
  try {
    for (const [name, content, needle] of [
      ['identity-return.ts', 'function id(x) { return x; } export const leak = id(globalThis.process);', 'forbidden ambient authority argument'],
      ['reflect-alias.ts', 'const g = Reflect.get; export const leak = g(globalThis, "process").env.HOME;', 'forbidden ambient authority argument'],
      ['fn-constructor.ts', 'export const leak = (() => {}).constructor("return 1")();', 'dynamic evaluation alias call'],
      ['require-bracket-call.ts', 'export const fs = require["call"](null, "node:fs");', 'nonliteral dynamic import'],
      ['reflect-apply-require.ts', 'export const fs = Reflect.apply(require, null, ["node:fs"]);', 'forbidden ambient authority argument'],
      ['identity-pass.ts', 'function id(x) { return x; } id(process.env);', 'forbidden ambient authority argument'],
    ]) {
      const violations = scanFixtureSource(fixture, name, content);
      assert.ok(violations.some((entry) => entry.includes(needle)), `${name} must fail on ${needle}: ${violations.join('; ')}`);
    }

    const safe = scanFixtureSource(fixture, 'safe-local.ts', [
      'function local(x: string) { return x; }',
      'export const ok = local("safe");',
    ].join('\n'));
    assert.deepEqual(safe, []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-59 rejects ambient authority arguments including typed main', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-59-'));
  try {
    const violations = scanFixtureSource(fixture, 'main-pass.ts', [
      'function main(env: Record<string, string | undefined>) { Object.assign(env, { LEAK: "yes" }); }',
      'main(process.env);',
    ].join('\n'), { isBinEntry: true });
    assert.ok(violations.some((entry) => entry.includes('forbidden ambient authority argument')));

    const binSource = readFileSync(join(tree, 'runtime/src/bin.ts'), 'utf8');
    assert.match(binSource, /readConfigEnvFromProcess/);
    assert.doesNotMatch(binSource, /buildOwnedEnvSnapshot\(process\.env\)/);
    assert.doesNotMatch(binSource, /main\(process\.argv\.slice\(2\),\s*process\.env/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-60 scans src/dist and nested production paths', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-rc3-60-'));
  try {
    mkdirSync(join(fixture, 'nested-pkg', 'src', 'dist'), { recursive: true });
    writeFileSync(join(fixture, 'nested-pkg', 'package.json'), JSON.stringify({
      name: '@jinn-network/dist-scan-fixture',
      version: '0.0.0',
    }, null, 2));
    writeFileSync(join(fixture, 'nested-pkg', 'src', 'dist', 'authority.ts'), 'export const leak = process.env.HOME;\n');
    writeFileSync(join(fixture, 'nested-pkg', 'src', 'index.ts'), 'export const ok = 1;\n');
    const discovered = discoverPluginPackages({ root: fixture });
    assert.equal(discovered.length, 1);
    assert.ok(discovered[0].productionSourceFiles.some((file) => file.endsWith('/src/dist/authority.ts')));
    const violations = scanProductionSources(discovered, {
      readFile: (filePath) => readFileSync(filePath, 'utf8'),
      forbiddenPackages: [],
      forbiddenRoots: [],
    });
    assert.ok(violations.some((entry) => entry.includes('process.env')));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('R-C3-64 guard implementation files match CI trigger pattern', () => {
  const workflow = readFileSync(join(root, '.github/workflows/plugin-tree-ci.yml'), 'utf8');
  assert.match(workflow, /\.github\/scripts\/plugin-tree-\*\.mjs/);
  const guardFiles = readdirSync(join(root, '.github/scripts'))
    .filter((name) => name.startsWith('plugin-tree-') && name.endsWith('.mjs') && !name.endsWith('.test.mjs'));
  assert.ok(guardFiles.length >= 3);
  for (const file of guardFiles) {
    assert.match(file, /^plugin-tree-.*\.mjs$/);
  }
});

test('plugin tree source boundaries hold and the manifest matches the approved shape', () => {
  const packages = discoverPluginPackages();
  const sourceFiles = packages.flatMap((pkg) => pkg.sourceFiles);
  assert.ok(
    sourceFiles.length >= MIN_SCANNED_FILES,
    `expected at least ${MIN_SCANNED_FILES} source files scanned, got ${sourceFiles.length}`,
  );

  const violations = scanProductionSources(packages, scanOptions());
  assert.deepEqual(violations, [], `plugin tree production source crosses a boundary: ${violations.join('; ')}`);

  const runtimePackage = packages.find((pkg) => pkg.directory === 'runtime');
  assert.ok(runtimePackage);
  const runtimeManifest = runtimePackage.manifest;
  assert.deepEqual(Object.keys(runtimeManifest.exports).sort(), ['.']);
  assert.deepEqual(Object.keys(runtimeManifest.exports['.']), ['types', 'import']);
  assert.deepEqual(runtimeManifest.exports['.'], {
    types: './dist/index.d.ts',
    import: './dist/index.js',
  });
  assert.deepEqual(runtimeManifest.bin, { 'jinn-plugin-runtime': './dist/bin.js' });
  assert.deepEqual(runtimeManifest.files.sort(), ['README.md', 'dist/']);
  assert.deepEqual(undeclaredRuntimeDependencies(runtimeManifest), []);
  assert.deepEqual(validateExactDependencySections(runtimeManifest), []);
  assert.deepEqual(
    exactVersionViolations(runtimeManifest, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    [],
  );
  assert.deepEqual(
    exactVersionViolations(runtimeManifest, APPROVED_RUNTIME_DEV_DEPENDENCIES, 'devDependencies'),
    [],
  );
  assert.deepEqual(
    undeclaredDependencies(runtimeManifest, APPROVED_RUNTIME_DEV_DEPENDENCIES, 'devDependencies'),
    [],
  );
  assert.deepEqual(
    resolutionViolations(runtimeManifest, APPROVED_RUNTIME_RESOLUTIONS),
    [],
  );
  assert.deepEqual(
    unconsumedApprovedEntries(runtimeManifest, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    [],
  );
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(runtimeManifest[section] ?? {})) {
      assert.ok(
        !FORBIDDEN_PACKAGES.some((forbidden) => packageSpecifierMatches(dependency, forbidden)),
        `runtime may not declare ${dependency} in ${section}`,
      );
    }
  }
  assert.doesNotMatch(
    readFileSync(join(runtimePackage.srcDir, 'index.ts'), 'utf8'),
    /from\s+['"]\.\/bin(?:\.js)?['"]/,
    'the runtime root entrypoint must not export bin.ts',
  );
});
