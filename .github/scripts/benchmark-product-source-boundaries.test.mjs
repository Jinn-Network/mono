// The Benchmark Product's import boundary.
//
// One rule, from the product design and the program plan, enforced as an ALLOW-list rather than a
// ban-list: a tier-4 product may eventually depend on a wide REUSE surface (product design §3), which
// is exactly why "what it actually depends on today" has to be a decision someone made rather than a
// default. A new Jinn edge fails here until it is added deliberately, in this file and in the
// package-inventory guard's dependency graph together.
//
// **The dependency allow-list.** BP-01 admitted `@jinn-network/benchmarking-records` (Benchmark /
// Run / Matrix / Report sealing and the frozen outcome vocabulary). BP-11 (task intake) added four
// edges, each recorded in the design spec's §3 addendum: `benchmarking-interop` (importSweBench /
// defineBenchmark — the import seam), `task-execution-protocol` (sealTask / documentDigest — the
// bundled sample re-seals native prediction-forecast Tasks), `task-admission` (the golden
// prediction-snapshot fixture plus admitPredictionSnapshot / sealPredictionSnapshotAdmissionReceipt —
// the sample's admission receipts), and `task-execution-launchers` (at the time, a TEST-ONLY
// devDependency). BP-12 (the official run path) promoted `task-execution-launchers` to a real
// runtime edge (the real local venue's real subprocess-spawning solve launchers, `src/venue/venue.ts`)
// and added the rest of the real local-venue stack: `benchmarking-run` (quote/launch/resume/assemble/
// verify), `benchmarking-local` (`localAssemblyPorts`), `task-execution-backend` +
// `task-execution-backend-local` (the real local execution backend), `task-execution-supervisor` +
// `task-execution-workspace` (subprocess supervision), `task-execution-profiles` (task profile
// sealing/resolution), `task-execution-evaluation-harness` + `task-execution-evaluator-adapters` (the
// real evaluation leg), and `trust-core` (DSSE verdict signing). BP-13 (Report production/
// verification) added `benchmarking-aggregate` (`produceReport`/`verifyReport`, the §9.2 method
// registry). Everything else the design's §3 table names (`benchmarking-marketplace`, the
// `evidence-*` family, `environment-record`) is scope for a later packet and stays refused here
// until a packet adds it. Marketplace, every other product, and the client are denied outright,
// same as the policy-optimization precedent.
//
// **No deep imports (product design §3, "no deep imports — public package entries only").** A
// specifier that reaches past a Jinn package's public root -- `@jinn-network/<name>/src/...` or
// `@jinn-network/<name>/dist/...` -- is refused even for an allow-listed package. `platform.ts`'s
// consumption seam re-exports the public entry; nothing in this tree reaches into a sibling
// package's internals (extraction-readiness posture, spec §11 gate item 1).
//
// Cloned from the policy-optimization source-boundary guard's scanner machinery (`files`,
// `specifiers`, `packageSpecifierMatches`, `inside`, `unapprovedImports`); the private-statistics
// sweep is policy-optimization-specific (that product computes report statistics; this one computes
// nothing yet) and is deliberately not carried over.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'benchmark-product');

// Every direct child directory of packages/benchmark-product/ (excluding node_modules) that has a
// `src/` -- today only `core/src`, automatically covering a future `web/src` without editing this
// file. Guarded by existsSync so the live-tree tests below early-return if the family tree (or a
// not-yet-created member) is absent; the fixture-based positive-control tests below don't depend on
// this at all.
function sourceRoots() {
  if (!existsSync(packageRoot)) return [];
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => join(packageRoot, entry.name, 'src'))
    .filter((directory) => existsSync(directory));
}

const ALLOWED_JINN_PACKAGES = [
  '@jinn-network/benchmarking-aggregate',
  '@jinn-network/benchmarking-interop',
  '@jinn-network/benchmarking-local',
  '@jinn-network/benchmarking-records',
  '@jinn-network/benchmarking-run',
  '@jinn-network/task-admission',
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-evaluation-harness',
  '@jinn-network/task-execution-evaluator-adapters',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-workspace',
  '@jinn-network/trust-core',
];

// Packages admitted for test files only (devDependencies): a `.test.ts` may import them, non-test
// source may not. BP-12 promoted the one prior entry (`task-execution-launchers`) to a real
// runtime dependency (the local venue imports it from non-test source), so this list is empty for
// now — kept as a named, still-enforced list (`test-only packages are imported by test files
// alone`, below) rather than deleted, so a future test-only edge has a home without re-adding the
// mechanism.
const TEST_ONLY_JINN_PACKAGES = [];

// Named so the denial is a positive assertion rather than a consequence of the allow-list, and so a
// reader can see which families were considered and refused.
const EXPLICITLY_DENIED = [
  '@jinn-network/core',
  '@jinn-network/sdk',
  '@jinn-network/client',
  '@jinn-network/plugin',
  '@jinn-network/jinn-layer',
  '@jinn-network/plugin-runtime',
  '@jinn-network/autopilot',
  '@jinn-network/operator-spa',
  '@jinn-network/explorer-spa',
  '@jinn-network/indexer',
  '@jinn-network/indexer-enrichment',
  '@jinn-network/policy-optimization',
  '@jinn-network/marketplace-*',
  '@jinn-network/evidence-*',
  '@jinn-network/task-curation',
  '@jinn-network/task-derivation',
  '@jinn-network/task-posting',
  // Denied by name even though it resolves through this tree's portal graph: an allow-listed
  // package's own runtime edge, never this product's import.
  '@jinn-network/environment-record',
  // Not yet admitted: each is scope for a later packet (product design §3), added deliberately when
  // that packet wires it up.
  '@jinn-network/benchmarking-marketplace',
  // Deep-import exemplars (exact specifiers, not wildcards): refused by the deep-import rule even
  // though `benchmarking-records` is allow-listed and `task-execution-protocol` is a portal
  // resolution of it -- neither admits reaching into package internals.
  '@jinn-network/benchmarking-records/src/identifiers.js',
  '@jinn-network/task-execution-protocol/dist/index.js',
];

// Relative-path escapes into other trees are caught the same way a package-name ban would not.
// Enumerated dynamically so a future sibling family under packages/ is automatically forbidden
// without editing this file.
const FORBIDDEN_ROOTS = [
  join(root, 'client'),
  join(root, 'apps'),
  join(root, 'plugin'),
  join(root, 'scripts'),
  ...readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'benchmark-product' && entry.name !== 'node_modules')
    .map((entry) => join(root, 'packages', entry.name)),
];

// A Jinn specifier that reaches past the package's public root: `@jinn-network/<name>/src/...` or
// `@jinn-network/<name>/dist/...`. Refused even for an allow-listed package (product design §3).
const DEEP_IMPORT_PATTERN = /^@jinn-network\/[^/]+\/(?:src|dist)(?:\/|$)/;

function files(directory) {
  if (!existsSync(directory)) return [];
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
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function packageSpecifierMatches(specifier, pattern) {
  if (pattern.endsWith('*')) return specifier.startsWith(pattern.slice(0, -1));
  return specifier === pattern || specifier.startsWith(`${pattern}/`);
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

function unapprovedImports(sourceFiles, allowed, forbiddenRoots = []) {
  return sourceFiles.flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const isJinn = specifier.startsWith('@jinn-network/');
    const deepImportViolation = isJinn && DEEP_IMPORT_PATTERN.test(specifier);
    const jinnViolation = isJinn && !deepImportViolation
      && !allowed.some((name) => packageSpecifierMatches(specifier, name));
    const pathViolation = specifier.startsWith('.') && forbiddenRoots.some((forbiddenRoot) =>
      existsSync(forbiddenRoot) && inside(resolve(dirname(file), specifier), forbiddenRoot));
    return deepImportViolation || jinnViolation || pathViolation ? [`${relative(root, file)} -> ${specifier}`] : [];
  })).sort();
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-benchmark-product-boundary-'));
  try {
    const source = join(fixture, 'src');
    const forbidden = join(fixture, 'forbidden');
    mkdirSync(source); mkdirSync(forbidden);
    writeFileSync(join(source, 'source.ts'), [
      'import value from "@jinn-network/forbidden";',
      'export { value } from "@jinn-network/forbidden/export";',
      'await import("@jinn-network/forbidden/dynamic");',
      'require("@jinn-network/forbidden/require");',
      'import "../forbidden/local.js";',
    ].join('\n'));
    assert.equal(unapprovedImports(files(source), [], [forbidden]).length, 5);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the allow-list admits its members and refuses everything else, wildcards and deep imports included', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-benchmark-product-allow-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'allowed.ts'), ALLOWED_JINN_PACKAGES
      .map((name, index) => `import a${index} from ${JSON.stringify(name)};`).join('\n'));
    assert.deepEqual(unapprovedImports(files(source), ALLOWED_JINN_PACKAGES), []);

    writeFileSync(join(source, 'denied.ts'), EXPLICITLY_DENIED
      .map((name, index) => `import d${index} from ${JSON.stringify(name.endsWith('*') ? name.replace('*', 'binding') : name)};`)
      .join('\n'));
    assert.equal(
      unapprovedImports([join(source, 'denied.ts')], ALLOWED_JINN_PACKAGES).length,
      EXPLICITLY_DENIED.length,
      'every explicitly denied family, including the deep-import exemplars, must be refused by the allow-list',
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('benchmark-product source imports only its approved Jinn dependencies', () => {
  const roots = sourceRoots();
  if (roots.length === 0) return;
  assert.deepEqual(
    unapprovedImports(roots.flatMap(files), ALLOWED_JINN_PACKAGES, FORBIDDEN_ROOTS),
    [],
    'the product crosses its declared dependency boundary',
  );
});

test('benchmark-product actually imports the dependencies it declares (positive control)', () => {
  // Without this the boundary test above could pass vacuously if an edge were silently dropped -- an
  // absent edge is not the same claim as an audited one. Every allow-listed package must have at
  // least one live import; a name on the list with zero imports is an unused declaration. Matched
  // via `packageSpecifierMatches` (bare specifier OR a subpath of it), not exact string equality --
  // `task-execution-evaluation-harness` is imported only via its `/launcher` secondary entry point
  // (`src/venue/venue.ts`), never the bare package specifier.
  const roots = sourceRoots();
  if (roots.length === 0) return;
  const imported = roots.flatMap(files).flatMap((file) => specifiers(readFileSync(file, 'utf8')));
  for (const name of ALLOWED_JINN_PACKAGES) {
    assert.ok(
      imported.some((specifier) => packageSpecifierMatches(specifier, name)),
      `expected at least one import of ${name}`,
    );
  }
});

test('test-only packages are imported by test files alone', () => {
  // The launcher package is a devDependency admitted for the sample intake's shape-contract test.
  // A non-test source import of it would smuggle a runtime edge in through the test allowance.
  const roots = sourceRoots();
  if (roots.length === 0) return;
  const offenders = roots.flatMap(files)
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file))
    .flatMap((file) => specifiers(readFileSync(file, 'utf8'))
      .filter((specifier) => TEST_ONLY_JINN_PACKAGES
        .some((name) => packageSpecifierMatches(specifier, name)))
      .map((specifier) => `${relative(root, file)} -> ${specifier}`));
  assert.deepEqual(offenders, [], 'a test-only package is imported outside test files');
});
