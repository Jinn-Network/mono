import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'discovery');
const discoveryDirectories = ['protocol', 'testing', 'serve', 'publication', 'client', 'facts/evidence', 'facts/trust', 'facts/task-execution', 'facts/benchmarking', 'facts/environments', 'facts/chain-environments', 'sources/evidence-journal', 'transport-http'];   // grows per package task
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
  '@jinn-network/environment-record',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
];
// testing may import only record-discovery-protocol; no serve/client/facts
// leaves, and (like protocol) no TEP/Evidence record packages.
const TESTING_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery', '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
  '@jinn-network/environment-record',
];
// serve depends on protocol (production) + testing (dev, conformance kit
// only); no client, no facts/* leaves, no TEP/Evidence record packages.
const SERVE_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-client',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery', '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
];
// publication composes only discovery protocol/serve ports. It must remain
// kind-neutral: facts leaves and every record/product tree are forbidden.
const PUBLICATION_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-client', '@jinn-network/record-discovery-testing',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution', '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/record-discovery-facts-environments', '@jinn-network/record-discovery-facts-chain-environments',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/evidence-discovery',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles', '@jinn-network/benchmarking-records',
];
// client depends on protocol (production) + trust-core (production, the
// verification driver) + testing (dev, conformance kit only); no serve, no
// facts/* leaves (host-assembled runtime injection only, Task 18 note), no
// TEP/Evidence record packages.
const CLIENT_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery', '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
];
// facts/evidence carries the one sanctioned edge between the discovery tree
// and the Evidence Protocol record-kind tree (design §12; plan Task 22):
// protocol + evidence-discovery (root export AND its "/indexer" subpath,
// where `validateAndProjectEvidenceRecord` lives) + evidence-repository are
// allowed; no serve/client, no other facts/* leaf, no TEP, no trust.
const FACTS_EVIDENCE_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-trust', '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
];
// facts/trust carries the one sanctioned edge between the discovery tree
// and the Trust Layer record-kind tree (design §12; plan Task 23): protocol
// + trust-core are allowed; no serve/client, no other facts/* leaf, no TEP,
// no evidence.
const FACTS_TRUST_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/evidence-discovery',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
];
// facts/task-execution carries the one sanctioned edge between the
// discovery tree and the Task Execution Protocol record-kind tree (design
// §12; plan Task 24; program §6.5 single-leaf folding): protocol +
// task-execution-protocol + task-execution-profiles are allowed (see the
// inventory guard's dependency-graph comment for why both task-execution
// packages are direct deps); no serve/client, no other facts/* leaf, no
// trust, no evidence.
const FACTS_TASK_EXECUTION_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-testing',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/evidence-discovery',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
];
// facts/benchmarking carries the one sanctioned edge between the discovery
// tree and the Benchmarking Application record-kind tree (design §11/§15;
// plan M6; program §6 confirmation item 4 / §7.128–§7.130): protocol +
// benchmarking-records are allowed; no serve/client, no other facts/* leaf,
// no TEP/trust/evidence/marketplace.
const FACTS_BENCHMARKING_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/evidence-discovery',
  '@jinn-network/marketplace-binding', '@jinn-network/marketplace-projector',
  '@jinn-network/marketplace-pipeline', '@jinn-network/marketplace-testing',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
];
// facts/environments carries the one sanctioned edge between the discovery tree and the
// environments record-kind tree (discovery design §12): protocol + environment-record are
// allowed; no serve/client, no other facts/* leaf, no TEP, no evidence, no benchmarking.
const FACTS_ENVIRONMENTS_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/benchmarking-records',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/evidence-discovery',
  '@jinn-network/record-discovery-facts-chain-environments',
];
// facts/chain-environments carries the one sanctioned edge between the discovery tree and the
// chain-environment and information-world record-kind trees (discovery design §12): protocol +
// chain-environment-record + information-world are allowed; no serve/client, no other facts/*
// leaf, no TEP, no evidence, no benchmarking, and not the SWE environment-record package either
// — the chain kinds are siblings of it, not extensions of it.
const FACTS_CHAIN_ENVIRONMENTS_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-evidence',
  '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-source-evidence-journal',
  '@jinn-network/environment-record',
  '@jinn-network/environment-verification',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/evidence-protocol',
  '@jinn-network/benchmarking-records',
  '@jinn-network/trust-core',
];
// sources/evidence-journal carries the rule-widened sanctioned edge between
// the discovery tree and the Evidence Protocol record-kind tree at the
// `sources/*` leaf layer (design §11; plan Task 25; program §6 confirmation
// 4 / Finding F7: "leaf packages under packages/discovery/ (facts/*,
// sources/*) are the only places a discovery edge and a record-kind edge
// meet"): protocol + serve + evidence-discovery + evidence-repository are
// allowed (plus record-discovery-testing, the M3 conformance kit devDep
// every serve-adjacent package uses for `runSourceConformance`); no client,
// no facts/* leaf, no TEP, no trust.
const SOURCE_EVIDENCE_JOURNAL_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust', '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
];

// transport-http is the tier-3 HTTP adapter: it implements serve's
// BlobStore/PingTransport ports and client's Transport/StreamTransport
// ports, so it is the one discovery package allowed to reference BOTH
// sides of the serve/client boundary -- by `import type` only, which is
// why neither name appears below. Everything else stays forbidden: no
// facts/* leaf, no sources/* leaf, no record-kind tree, no trust
// package (trust-core is a shadow devDependency for yarn's per-project
// resolution only; this package's source never imports it).
const TRANSPORT_HTTP_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/record-discovery-source-evidence-journal',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/evidence-discovery',
  '@jinn-network/marketplace-binding', '@jinn-network/marketplace-projector',
  '@jinn-network/marketplace-pipeline', '@jinn-network/marketplace-testing',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-facts-chain-environments',
];

// Finding F1 (plan docs/superpowers/plans/2026-07-30-discovery-transport-http.md):
// the ambient-network ban below is what keeps every OTHER discovery
// package injectable and testable without a network. transport-http is
// the package that supplies those very ports, so the ban is replaced
// there with a tighter allowlist: only these three modules may name an
// ambient network API, and every other file in the tree (including every
// other file in transport-http) stays under the original ban.
const AMBIENT_NETWORK_ALLOWED_FILES = new Set([
  'packages/discovery/transport-http/src/fetch-transport.ts',
  'packages/discovery/transport-http/src/sse-transport.ts',
  'packages/discovery/transport-http/src/ping-transport.ts',
]);

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

// A module specifier is a file PATH, not a use of an ambient API: the
// package barrel's `export * from "./fetch-transport.js"` names a file,
// and no string in a `from` / `import()` / `require()` clause can ever be
// a call. Blank those specifiers before the identifier scan so the ban
// stays about code rather than about what a module is named. Everything
// else stays in scope, comments deliberately included -- the scan is raw
// text, and that conservatism is the point.
const MODULE_SPECIFIER = new RegExp(
  String.raw`(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'\x60])(?:[^"'\x60\\\n]|\\.)*?\2`,
  'g',
);

function withoutModuleSpecifiers(source) {
  return source.replace(MODULE_SPECIFIER, (_match, clause, quote) => `${clause}${quote}${quote}`);
}

function ambientNetworkUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = withoutModuleSpecifiers(readFileSync(file, 'utf8'));
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

test('record-publication production source stays within its kind-neutral architecture boundary', () => {
  assertBoundary(join(packages, 'publication', 'src'), PUBLICATION_FORBIDDEN_PACKAGES);
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

test('record-discovery-facts-task-execution production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'facts', 'task-execution', 'src'), FACTS_TASK_EXECUTION_FORBIDDEN_PACKAGES);
});

test('record-discovery-facts-benchmarking production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'facts', 'benchmarking', 'src'), FACTS_BENCHMARKING_FORBIDDEN_PACKAGES);
});

test('record-discovery-facts-environments production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'facts', 'environments', 'src'), FACTS_ENVIRONMENTS_FORBIDDEN_PACKAGES);
});

test('record-discovery-facts-chain-environments production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'facts', 'chain-environments', 'src'), FACTS_CHAIN_ENVIRONMENTS_FORBIDDEN_PACKAGES);
});

test('record-discovery-source-evidence-journal production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'sources', 'evidence-journal', 'src'), SOURCE_EVIDENCE_JOURNAL_FORBIDDEN_PACKAGES);
});

test('record-discovery-transport-http production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'transport-http', 'src'), TRANSPORT_HTTP_FORBIDDEN_PACKAGES);
});

test('record discovery ambient network APIs appear only in transport-http allowlisted transport modules', () => {
  const offenders = [];
  for (const directory of discoveryDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    for (const finding of ambientNetworkUsesInFiles(production)) {
      const [file] = finding.split(' -> ');
      if (AMBIENT_NETWORK_ALLOWED_FILES.has(file)) continue;
      offenders.push(finding);
    }
  }
  assert.deepEqual(offenders, [],
    'only transport-http\'s allowlisted transport modules may use ambient network APIs '
      + '(fetch/WebSocket/EventSource/XMLHttpRequest); every other discovery module takes them as injected ports');
});

test('every ambient-network allowlist entry names a real transport-http module', () => {
  for (const allowed of AMBIENT_NETWORK_ALLOWED_FILES) {
    assert.ok(existsSync(join(root, allowed)),
      `stale ambient-network allowlist entry: ${allowed}`);
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
