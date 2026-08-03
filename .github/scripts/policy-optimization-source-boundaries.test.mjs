// The Policy Optimization product's import boundary, plus the private-statistics sweep.
//
// Two rules, both from the product design and the program's rulings, and both enforced as an
// ALLOW-list rather than a ban-list: a tier-4 product may depend on anything (design §2), which is
// exactly why "what it actually depends on" has to be a decision someone made rather than a
// default. A new Jinn edge fails here until it is added deliberately.
//
// 1. **The dependency allow-list.** `policy-identity`, `policy-outcomes`, `benchmarking-records`,
//    `benchmarking-run`, `benchmarking-aggregate`, `benchmarking-local`. Marketplace packages,
//    every other product, and the client are denied outright: v0 executes on the local venue and
//    consumes the marketplace read-only through the §8.2 adapters' injected ports (design §11).
// 2. **`evidence-retrieval` is mirrors-only.** Its envelope shapes (`QuerySnapshotReceipt` and
//    friends) are mirrored where needed, never imported — the substrate §2 rule this product
//    inherits along with the manifest's `evidenceProvenance` block.
// 3. **Statistics only via the method registry (program ruling R3).** A private estimator inside
//    the product is exactly the thing that makes a policy-value claim non-recomputable by a third
//    party, which is the whole differentiation the design rests on (§3). New statistics land in
//    `@jinn-network/benchmarking-aggregate`'s registry with a reference implementation first.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'policy-optimization');
const sourceRoot = join(packageRoot, 'src');

const ALLOWED_JINN_PACKAGES = [
  '@jinn-network/benchmarking-aggregate',
  '@jinn-network/benchmarking-local',
  '@jinn-network/benchmarking-records',
  '@jinn-network/benchmarking-run',
  '@jinn-network/policy-identity',
  '@jinn-network/policy-outcomes',
];

// Named so the denial is a positive assertion rather than a consequence of the allow-list, and so
// a reader can see which families were considered and refused.
const EXPLICITLY_DENIED = [
  '@jinn-network/benchmarking-marketplace',
  '@jinn-network/marketplace-*',
  '@jinn-network/evidence-retrieval',
  '@jinn-network/autopilot',
  '@jinn-network/client',
  '@jinn-network/operator-spa',
  '@jinn-network/explorer-spa',
  '@jinn-network/indexer',
  '@jinn-network/indexer-enrichment',
  '@jinn-network/plugin-runtime',
  '@jinn-network/core',
  '@jinn-network/plugin',
  '@jinn-network/jinn-layer',
  '@jinn-network/sdk',
];

// Relative-path escapes into other trees are caught the same way a package-name ban would not.
const FORBIDDEN_ROOTS = [
  join(root, 'client'),
  join(root, 'apps'),
  join(root, 'plugin'),
  join(root, 'packages', 'marketplace'),
  join(root, 'packages', 'benchmarking'),
  join(root, 'packages', 'policy'),
  join(root, 'packages', 'task-execution'),
  join(root, 'packages', 'task-supply'),
  join(root, 'packages', 'evidence'),
];

// Identifiers that name a statistic rather than use one. Deliberately a small, high-signal set:
// the point is to catch a private estimator being written, not to police arithmetic.
const PRIVATE_STATISTICS_IDENTIFIERS = [
  'bayesFactor',
  'bootstrap',
  'confidenceInterval',
  'credibleInterval',
  'pValue',
  'percentile',
  'posterior',
  'quantile',
  'standardDeviation',
  'standardError',
  'stdDev',
  'tTest',
  'wilson',
  'zScore',
];

const privateStatisticsIdentifier = new RegExp(
  String.raw`(?<![\w$])(?:${PRIVATE_STATISTICS_IDENTIFIERS.join('|')})(?![\w$])`,
  'gi',
);

/**
 * Replace comments and string/template literals with layout-preserving whitespace. A scanner that
 * skips this step reports every mention of `pValue` in a comment explaining why `pValue` is banned
 * -- and the first person to hit that deletes the explanation.
 */
export function executableSource(source) {
  let result = '';
  const inert = (char) => { result += char === '\n' || char === '\r' ? char : ' '; };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') inert(source[index++]);
    } else if (char === '/' && next === '*') {
      inert(char); inert(next); index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) inert(source[index++]);
      if (index < source.length) { inert(source[index]); inert(source[index + 1]); index += 2; }
    } else if (char === '"' || char === "'" || char === '`') {
      inert(char); index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === '\\') { inert(source[index]); index += 1; }
        if (index < source.length) inert(source[index++]);
      }
      if (index < source.length) inert(source[index++]);
    } else {
      result += char;
      index += 1;
    }
  }
  return result;
}

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
    const jinnViolation = isJinn && !allowed.some((name) => packageSpecifierMatches(specifier, name));
    const pathViolation = specifier.startsWith('.') && forbiddenRoots.some((forbiddenRoot) =>
      existsSync(forbiddenRoot) && inside(resolve(dirname(file), specifier), forbiddenRoot));
    return jinnViolation || pathViolation ? [`${relative(root, file)} -> ${specifier}`] : [];
  })).sort();
}

function privateStatisticsUses(sourceFiles) {
  return sourceFiles.flatMap((file) => [...executableSource(readFileSync(file, 'utf8'))
    .matchAll(privateStatisticsIdentifier)].map((match) => `${relative(root, file)} -> ${match[0]}`)).sort();
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-policy-optimization-boundary-'));
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

test('the allow-list admits its members and refuses everything else, wildcard families included', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-policy-optimization-allow-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'allowed.ts'), ALLOWED_JINN_PACKAGES
      .map((name, index) => `import a${index} from ${JSON.stringify(name)};`).join('\n'));
    assert.deepEqual(unapprovedImports(files(source), ALLOWED_JINN_PACKAGES), []);

    writeFileSync(join(source, 'denied.ts'), EXPLICITLY_DENIED
      .map((name, index) => `import d${index} from ${JSON.stringify(name.replace('*', 'binding'))};`)
      .join('\n'));
    assert.equal(
      unapprovedImports([join(source, 'denied.ts')], ALLOWED_JINN_PACKAGES).length,
      EXPLICITLY_DENIED.length,
      'every explicitly denied family must be refused by the allow-list',
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('policy-optimization source imports only its approved Jinn dependencies', () => {
  if (!existsSync(sourceRoot)) return;
  assert.deepEqual(
    unapprovedImports(files(sourceRoot), ALLOWED_JINN_PACKAGES, FORBIDDEN_ROOTS),
    [],
    'the product crosses its declared dependency boundary',
  );
});

test('policy-optimization actually imports the dependencies it declares (positive control)', () => {
  // Without this the boundary test above could pass vacuously if an edge were silently dropped --
  // an absent edge is not the same claim as an audited one.
  if (!existsSync(sourceRoot)) return;
  const imported = new Set(files(sourceRoot).flatMap((file) => specifiers(readFileSync(file, 'utf8'))));
  for (const name of ['@jinn-network/policy-identity', '@jinn-network/benchmarking-records']) {
    assert.ok(imported.has(name), `expected at least one import of ${name}`);
  }
});

test('policy-optimization implements no private statistics (program ruling R3)', () => {
  if (!existsSync(sourceRoot)) return;
  assert.deepEqual(
    privateStatisticsUses(files(sourceRoot)),
    [],
    'statistics land in the @jinn-network/benchmarking-aggregate method registry with a reference '
      + 'implementation, never privately inside the product (program §7 R3)',
  );
});

test('the private-statistics sweep reads code, not prose', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-policy-optimization-stats-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'clean.ts'), [
      '// A private pValue or bootstrap estimator is banned; this comment must not trip the sweep.',
      'const prose = "wilson confidenceInterval";',
      'export const objectiveMethods = [];',
    ].join('\n'));
    assert.deepEqual(privateStatisticsUses(files(source)), []);

    writeFileSync(join(source, 'dirty.ts'), [
      'export function wilson(num, den) { return num / den; }',
      'const ci = confidenceInterval(rows);',
    ].join('\n'));
    assert.equal(privateStatisticsUses([join(source, 'dirty.ts')]).length, 2);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
