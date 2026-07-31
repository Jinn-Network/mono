import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import { packageSpecifierMatches, scanSourceFile } from './plugin-tree-ast-custody.mjs';
import {
  APPROVED_RUNTIME_DEPENDENCIES,
  APPROVED_RUNTIME_DEV_DEPENDENCIES,
  discoverPluginPackages,
  exactVersionViolations,
  pluginRoot,
  readPackageManifest,
  relativeFromRoot,
  root,
  undeclaredInstallTimeDependencies,
  unconsumedApprovedEntries,
} from './plugin-tree-guard-common.mjs';
import { scanProductionSources } from './plugin-tree-ast-custody.mjs';

const tree = pluginRoot;
const DECLARED_PLUGIN_PACKAGES = ['runtime'];
const MIN_SCANNED_FILES = 8;

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
    assert.ok(violations.length >= 7);
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
  return undeclaredInstallTimeDependencies(manifest, PERMITTED_PACKAGES);
}

test('every plugin-tree npm package is discovered recursively by the shared helper', () => {
  assert.deepEqual(
    discoverPluginPackages().map((pkg) => pkg.directory),
    [...DECLARED_PLUGIN_PACKAGES].sort(),
    'every package.json under plugin/ must be discoverable by plugin-tree-guard-common',
  );
});

test('nested package discovery drives production scanning', () => {
  const fixture = mkdtempSync(join(tree, '.plugin-tree-nested-boundary-'));
  try {
    const nested = join(fixture, 'nested-pkg');
    mkdirSync(join(nested, 'src'), { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({
      name: '@jinn-network/nested-fixture',
      version: '0.0.0',
    }, null, 2));
    writeFileSync(join(nested, 'src', 'leak.ts'), 'const home = process.env.HOME;\n');
    const discovered = discoverPluginPackages().find((pkg) => pkg.directory.endsWith('nested-pkg'));
    assert.ok(discovered, 'nested fixture package must be discovered');
    const violations = scanProductionSources([discovered], scanOptions());
    assert.ok(violations.length >= 1);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
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
  assert.deepEqual(runtimeManifest.exports['.'], {
    types: './dist/index.d.ts',
    import: './dist/index.js',
  });
  assert.deepEqual(runtimeManifest.bin, { 'jinn-plugin-runtime': './dist/bin.js' });
  assert.deepEqual(runtimeManifest.files.sort(), ['README.md', 'dist/']);
  assert.deepEqual(undeclaredRuntimeDependencies(runtimeManifest), []);
  assert.deepEqual(
    exactVersionViolations(runtimeManifest, APPROVED_RUNTIME_DEPENDENCIES, 'dependencies'),
    [],
  );
  assert.deepEqual(
    exactVersionViolations(runtimeManifest, APPROVED_RUNTIME_DEV_DEPENDENCIES, 'devDependencies'),
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
