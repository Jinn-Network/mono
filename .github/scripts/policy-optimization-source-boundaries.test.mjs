// The Policy Optimization product's import boundary, plus the private-statistics sweep.
//
// Two rules, both from the product design and the program's rulings, and both enforced as an
// ALLOW-list rather than a ban-list: a tier-4 product may depend on anything (design §2), which is
// exactly why "what it actually depends on" has to be a decision someone made rather than a
// default. A new Jinn edge fails here until it is added deliberately.
//
// 1. **The dependency allow-list.** `policy-identity`, `policy-outcomes`, `benchmarking-records`,
//    `benchmarking-run`, `benchmarking-aggregate`, `benchmarking-local`, plus the
//    `task-execution-backend` contract and `task-execution-testing` (dev-only: the TEP conformance
//    kit's in-memory fake). Marketplace packages, every other product, and the client are denied.
//    The one path-scoped exception is `host-local/` plus the process wrapper: that private host may
//    compose concrete local backends, evaluator adapters, profiles, launchers, workspaces, evidence,
//    and trust. Those edges remain forbidden from the neutral engine and from the public index.
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
const hostLocalRoot = join(sourceRoot, 'host-local');
const processWrapper = join(sourceRoot, 'cli', 'bin.ts');

const ALLOWED_JINN_PACKAGES = [
  '@jinn-network/benchmarking-aggregate',
  '@jinn-network/benchmarking-local',
  '@jinn-network/benchmarking-records',
  '@jinn-network/benchmarking-run',
  '@jinn-network/policy-identity',
  '@jinn-network/policy-outcomes',
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-testing',
];

// Concrete composition is confined to the private live host and its process wrapper. Neutral
// engine modules retain the smaller list above and therefore remain reusable without acquiring
// host authority or local-machine capabilities.
const HOST_LOCAL_ALLOWED_JINN_PACKAGES = [
  ...ALLOWED_JINN_PACKAGES,
  '@jinn-network/attestation-issuer',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
  '@jinn-network/execution-recorder',
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

// Named so the denial is a positive assertion rather than a consequence of the allow-list, and so
// a reader can see which families were considered and refused.
const EXPLICITLY_DENIED = [
  '@jinn-network/benchmarking-marketplace',
  '@jinn-network/marketplace-*',
  '@jinn-network/evidence-retrieval',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-protocol',
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

// Identifiers that name a statistic rather than use one. High-signal, and deliberately wider than
// the seed set after review findings M1/N6: the original list caught the named estimators a reader
// would think of first and let through the summary statistics anyone actually reaches for by
// reflex (a variance, a median, an average, a correlation). Every addition below is verified
// zero-hit against the tree at the time it was added, so the sweep starts and stays green.
const PRIVATE_STATISTICS_IDENTIFIERS = [
  'average',
  'bayesFactor',
  'bootstrap',
  'confidenceInterval',
  'correlation',
  'credibleInterval',
  'geometricMean',
  'harmonicMean',
  'median',
  'pValue',
  'percentile',
  'posterior',
  'quantile',
  'regression',
  'sqrt',
  'standardDeviation',
  'standardError',
  'stdDev',
  'tTest',
  'variance',
  'wilson',
  'zScore',
];

const privateStatisticsIdentifier = new RegExp(
  String.raw`(?<![\w$])(?:${PRIVATE_STATISTICS_IDENTIFIERS.join('|')})(?![\w$])`,
  'gi',
);

/**
 * `mean`, but only where it is being **declared or called** — never as a bare identifier.
 *
 * A bare `mean` is how a consumer READS a registry method's own published output
 * (`arms[armId].mean`, in the seam and lifecycle tests), and banning that would ban the one
 * legitimate use: consuming a statistic `benchmarking-aggregate` computed. Declaring `mean` or
 * calling `mean(...)` is the product computing one, which is exactly what ruling R3 forbids.
 */
const privateMeanDeclaration = new RegExp(
  String.raw`(?:\bfunction\s+mean\b|\b(?:const|let|var)\s+mean\s*=|(?<![\w$.])mean\s*\()`,
  'g',
);

/**
 * Can a `/` at this position only start a regex literal, not a division?
 *
 * The usual heuristic, and enough here: after a value (identifier, literal, closing bracket) a
 * slash divides; after an operator, a keyword, or the start of input it opens a regex. Getting this
 * wrong in the permissive direction is the dangerous one -- treating code as a regex body blanks
 * real source -- so the check requires an affirmative "previous token cannot end a value".
 */
function regexCanStartHere(result) {
  const before = result.replace(/\s+$/u, '');
  if (before === '') return true;
  const last = before.at(-1);
  if ('([{,;:!&|?+-*/^~%<>='.includes(last)) return true;
  return /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)$/u.test(before);
}

/**
 * Replace comments, string/template literals, and regex literals with layout-preserving whitespace.
 *
 * A scanner that skips comments and strings reports every mention of `pValue` in a comment
 * explaining why `pValue` is banned -- and the first person to hit that deletes the explanation.
 * Regex literals are the same problem one level down (review finding N6): this file's own
 * `/median/`-style patterns are code, but the identifiers inside a regex body are data, and a
 * character class containing `/` would otherwise desynchronise the scanner and blank whatever
 * followed until the next quote.
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
    } else if (char === '/' && regexCanStartHere(result)) {
      inert(char); index += 1;
      let inClass = false;
      while (index < source.length && source[index] !== '\n') {
        const current = source[index];
        if (current === '\\') { inert(current); index += 1; if (index < source.length) inert(source[index++]); continue; }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        inert(source[index++]);
      }
      if (index < source.length && source[index] === '/') inert(source[index++]);
      while (index < source.length && /[dgimsuvy]/u.test(source[index])) inert(source[index++]);
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
  return sourceFiles.flatMap((file) => {
    const executable = executableSource(readFileSync(file, 'utf8'));
    return [
      ...[...executable.matchAll(privateStatisticsIdentifier)].map((match) => match[0]),
      ...[...executable.matchAll(privateMeanDeclaration)].map((match) => match[0].trim()),
    ].map((hit) => `${relative(root, file)} -> ${hit}`);
  }).sort();
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
  const all = files(sourceRoot);
  const hostFiles = all.filter((file) => inside(file, hostLocalRoot) || file === processWrapper);
  const neutralFiles = all.filter((file) => !hostFiles.includes(file));
  assert.deepEqual(
    unapprovedImports(neutralFiles, ALLOWED_JINN_PACKAGES, FORBIDDEN_ROOTS),
    [],
    'the neutral engine crosses its declared dependency boundary',
  );
  assert.deepEqual(
    unapprovedImports(hostFiles, HOST_LOCAL_ALLOWED_JINN_PACKAGES, FORBIDDEN_ROOTS),
    [],
    'the private host crosses its declared dependency boundary',
  );
});

test('the public barrel never re-exports private host composition', () => {
  const barrel = join(sourceRoot, 'index.ts');
  const imports = specifiers(readFileSync(barrel, 'utf8'));
  assert.equal(imports.some((specifier) => specifier.includes('host-local')), false,
    'src/index.ts must not expose private host-local modules');
});

test('policy-optimization actually imports the dependencies it declares (positive control)', () => {
  // Without this the boundary test above could pass vacuously if an edge were silently dropped --
  // an absent edge is not the same claim as an audited one.
  if (!existsSync(sourceRoot)) return;
  const imported = new Set(files(sourceRoot).flatMap((file) => specifiers(readFileSync(file, 'utf8'))));
  for (const name of [
    '@jinn-network/policy-identity',
    '@jinn-network/benchmarking-records',
    '@jinn-network/benchmarking-run',
    '@jinn-network/benchmarking-local',
    '@jinn-network/benchmarking-aggregate',
    '@jinn-network/task-execution-backend',
  ]) {
    assert.ok(imported.has(name), `expected at least one import of ${name}`);
  }
  assert.ok(imported.has('@jinn-network/task-execution-backend-local'),
    'the private live host must positively import the concrete local backend');
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
      'const prose = "wilson confidenceInterval median variance";',
      'export const objectiveMethods = [];',
      '// Reading a registry method\'s own published output is the legitimate use of `mean`.',
      'const armMean = arms[armId].mean;',
      'const named = { mean: report.mean };',
      '// Regex literals are data, not a private estimator (N6) -- including a class holding a slash.',
      'const pattern = /median|variance/u;',
      'const withSlash = /[/]average/u;',
      'const ratio = passed / scorable;',
    ].join('\n'));
    assert.deepEqual(privateStatisticsUses(files(source)), []);

    writeFileSync(join(source, 'dirty.ts'), [
      'export function wilson(num, den) { return num / den; }',
      'const ci = confidenceInterval(rows);',
      'export function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }',
      'const avg = mean(rates);',
      'const spread = variance(rates);',
      'const mid = median(rates);',
      'const root = sqrt(spread);',
      'const r = correlation(a, b);',
      'const line = regression(points);',
      'const g = geometricMean(rates);',
      'const h = harmonicMean(rates);',
      'const mu = average(rates);',
      'const m2 = ((values) => { const mean = 0; return mean; })([]);',
    ].join('\n'));
    // 2 seed hits + 11 additions/`mean` shapes: `function mean`, `mean(`, variance, median, sqrt,
    // correlation, regression, geometricMean, harmonicMean, average, `const mean =`.
    assert.equal(privateStatisticsUses([join(source, 'dirty.ts')]).length, 13);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the sweep separates a declared mean from a read one', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-policy-optimization-mean-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    // The exact shape the seam and lifecycle tests use to read `avg-at-k@1`'s sealed output.
    writeFileSync(join(source, 'read.ts'), 'const value = arms[arm.armId].mean;');
    assert.deepEqual(privateStatisticsUses(files(source)), []);

    writeFileSync(join(source, 'declare.ts'), 'function mean(xs) { return xs.length; }');
    assert.equal(privateStatisticsUses([join(source, 'declare.ts')]).length, 1);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
