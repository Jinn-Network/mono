// The policy tree's import boundary, plus the ambient-network and host-locale sweeps.
//
// This is the reduced form of `task-supply-source-boundaries.test.mjs`: same bans, same reasons,
// a smaller scanner. The full scanner's job is to survive a large tree of application code; the
// policy tree is two pure packages whose production source is a few hundred lines, so comment and
// string-literal stripping is done in one pass here rather than with the full tokenizer. If the
// tree ever grows application code, fold these directories into the larger scanner rather than
// growing this one.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'policy');
const policyDirectories = ['identity', 'outcomes'];

// Substrate §2: the policy packages import protocol/record layers only. `identity` imports no
// Jinn package at all; `outcomes` imports exactly `@jinn-network/policy-identity` (carved out
// below via `assertBoundary`'s `allowed` parameter — see the reconciliation note on `zod`).
// Everything with fetch capability, chain access, storage, a backend, or an application surface
// is forbidden outright — a pure projection/identity package that acquires one of these has
// stopped being one.
const POLICY_FOREIGN_PACKAGES = [
  '@jinn-network/core',
  '@jinn-network/plugin',
  '@jinn-network/jinn-layer',
  '@jinn-network/benchmarking-*',
  '@jinn-network/evidence-*',
  '@jinn-network/environment-*',
  '@jinn-network/chain-*',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/record-discovery-*',
  '@jinn-network/discovery-*',
  '@jinn-network/marketplace-*',
  '@jinn-network/task-supply-*',
  '@jinn-network/task-admission',
  '@jinn-network/task-curation',
  '@jinn-network/task-derivation',
  '@jinn-network/task-posting',
  '@jinn-network/task-execution-backend',
  // Protocol is a devDependency, for `merge-parity.test.ts` only — it runs the real
  // `mergeRequirements` beside this package's reproduction of it. PRODUCTION source may never
  // import it: the whole point of reproducing the merge is that a pure tier-3 substrate carries no
  // Jinn runtime edge (substrate §2). This scan covers production files only, so listing it here
  // makes the test-only rule enforced rather than merely intended.
  '@jinn-network/task-execution-protocol',
  '@jinn-network/trust-*',
  'viem',
  'better-sqlite3',
  'kubo-rpc-client',
  'dockerode',
  // RECONCILIATION NOTE (C1/C2 merge): `zod` is deliberately NOT banned here, unlike an earlier
  // draft of this file. `identity` hand-rolls its own validation and has no need of it, but
  // `outcomes` uses `zod` as a real production dependency for its observation/row schemas —
  // exactly the same choice `@jinn-network/task-curation` (its template package, program §1 C2)
  // makes. `zod` carries no ambient authority (no clock, no network, no filesystem, no
  // randomness), so banning it tree-wide would have blocked a legitimate, already-precedented
  // choice for no purity benefit. Per-package Jinn-family and capability-package bans still apply
  // to both directories identically below.
];

// Every Jinn package NOT on this per-directory allow-list is forbidden for that directory. Both
// entries are drawn from `policy-package-inventory.test.mjs`'s approved dependency graph, so a
// change there is a design question, not a silent widening here.
const IDENTITY_ALLOWED_JINN = [];
const OUTCOMES_ALLOWED_JINN = ['@jinn-network/policy-identity'];

// Relative-path escapes into the legacy tree and the sibling package trees are caught the same
// way a package-name ban would not catch them.
const FORBIDDEN_ROOTS = [
  join(root, 'client'),
  join(root, 'packages', 'marketplace'),
  join(root, 'packages', 'benchmarking'),
  join(root, 'packages', 'task-execution'),
  join(root, 'packages', 'task-supply'),
];

const AMBIENT_NETWORK_APIS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
const LOCALE_SENSITIVE_APIS = [
  'localeCompare',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
];

const ambientNetworkIdentifier = new RegExp(
  String.raw`(?<![\w$.?"'\x60])(?:${AMBIENT_NETWORK_APIS.join('|')})\b`,
  'g',
);
const localeSensitiveMember = new RegExp(
  String.raw`(?:\.|\?\.)\s*(?:${LOCALE_SENSITIVE_APIS.join('|')})\s*\(`,
  'g',
);
const localeSensitiveIntl = new RegExp(String.raw`(?<![\w$."'\x60])Intl\s*(?:\.|\?\.)`, 'g');

/**
 * Replace comments and string/template literals with layout-preserving whitespace. A scanner that
 * skips this step reports every mention of `localeCompare` in a comment explaining why
 * `localeCompare` is banned — and the first person to hit that deletes the explanation.
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

function productionFiles(directory) {
  return files(directory).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
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

function packageSpecifierMatches(specifier, forbidden) {
  if (forbidden.endsWith('*')) return specifier.startsWith(forbidden.slice(0, -1));
  if (forbidden.endsWith('/')) return specifier.startsWith(forbidden);
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

function forbiddenImportsInFiles(sourceFiles, forbiddenPackages, forbiddenRoots = []) {
  return sourceFiles.flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const packageMatch = forbiddenPackages.some((forbidden) => packageSpecifierMatches(specifier, forbidden));
    const pathMatch = specifier.startsWith('.') && forbiddenRoots.some((forbiddenRoot) =>
      existsSync(forbiddenRoot) && inside(resolve(dirname(file), specifier), forbiddenRoot));
    return packageMatch || pathMatch ? [`${relative(root, file)} -> ${specifier}`] : [];
  })).sort();
}

function forbiddenImports(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  return forbiddenImportsInFiles(files(sourceRoot), forbiddenPackages, forbiddenRoots);
}

function ambientNetworkUses(sourceFiles) {
  return sourceFiles.flatMap((file) => [...executableSource(readFileSync(file, 'utf8'))
    .matchAll(ambientNetworkIdentifier)].map((match) => `${relative(root, file)} -> ${match[0]}`)).sort();
}

function localeSensitiveUses(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = executableSource(readFileSync(file, 'utf8'));
    return [
      ...[...source.matchAll(localeSensitiveMember)],
      ...[...source.matchAll(localeSensitiveIntl)],
    ].map((match) => `${relative(root, file)} -> ${match[0].trim()}`);
  }).sort();
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-policy-boundary-'));
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
    assert.equal(forbiddenImports(source, ['@jinn-network/'], [forbidden]).length, 5);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the comment and literal stripper keeps prose from tripping either sweep', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-policy-stripper-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'clean.ts'), [
      '// localeCompare and fetch are banned; this comment must not trip the scanner.',
      '/* Intl.Collator would make a digest depend on ICU data. */',
      'const prose = "fetch localeCompare Intl.Collator";',
      'export function compare(left, right) { return left < right ? -1 : 1; }',
    ].join('\n'));
    assert.deepEqual(localeSensitiveUses(files(source)), []);
    assert.deepEqual(ambientNetworkUses(files(source)), []);

    writeFileSync(join(source, 'dirty.ts'), [
      'left.localeCompare(right);',
      'new Intl.Collator("en-US").compare(left, right);',
      'fetch("https://example.test");',
    ].join('\n'));
    assert.equal(localeSensitiveUses([join(source, 'dirty.ts')]).length, 2);
    assert.equal(ambientNetworkUses([join(source, 'dirty.ts')]).length, 1);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('policy source boundaries hold: per-directory Jinn allow-list, no capability package, no path escape', () => {
  const allowedByDirectory = { identity: IDENTITY_ALLOWED_JINN, outcomes: OUTCOMES_ALLOWED_JINN };
  for (const directory of policyDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const allowed = allowedByDirectory[directory] ?? [];
    const forbiddenPackages = [
      ...POLICY_FOREIGN_PACKAGES,
      // Every OTHER policy package's own name is foreign to a directory unless allow-listed --
      // this is what stops `outcomes` silently reaching for `identity`'s siblings later, and
      // stops `identity` reaching for `outcomes`.
      ...policyDirectories
        .map((sibling) => `@jinn-network/policy-${sibling}`)
        .filter((name) => !allowed.includes(name)),
    ];
    assert.deepEqual(
      forbiddenImportsInFiles(productionFiles(source), forbiddenPackages, FORBIDDEN_ROOTS),
      [],
      `${directory} crosses a policy architecture boundary`,
    );
  }
});

test('outcomes actually imports its one approved Jinn dependency (positive control)', () => {
  // Without this, the boundary test above could pass vacuously if the dependency were silently
  // dropped -- an absent edge is not the same claim as an audited one.
  const production = productionFiles(join(packages, 'outcomes', 'src'));
  const importsIdentity = production.some((file) =>
    specifiers(readFileSync(file, 'utf8')).includes('@jinn-network/policy-identity'));
  assert.ok(importsIdentity, 'expected at least one production import of @jinn-network/policy-identity');
});

test('the foreign list bans by exact name and by wildcard family', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-policy-foreign-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import a from "@jinn-network/benchmarking-aggregate";',
      'import b from "@jinn-network/evidence-repository";',
      'import c from "@jinn-network/marketplace-binding";',
      'import d from "@jinn-network/task-curation";',
      'import e from "viem";',
    ].join('\n'));
    assert.equal(forbiddenImports(source, POLICY_FOREIGN_PACKAGES).length, 5);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('policy production source never uses ambient network APIs', () => {
  for (const directory of policyDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    assert.deepEqual(ambientNetworkUses(productionFiles(source)), [],
      `${directory} production source must be pure; it receives no I/O at all`);
  }
});

test('policy production source never orders or formats with the host locale', () => {
  for (const directory of policyDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    assert.deepEqual(localeSensitiveUses(productionFiles(source)), [],
      `${directory} production source must not depend on the host locale or ICU data; a sealed `
        + 'policy digest would differ between hosts. Use compareCodeUnitStrings.');
  }
});
