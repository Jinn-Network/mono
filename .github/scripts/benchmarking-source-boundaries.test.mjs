import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'benchmarking');
const benchmarkingDirectories = ['records', 'testing', 'aggregate'];

// The whole benchmarking tree is forbidden to import any evidence-tree package, the two
// I/O-free evidence producer packages, any record-discovery package, and — critically — every
// marketplace package (program §10 extension: benchmarking/marketplace is the sole
// marketplace-importing package, and it lands only at M7, last). `records`/`aggregate`/`run`/
// `interop` NEVER import a marketplace package; only the M7 `marketplace` package carves out
// those imports when it registers.
const BENCHMARKING_FOREIGN_PACKAGES = [
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-contribution',
  '@jinn-network/evidence-retrieval',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/attestation-issuer',
  '@jinn-network/record-discovery-protocol',
  '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-testing',
  '@jinn-network/record-discovery-facts-evidence',
  '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-source-evidence-journal',
  // No `@jinn-network/marketplace-*` package exists yet (M7 is last, program §10 extension); the
  // family is banned by prefix so the ban holds the moment any such package registers.
  '@jinn-network/marketplace-*',
  'viem',
  'better-sqlite3',
  'kubo-rpc-client',
];

// A relative-path escape into the not-yet-created marketplace tree is caught the same way (a
// package-name ban alone would miss `import "../../../marketplace/binding/src/index.js"`).
const FORBIDDEN_ROOTS = [join(root, 'packages', 'marketplace')];

// records is tier 2, protocol-layer only (plan Task 1.1 Step 5 / F3): every other
// task-execution sibling is forbidden, same posture as profiles' boundary in the task-execution
// tree.
const TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_RECORDS = [
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-profiles',
];

// testing (the M2 kit) may additionally import task-execution-profiles (its miniature-run
// fixtures are profiles-conditioned, plan M2 gate); it may still not import the backend
// contract or the TEP testing kit itself from production `src/` (those would be devDependency
// concerns only, and this package declares neither).
const TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_TESTING = [
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-testing',
];

// aggregate (M3) imports records + trust-core only (plan M3 Task 3.1 Interfaces): no
// task-execution-* import at all, even though task-execution-protocol/profiles are transitive
// devDependencies (needed only to resolve benchmarking-testing's own portal deps under a
// standalone yarn project, never imported from aggregate/src).
const TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_AGGREGATE = [
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol',
];

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

// Canonical benchmarking bytes must not depend on the host locale or the bundled ICU data.
// These APIs all consult one or both, so an ordering or formatting decision made with them can
// change a record's SHA-256 digest between two hosts running identical code. Use a code-unit
// comparator instead; see records/src/order.ts.
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
// `@jinn-network/marketplace-*`, whose exact member names are not yet decided — no benchmarking
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
    `${relative(root, sourceRoot)} crosses a benchmarking architecture boundary`);
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-benchmarking-boundary-'));
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

test('the marketplace-family wildcard bans any future @jinn-network/marketplace-* package', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-benchmarking-marketplace-wildcard-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import { thing } from "@jinn-network/marketplace-binding";',
      'import { other } from "@jinn-network/marketplace-projector";',
    ].join('\n'));
    const findings = forbiddenImports(source, ['@jinn-network/marketplace-*']);
    assert.equal(findings.length, 2);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('benchmarking source boundaries remain one-way across the approved graph', () => {
  // records depends on task-execution-protocol only: every foreign package (including any
  // marketplace package) and every other task-execution sibling are forbidden.
  assertBoundary(
    join(packages, 'records', 'src'),
    [...BENCHMARKING_FOREIGN_PACKAGES, ...TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_RECORDS],
    FORBIDDEN_ROOTS,
  );
  // testing depends on records + task-execution-protocol + task-execution-profiles only.
  assertBoundary(
    join(packages, 'testing', 'src'),
    [...BENCHMARKING_FOREIGN_PACKAGES, ...TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_TESTING],
    FORBIDDEN_ROOTS,
  );
  // aggregate depends on records + trust-core only; never run, never any task-execution-*.
  assertBoundary(
    join(packages, 'aggregate', 'src'),
    [...BENCHMARKING_FOREIGN_PACKAGES, ...TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_AGGREGATE],
    FORBIDDEN_ROOTS,
  );
});

test('locale-sensitive API detection catches member calls, optional chaining, and Intl', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-benchmarking-locale-boundary-'));
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
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-benchmarking-network-boundary-'));
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

test('Benchmarking production source never uses ambient network APIs', () => {
  for (const directory of benchmarkingDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(ambientNetworkUsesInFiles(production), [], `${directory} production source must receive I/O through injected ports`);
  }
});

test('Benchmarking production source never orders or formats with the host locale', () => {
  for (const directory of benchmarkingDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source)
      .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(
      localeSensitiveUsesInFiles(production),
      [],
      `${directory} production source must not depend on the host locale or ICU data; `
        + 'canonical benchmarking bytes would differ between hosts. Use src/order.ts.',
    );
  }
});
