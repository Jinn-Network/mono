import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'trust');
// Extended by every later trust package task (T11 adds 'resolve').
const trustDirectories = ['core', 'testing'];

// Program ruling §7.9: trust-core's boundary guard allowlists exactly these
// three externals (@noble/hashes + zod, the evidence floor, plus @noble/curves
// for the I/O-free EOA/1271/ReCap ceremony signature recovery that lives in
// core). Everything else -- node:fs/net/http*/dgram/child_process/tls/dns,
// viem, and every @jinn-network/* package -- fails the allowlist rather than
// being enumerated in a ban list.
const CORE_ALLOWED_EXTERNALS = ['@noble/curves', '@noble/hashes', 'zod'];
const CORE_ALLOWED_DEPENDENCIES = ['@noble/curves', '@noble/hashes', 'zod'];
const CORE_ALLOWED_DEV_DEPENDENCIES = ['@types/node', 'typescript', 'vitest'];

const AMBIENT_NETWORK_APIS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
const ambientNetworkIdentifier = new RegExp(
  String.raw`(?<![\w$."'\x60])(?:${AMBIENT_NETWORK_APIS.join('|')})\b`,
  'g',
);
const ambientNetworkGlobal = new RegExp(
  String.raw`\b(?:globalThis|global)\s*(?:(?:\.|\?\.)\s*(?:${AMBIENT_NETWORK_APIS.join('|')})\b|(?:\?\.)?\s*\[\s*["'](?:${AMBIENT_NETWORK_APIS.join('|')})["']\s*\])`,
  'g',
);

// Canonical Trust bytes must not depend on the host locale or the bundled
// ICU data. These APIs all consult one or both, so an ordering or formatting
// decision made with them can change a record's SHA-256 digest between two
// hosts running identical code. Use a code-unit comparator instead; see any
// package's src/order.ts.
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

function ambientNetworkUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const identifiers = [...source.matchAll(ambientNetworkIdentifier)]
      .map((match) => `${relative(root, file)} -> ${match[0]}`);
    const globals = [...source.matchAll(ambientNetworkGlobal)]
      .map((match) => `${relative(root, file)} -> ${match[0]}`);
    return [...identifiers, ...globals];
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

function forbiddenImportsInFiles(sourceFiles, forbiddenPackages, forbiddenRoots = []) {
  return sourceFiles.flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const packageMatch = forbiddenPackages.some((forbidden) => forbidden.endsWith('/')
      ? specifier.startsWith(forbidden) : specifier === forbidden || specifier.startsWith(`${forbidden}/`));
    const pathMatch = specifier.startsWith('.') && forbiddenRoots.some((forbiddenRoot) =>
      insideForbiddenRoot(resolve(dirname(file), specifier), forbiddenRoot));
    return packageMatch || pathMatch ? [`${relative(root, file)} -> ${specifier}`] : [];
  })).sort();
}

function forbiddenImports(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  return forbiddenImportsInFiles(files(sourceRoot), forbiddenPackages, forbiddenRoots);
}

// Allowlist-shaped scanner (the mirror image of forbiddenImportsInFiles):
// used where a package's inventory is small enough to state positively
// ("only these externals") instead of as a ban list. A specifier's "root"
// strips any subpath (`@noble/hashes/sha2` -> `@noble/hashes`,
// `node:fs/promises` -> `node:fs`) before the allowlist membership check, so
// node: builtins, viem, and every @jinn-network/* name all fail membership
// in a three-entry allowlist without being separately enumerated.
function externalSpecifierRoot(specifier) {
  if (specifier.startsWith('.')) return null;
  if (specifier.startsWith('node:')) return specifier.split('/')[0];
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function disallowedExternalsInFiles(sourceFiles, allowedExternals) {
  return sourceFiles.flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const specifierRoot = externalSpecifierRoot(specifier);
    if (specifierRoot === null) return [];
    return allowedExternals.includes(specifierRoot) ? [] : [`${relative(root, file)} -> ${specifier}`];
  })).sort();
}

function manifest(directory) {
  return JSON.parse(readFileSync(join(packages, directory, 'package.json'), 'utf8'));
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-trust-boundary-'));
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
      'await import(// boundary', '  "@jinn-network/forbidden/line-comment");',
      'export { value } from /* first */ /* second */ "@jinn-network/forbidden/multiple-comments";',
      'await import(`@jinn-network/forbidden/template-dynamic`);',
      'require(`@jinn-network/forbidden/template-require`);',
      'import "../forbidden/local.js";',
    ].join('\n'));
    const findings = forbiddenImports(source, ['@jinn-network/'], [forbidden]);
    assert.equal(findings.length, 11);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the external-import allowlist scanner catches node builtins, subpaths, and forbidden packages', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-trust-allowlist-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import { sha256 } from "@noble/hashes/sha2.js";',
      'import { secp256k1 } from "@noble/curves/secp256k1.js";',
      'import { z } from "zod";',
      'import { createPublicClient } from "viem";',
      'import "node:fs";',
      'import "node:fs/promises";',
      'import "@jinn-network/evidence-protocol";',
      'import "./order.js";',
    ].join('\n'));
    const findings = disallowedExternalsInFiles(files(source), CORE_ALLOWED_EXTERNALS);
    // viem, node:fs, node:fs/promises, @jinn-network/evidence-protocol
    assert.equal(findings.length, 4);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('locale-sensitive API detection catches member calls, optional chaining, and Intl', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-trust-locale-boundary-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      ...LOCALE_SENSITIVE_APIS.flatMap((api) => [
        `left.${api}(right);`,
        `left?.${api}(right);`,
      ]),
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

test('trust-core production source imports only the allowed externals', () => {
  const source = join(packages, 'core', 'src');
  const production = files(source).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  assert.deepEqual(
    disallowedExternalsInFiles(production, CORE_ALLOWED_EXTERNALS),
    [],
    'trust-core production source may import only @noble/hashes, @noble/curves, and zod',
  );
});

test('trust-core manifest dependencies match the approved externals allowlist', () => {
  const coreManifest = manifest('core');
  assert.deepEqual(
    Object.keys(coreManifest.dependencies ?? {}).sort(),
    [...CORE_ALLOWED_DEPENDENCIES].sort(),
    'trust-core dependencies must be exactly @noble/hashes, @noble/curves, and zod',
  );
  const devDependencies = Object.keys(coreManifest.devDependencies ?? {}).sort();
  assert.deepEqual(
    devDependencies.filter((name) => !CORE_ALLOWED_DEV_DEPENDENCIES.includes(name)),
    [],
    'trust-core devDependencies must stay within the toolchain allowlist',
  );
  assert.deepEqual(Object.keys(coreManifest.optionalDependencies ?? {}), []);
  assert.deepEqual(Object.keys(coreManifest.peerDependencies ?? {}), []);
});

test('trust production source never uses ambient network APIs', () => {
  for (const directory of trustDirectories) {
    if (directory === 'resolve') continue; // resolve (T11) is the RPC package; it is exempt.
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(
      ambientNetworkUsesInFiles(production),
      [],
      `${directory} production source may not use ambient network APIs (fetch/WebSocket/EventSource/XMLHttpRequest)`,
    );
  }
});

test('trust production source never orders or formats with the host locale', () => {
  for (const directory of trustDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source)
      .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(
      localeSensitiveUsesInFiles(production),
      [],
      `${directory} production source must not depend on the host locale or ICU data; `
        + 'canonical Trust bytes would differ between hosts. Use src/order.ts.',
    );
  }
});
