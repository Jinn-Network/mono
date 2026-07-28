import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'discovery');
const discoveryDirectories = ['protocol', 'testing', 'serve', 'client', 'facts/evidence', 'facts/trust'];   // grows per package task
const APPLICATION_AND_LEGACY_ROOTS = [
  join(root, 'apps'), join(root, 'client'),
  ...['autopilot', 'core', 'indexer', 'indexer-enrichment', 'layer', 'plugin', 'sdk']
    .map((d) => join(root, 'packages', d)),
];
// protocol is kind-agnostic: may import trust-core, nothing else Jinn; no TEP/Evidence record packages.
const PROTOCOL_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-testing',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery', '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
];
// testing may import only record-discovery-protocol; no serve/client/facts
// leaves, and (like protocol) no TEP/Evidence record packages.
const TESTING_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery', '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
];
// serve depends on protocol (production) + testing (dev, conformance kit
// only); no client, no facts/* leaves, no TEP/Evidence record packages.
const SERVE_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-client',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery', '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
];
// client depends on protocol (production) + trust-core (production, the
// verification driver) + testing (dev, conformance kit only); no serve, no
// facts/* leaves (host-assembled runtime injection only, Task 18 note), no
// TEP/Evidence record packages.
const CLIENT_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery', '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
];
// facts/evidence carries the one sanctioned edge between the discovery tree
// and the Evidence Protocol record-kind tree (design §12; plan Task 22):
// protocol + evidence-discovery (root export AND its "/indexer" subpath,
// where `validateAndProjectEvidenceRecord` lives) + evidence-repository are
// allowed; no serve/client, no other facts/* leaf, no TEP, no trust.
const FACTS_EVIDENCE_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-trust', '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
];
// facts/trust carries the one sanctioned edge between the discovery tree
// and the Trust Layer record-kind tree (design §12; plan Task 23): protocol
// + trust-core are allowed; no serve/client, no other facts/* leaf, no TEP,
// no evidence.
const FACTS_TRUST_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/evidence-discovery',
];

const AMBIENT_NETWORK_APIS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
const ambientNetworkIdentifier = new RegExp(
  String.raw`(?<![\w$."'\x60])(?:${AMBIENT_NETWORK_APIS.join('|')})\b`,
  'g',
);
const ambientNetworkGlobal = new RegExp(
  String.raw`\b(?:globalThis|global)\s*(?:(?:\.|\?\.)\s*(?:${AMBIENT_NETWORK_APIS.join('|')})\b|(?:\?\.)?\s*\[\s*["'](?:${AMBIENT_NETWORK_APIS.join('|')})["']\s*\])`,
  'g',
);

// Canonical Discovery bytes must not depend on the host locale or the bundled
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

function assertBoundary(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  assert.deepEqual(forbiddenImports(sourceRoot, forbiddenPackages, forbiddenRoots), [],
    `${relative(root, sourceRoot)} crosses a record discovery architecture boundary`);
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-discovery-boundary-'));
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

test('locale-sensitive API detection catches member calls, optional chaining, and Intl', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-discovery-locale-boundary-'));
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

test('record-discovery-protocol production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'protocol', 'src'), PROTOCOL_FORBIDDEN_PACKAGES);
});

test('record-discovery-testing production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'testing', 'src'), TESTING_FORBIDDEN_PACKAGES);
});

test('record-discovery-serve production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'serve', 'src'), SERVE_FORBIDDEN_PACKAGES);
});

test('record-discovery-client production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'client', 'src'), CLIENT_FORBIDDEN_PACKAGES);
});

test('record-discovery-facts-evidence production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'facts', 'evidence', 'src'), FACTS_EVIDENCE_FORBIDDEN_PACKAGES);
});

test('record-discovery-facts-trust production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'facts', 'trust', 'src'), FACTS_TRUST_FORBIDDEN_PACKAGES);
});

test('record discovery production source never uses ambient network APIs', () => {
  for (const directory of discoveryDirectories) {
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

test('record discovery production source never orders or formats with the host locale', () => {
  for (const directory of discoveryDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source)
      .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(
      localeSensitiveUsesInFiles(production),
      [],
      `${directory} production source must not depend on the host locale or ICU data; `
        + 'canonical Discovery bytes would differ between hosts. Use src/order.ts.',
    );
  }
});
