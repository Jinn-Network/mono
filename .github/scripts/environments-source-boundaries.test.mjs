import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'environments');
const environmentDirectories = ['record'];

// `packages/environments/record` is tier 2: records and meaning, no behaviour. It declares
// ZERO Jinn runtime dependencies (design §3.3: zod + noble-class primitives only), so every
// Jinn package family is forbidden from production source. `@jinn-network/evidence-protocol`
// is a test-only devDependency for the seal-equivalence fixtures (program §5 contract 3) and
// appears in the testing-region allowance below, never in production source.
const ENVIRONMENTS_FOREIGN_PACKAGES = [
  '@jinn-network/autopilot',
  '@jinn-network/benchmarking-*',
  '@jinn-network/client',
  '@jinn-network/core',
  '@jinn-network/evidence-*',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/indexer',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace-*',
  '@jinn-network/plugin',
  '@jinn-network/record-discovery-*',
  '@jinn-network/sdk',
  '@jinn-network/task-execution-*',
  '@jinn-network/trust-*',
];

// A relative-path escape into another tree is caught the same way a package-name ban is —
// `import "../../evidence/protocol/src/index.js"` would otherwise slip past.
const FORBIDDEN_ROOTS = [
  join(root, 'apps'),
  join(root, 'client'),
  ...['autopilot', 'benchmarking', 'core', 'discovery', 'evidence', 'indexer',
    'indexer-enrichment', 'layer', 'marketplace', 'plugin', 'sdk', 'task-execution', 'trust']
    .map((directory) => join(root, 'packages', directory)),
];

// Custody law (program §5 contract 4): the record package is pure. No process spawning, no
// sockets, no database, and no filesystem — with one exception, `src/fixtures.ts`, which
// loads the package's own bundled fixture corpus and belongs to the testing region.
const NODE_IO_MODULES = [
  'node:child_process', 'node:dgram', 'node:dns', 'node:fs', 'node:fs/promises',
  'node:http', 'node:http2', 'node:https', 'node:net', 'node:tls', 'node:worker_threads',
];

const RECORD_ALLOWED_DEPENDENCIES = ['@noble/hashes', 'zod'];
const RECORD_ALLOWED_DEV_DEPENDENCIES = [
  '@jinn-network/evidence-protocol', '@types/node', 'ajv', 'canonicalize', 'typescript', 'vitest',
];
const RECORD_ALLOWED_PEER_DEPENDENCIES = ['vitest'];

const AMBIENT_NETWORK_APIS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
const ambientNetworkIdentifier = new RegExp(
  String.raw`(?<![\w$.?"'\x60])(?:${AMBIENT_NETWORK_APIS.join('|')})\b`,
  'g',
);
const ambientNetworkGlobal = new RegExp(
  String.raw`\b(?:globalThis|global|window|self)\s*(?:(?:\.|\?\.)\s*(?:${AMBIENT_NETWORK_APIS.join('|')})\b|(?:\?\.)?\s*\[\s*(?:${AMBIENT_NETWORK_APIS.map((api) => `(?:"${api}"|'${api}'|\x60${api}\x60)`).join('|')})\s*\])`,
  'g',
);

/** Replace comments and inert literals with whitespace without changing code layout. Template
 * raw text is inert, while every `${...}` expression is recursively retained as executable code.
 * Literal computed browser members are retained only in their member-name position. */
function executableSource(source) {
  let result = '';
  const appendInert = (char) => { result += char === '\n' || char === '\r' ? char : ' '; };
  // `result` has already replaced every preceding comment with layout-preserving whitespace and
  // every inert literal with whitespace. This gives the member check arbitrary trivia support
  // without a fixed raw-source look-behind or a regex over unbounded, unparsed source text.
  const literalMemberContext = () => /\b(?:globalThis|global|window|self)\s*(?:\?\.\s*)?\[\s*$/u.test(result);
  const scanQuoted = (index, quote, retain) => {
    for (let cursor = index; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (char === '\\') {
        if (retain) result += source.slice(cursor, cursor + 2);
        else { appendInert(char); appendInert(source[cursor + 1] ?? ''); }
        cursor += 1;
        continue;
      }
      if (retain) result += char;
      else appendInert(char);
      if (char === quote && cursor !== index) return cursor + 1;
    }
    return source.length;
  };
  const scanTemplate = (index, retainRaw) => {
    let cursor = index;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (char === '\\') {
        if (retainRaw) result += source.slice(cursor, cursor + 2);
        else { appendInert(char); appendInert(next ?? ''); }
        cursor += 2;
      } else if (char === '`') {
        if (retainRaw) result += char;
        else appendInert(char);
        return cursor + 1;
      } else if (char === '$' && next === '{') {
        result += '${';
        cursor = scanCode(cursor + 2, '}');
        result += '}';
        cursor += 1;
      } else {
        if (retainRaw) result += char;
        else appendInert(char);
        cursor += 1;
      }
    }
    return cursor;
  };
  const scanCode = (index, terminator = undefined) => {
    let cursor = index;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (terminator === '}' && char === '}') return cursor;
      if (char === '/' && next === '/') {
        appendInert(char); appendInert(next); cursor += 2;
        while (cursor < source.length && source[cursor] !== '\n' && source[cursor] !== '\r') { appendInert(source[cursor]); cursor += 1; }
      } else if (char === '/' && next === '*') {
        appendInert(char); appendInert(next); cursor += 2;
        while (cursor < source.length && !(source[cursor] === '*' && source[cursor + 1] === '/')) { appendInert(source[cursor]); cursor += 1; }
        if (cursor < source.length) { appendInert(source[cursor]); appendInert(source[cursor + 1]); cursor += 2; }
      } else if (char === '"' || char === "'") {
        const retain = literalMemberContext();
        cursor = scanQuoted(cursor, char, retain);
      } else if (char === '`') {
        const retain = literalMemberContext();
        if (retain) result += char;
        else appendInert(char);
        cursor = scanTemplate(cursor + 1, retain);
      } else if (char === '{') {
        result += char;
        cursor = scanCode(cursor + 1, '}');
        if (cursor < source.length) { result += '}'; cursor += 1; }
      } else {
        result += char;
        cursor += 1;
      }
    }
    return cursor;
  };
  scanCode(0);
  return result;
}

// Canonical environments bytes must not depend on the host locale or the bundled ICU data.
// These APIs all consult one or both, so an ordering or formatting decision made with them can
// change a record's SHA-256 digest between two hosts running identical code. Use a code-unit
// comparator instead; see record/src/order.ts.
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
    const source = executableSource(readFileSync(file, 'utf8'));
    return [
      ...[...source.matchAll(localeSensitiveMember)],
      ...[...source.matchAll(localeSensitiveIntl)],
    ].map((match) => `${relative(root, file)} -> ${match[0].trim()}`);
  }).sort();
}

function ambientNetworkUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = executableSource(readFileSync(file, 'utf8'));
    const identifiers = [...source.matchAll(ambientNetworkIdentifier)]
      .map((match) => `${relative(root, file)} -> ${match[0]}`);
    const globals = [...source.matchAll(ambientNetworkGlobal)]
      .map((match) => `${relative(root, file)} -> ${match[0].replace(/\s+/g, ' ').trim()}`);
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

// A forbidden entry ending in `*` bans a whole package-name family by prefix (used for
// `@jinn-network/marketplace-*`, whose exact member names are not yet decided — no environments
// package may import ANY future marketplace package). A forbidden entry ending in `/` bans by
// literal prefix; otherwise the entry must match the specifier exactly or as its subpath root.
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
  const production = files(sourceRoot).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  assert.deepEqual(forbiddenImportsInFiles(production, forbiddenPackages, forbiddenRoots), [],
    `${relative(root, sourceRoot)} crosses an environments architecture boundary`);
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-environments-boundary-'));
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

test('environments source boundaries remain one-way across the approved graph', () => {
  const record = join(packages, 'record');
  const recordSource = join(record, 'src');
  const testingEntry = join(recordSource, 'testing.ts');
  const fixtureLoaders = join(recordSource, 'fixtures.ts');
  const testRegex = /\.test\.[cm]?[jt]sx?$/u;

  const allFiles = files(recordSource);
  const testingFiles = allFiles.filter((file) =>
    file === testingEntry || file === fixtureLoaders || testRegex.test(file));
  const productionFiles = allFiles.filter((file) => !testingFiles.includes(file));

  // Production source: no Jinn package at all, no foreign tree by relative path, no vitest,
  // no I/O module, and no reach into the testing region.
  assert.deepEqual(
    forbiddenImportsInFiles(
      productionFiles,
      [...ENVIRONMENTS_FOREIGN_PACKAGES, ...NODE_IO_MODULES, 'vitest'],
      FORBIDDEN_ROOTS,
    ),
    [],
    'environment-record production source must not import Jinn packages, vitest, or I/O modules',
  );
  assert.deepEqual(
    forbiddenImportsInFiles([join(recordSource, 'index.ts')], [], [testingEntry, fixtureLoaders]),
    [],
    'the root entrypoint must not re-export testing.ts or fixtures.ts',
  );

  // Testing region: the seal-equivalence fixtures may import evidence-protocol and
  // canonicalize; nothing else Jinn, and no other tree by relative path.
  assert.deepEqual(
    forbiddenImportsInFiles(
      testingFiles,
      ENVIRONMENTS_FOREIGN_PACKAGES.filter((entry) => entry !== '@jinn-network/evidence-*'),
      FORBIDDEN_ROOTS,
    ),
    [],
    'environment-record testing files must not cross into foreign package roots',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(testingFiles, ['@jinn-network/evidence-discovery',
      '@jinn-network/evidence-repository', '@jinn-network/evidence-derivation',
      '@jinn-network/evidence-local-runtime', '@jinn-network/evidence-publication']),
    [],
    'only evidence-protocol is admitted into the testing region, for seal equivalence',
  );

  // `node:fs/promises` is permitted in exactly one file.
  const fsUsers = forbiddenImportsInFiles(allFiles, ['node:fs', 'node:fs/promises'])
    .filter((finding) => !finding.startsWith(relative(root, fixtureLoaders)));
  assert.deepEqual(fsUsers, [],
    'only src/fixtures.ts may touch the filesystem, and only to read this package\'s own corpus');

  // Manifest shape.
  const manifest = JSON.parse(readFileSync(join(record, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(),
    ['.', './fixtures/*', './schemas/*', './testing']);
  assert.deepEqual(manifest.exports['.'],
    { import: './dist/index.js', types: './dist/index.d.ts' });
  assert.deepEqual(manifest.exports['./testing'],
    { import: './dist/testing.js', types: './dist/testing.d.ts' });
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), RECORD_ALLOWED_DEPENDENCIES);
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}).sort(), RECORD_ALLOWED_DEV_DEPENDENCIES);
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), RECORD_ALLOWED_PEER_DEPENDENCIES);
  assert.deepEqual(manifest.peerDependenciesMeta, { vitest: { optional: true } });
});

test('locale-sensitive API detection catches member calls, optional chaining, and Intl', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-environments-locale-boundary-'));
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

test('ambient-network detection scans executable template interpolation and literal computed browser members', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-environments-network-boundary-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'fetch("https://example.test");',
      'new XMLHttpRequest();',
      'new WebSocket("wss://example.test");',
      'new EventSource("https://example.test");',
      'globalThis.fetch("https://example.test");',
      'window?.fetch("https://example.test");',
      'self.fetch("https://example.test");',
      'window["fetch"]("https://example.test");',
      "self['WebSocket']('wss://example.test');",
      'new globalThis[`XMLHttpRequest`]();',
      'const interpolation = `${fetch("https://example.test")}`;',
      'const nested = `${`${self["WebSocket"]("wss://example.test")}`}`;',
      'const mixed = `${window["fetch"]("https://example.test")}`;',
      `window${" ".repeat(81)}["fetch"]("https://example.test");`,
      'globalThis /* member */ ?. /* computed */ ["EventSource"]("https://example.test");',
      'const nestedComputed = `${`${self /* member */ ?. [\'WebSocket\']("wss://example.test")}`}`;',
      '// XMLHttpRequest is forbidden, but this comment is inert.',
      '/* window.fetch and self.WebSocket are inert comments. */',
      'const prose = "fetch globalThis.fetch window.XMLHttpRequest self.WebSocket";',
      'const raw = `fetch window["fetch"] self[\'WebSocket\'] globalThis[\\`XMLHttpRequest\\`]`;',
      `const longRaw = \`window${" ".repeat(81)}["fetch"]\`;`,
      'const inert = "globalThis /* member */ ?. [\'EventSource\']";',
    ].join('\n'));
    const findings = ambientNetworkUsesInFiles(files(source)).map((finding) => finding.slice(finding.indexOf('src/source.ts')));
    assert.deepEqual(findings, [
      'src/source.ts -> EventSource',
      'src/source.ts -> WebSocket',
      'src/source.ts -> XMLHttpRequest',
      'src/source.ts -> fetch',
      'src/source.ts -> fetch',
      'src/source.ts -> globalThis.fetch',
      'src/source.ts -> globalThis[`XMLHttpRequest`]',
      'src/source.ts -> self.fetch',
      'src/source.ts -> self["WebSocket"]',
      "src/source.ts -> self['WebSocket']",
      'src/source.ts -> window?.fetch',
      'src/source.ts -> window["fetch"]',
      'src/source.ts -> window["fetch"]',
      'src/source.ts -> window ["fetch"]',
      'src/source.ts -> globalThis ?. ["EventSource"]',
      "src/source.ts -> self ?. ['WebSocket']",
    ].sort());
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('Environments production source never uses ambient network APIs', () => {
  for (const directory of environmentDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(ambientNetworkUsesInFiles(production), [], `${directory} production source must receive I/O through injected ports`);
  }
});

test('Environments production source never orders or formats with the host locale', () => {
  for (const directory of environmentDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source)
      .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(
      localeSensitiveUsesInFiles(production),
      [],
      `${directory} production source must not depend on the host locale or ICU data; `
        + 'canonical environments bytes would differ between hosts. Use src/order.ts.',
    );
  }
});

// Program §5 contract 8: no API, log line, or doc in this package may say "deterministic" or
// "verified" without the K/controls or trust-policy qualification the design gives those
// words. This package makes NEITHER claim — it describes an environment, it does not assess
// one — so the honest gate here is: the words do not appear as unqualified assertions in
// production source or in the README.
const BOUNDED_CLAIM_WORDS = /\b(deterministic|deterministically|verified|guaranteed|reliable)\b/iu;

test('environments source and docs make no unqualified determinism or verification claim', () => {
  const record = join(packages, 'record');
  const candidates = [
    ...files(join(record, 'src')).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file)),
    join(record, 'README.md'),
  ].filter((file) => existsSync(file));

  const findings = candidates.flatMap((file) => readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      if (!BOUNDED_CLAIM_WORDS.test(line)) return [];
      // A line is clean when it explicitly bounds the claim: it names the attestation layer
      // that owns it, or negates the claim outright.
      const bounded = /attestation|MUST NOT require|never|not\b|bounded|K consecutive|no claim/iu
        .test(line);
      return bounded ? [] : [`${relative(root, file)}:${index + 1} -> ${line.trim()}`];
    }));

  assert.deepEqual(findings, [],
    'unqualified determinism/verification language: the record asserts what an environment IS, '
    + 'never that it works. Bound the claim or move it to the attestation layer.');
});
