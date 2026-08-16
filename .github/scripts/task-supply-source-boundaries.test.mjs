import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'task-supply');
const taskSupplyDirectories = ['admission', 'chain-scenarios', 'curation', 'derivation', 'posting'];

// The whole task-supply tree is forbidden the frozen trio, every evidence/discovery/marketplace
// package, every task-execution package, and every chain/storage client. Admission additionally
// may never import an environment-verification or attestation package (design §7.1: admission is
// attestation-agnostic; program contract 7). C4/C5/C6 carve out their own allowances when they
// land — C5 is the only future package that may import `@jinn-network/marketplace-binding`.
const TASK_SUPPLY_FOREIGN_PACKAGES = [
  '@jinn-network/core',
  '@jinn-network/plugin',
  '@jinn-network/jinn-layer',
  '@jinn-network/environment-verification',
  '@jinn-network/attestation-issuer',
  '@jinn-network/evidence-*',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/record-discovery-*',
  '@jinn-network/marketplace-*',
  '@jinn-network/task-execution-*',
  '@jinn-network/benchmarking-*',
  'viem',
  'better-sqlite3',
  'kubo-rpc-client',
  'dockerode',
];

// Relative-path escapes into the legacy tree, the marketplace tree, and the sibling
// verification package are caught the same way a package-name ban would not catch them.
const FORBIDDEN_ROOTS = [
  join(root, 'operator'),
  join(root, 'packages', 'marketplace'),
  join(root, 'packages', 'environments', 'verification'),
];

// Admission's approved task-execution imports are exactly the portable protocol and profile
// packages used to build and validate its deterministic prediction snapshot. Every other
// task-execution package remains denied by family-derived default.
const ADMISSION_TASK_EXECUTION_ALLOWED = [
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol',
];

const ADMISSION_FORBIDDEN_EXTRA = [
  '@jinn-network/task-derivation',
  '@jinn-network/task-posting',
  '@jinn-network/task-curation',
];

function admissionForbiddenPackages(allowed = ADMISSION_TASK_EXECUTION_ALLOWED) {
  return [
    ...TASK_SUPPLY_FOREIGN_PACKAGES.filter((forbidden) => forbidden !== '@jinn-network/task-execution-*'),
    ...familyMembers('task-execution').filter((name) => !allowed.includes(name)).sort(),
    ...ADMISSION_FORBIDDEN_EXTRA,
  ];
}

// Derivation's pinned output IS sealed Task + EvaluationSpec pairs, which only the packages that
// own those two kinds can produce (`sealTask`, `sealEvaluationSpec`). So the tree-wide
// `@jinn-network/task-execution-*` ban is carved out for exactly the two packages that own that
// sealing, by exact name — the family wildcard still bans every other task-execution package.
// Planning Finding (a): the design's §3.3 diagram omits this tier-3 -> tier-2 edge.
const DERIVATION_TASK_EXECUTION_ALLOWED = [
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol',
];

// Derivation additionally may never import the two task-supply packages downstream of it, nor
// trust-core: its dependency on admission is types-only and it re-implements its own canonical
// JSON and digesting per the house per-package rule (program contract 3).
const DERIVATION_FORBIDDEN_EXTRA = [
  '@jinn-network/task-posting',
  '@jinn-network/task-curation',
  '@jinn-network/trust-core',
];

// chain-scenarios seals Task + state-predicate EvaluationSpec pairs, so it needs the same
// two task-execution packages derivation does. It additionally may never import the two
// chain capability packages: materialization and replay are the HOST's job (design §3 —
// the runtime surface is public, and this package is not one of its four consumers).
const CHAIN_SCENARIOS_TASK_EXECUTION_ALLOWED = [
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol',
];

const CHAIN_SCENARIOS_FORBIDDEN_EXTRA = [
  '@jinn-network/chain-environment-verification',
  '@jinn-network/chain-state-extraction',
  '@jinn-network/task-curation',
  '@jinn-network/task-posting',
  '@jinn-network/trust-core',
];

function chainScenariosForbiddenPackages(allowed = CHAIN_SCENARIOS_TASK_EXECUTION_ALLOWED) {
  const stillForbidden = familyMembers('task-execution')
    .filter((name) => !allowed.includes(name)).sort();
  return [
    ...TASK_SUPPLY_FOREIGN_PACKAGES.filter((forbidden) => forbidden !== '@jinn-network/task-execution-*'),
    ...stillForbidden,
    ...CHAIN_SCENARIOS_FORBIDDEN_EXTRA,
  ];
}

/**
 * The tree-wide `@jinn-network/task-execution-*` wildcard, replaced by an explicit ban on every
 * task-execution package that is NOT in `allowed`. The replacement list is read off the tree, so a
 * task-execution package added later is banned by default rather than silently admitted.
 */
function derivationForbiddenPackages(allowed) {
  const taskExecutionRoot = join(root, 'packages', 'task-execution');
  const siblings = existsSync(taskExecutionRoot)
    ? readdirSync(taskExecutionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(taskExecutionRoot, entry.name, 'package.json')))
      .map((entry) => JSON.parse(readFileSync(join(taskExecutionRoot, entry.name, 'package.json'), 'utf8')).name)
    : [];
  const stillForbidden = siblings.filter((name) => !allowed.includes(name)).sort();
  return [
    ...TASK_SUPPLY_FOREIGN_PACKAGES.filter((forbidden) => forbidden !== '@jinn-network/task-execution-*'),
    ...stillForbidden,
    ...DERIVATION_FORBIDDEN_EXTRA,
  ];
}

// posting is an application over the binding (design §3.3): it consumes `@jinn-network/
// marketplace-binding` (the posting mechanics plus the D7 on-ramp adapters, supply plan finding
// F7) and `@jinn-network/task-execution-protocol` (Submission sealing). It never imports
// admission (it carries the receipt by digest and never re-decides admission), never the
// environment tree (it reads no environment record), never a discovery or trust package (posting
// signs nothing itself), and never a chain client of its own — every viem client reaches it
// through the injected marketplace ports.
const POSTING_MARKETPLACE_ALLOWED = ['@jinn-network/marketplace-binding'];
const POSTING_TASK_EXECUTION_ALLOWED = ['@jinn-network/task-execution-protocol'];

const POSTING_FORBIDDEN_EXTRA = [
  '@jinn-network/task-admission',
  '@jinn-network/task-curation',
  '@jinn-network/trust-core',
  '@jinn-network/trust-resolve',
  '@jinn-network/trust-testing',
];

/**
 * Read the member names of a package family off the tree, so a package added to that family
 * later is banned by default rather than silently admitted by a stale literal list.
 */
function familyMembers(treeDirectory) {
  const familyRoot = join(root, 'packages', treeDirectory);
  if (!existsSync(familyRoot)) return [];
  return readdirSync(familyRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(familyRoot, entry.name, 'package.json')))
    .map((entry) => JSON.parse(readFileSync(join(familyRoot, entry.name, 'package.json'), 'utf8')).name);
}

/**
 * The tree-wide `@jinn-network/marketplace-*` and `@jinn-network/task-execution-*` wildcards,
 * each replaced by an explicit ban on every family member NOT carved out for posting.
 */
function postingForbiddenPackages(
  marketplaceAllowed = POSTING_MARKETPLACE_ALLOWED,
  taskExecutionAllowed = POSTING_TASK_EXECUTION_ALLOWED,
) {
  const wildcards = ['@jinn-network/marketplace-*', '@jinn-network/task-execution-*'];
  return [
    ...TASK_SUPPLY_FOREIGN_PACKAGES.filter((forbidden) => !wildcards.includes(forbidden)),
    ...familyMembers('marketplace').filter((name) => !marketplaceAllowed.includes(name)).sort(),
    ...familyMembers('task-execution').filter((name) => !taskExecutionAllowed.includes(name)).sort(),
    ...POSTING_FORBIDDEN_EXTRA,
  ];
}

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

// Canonical task-supply bytes must not depend on the host locale or the bundled ICU data.
// These APIs all consult one or both, so an ordering or formatting decision made with them can
// change a record's SHA-256 digest between two hosts running identical code. Use a code-unit
// comparator instead; see compareCodeUnitStrings in @jinn-network/trust-core.
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
// `@jinn-network/marketplace-*`, whose exact member names are not yet decided — no task-supply
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
    `${relative(root, sourceRoot)} crosses a task-supply architecture boundary`);
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-task-supply-boundary-'));
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

test('the attestation and verification bans hold by exact name and by wildcard family', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-task-supply-attestation-ban-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import { verifyEnvironment } from "@jinn-network/environment-verification";',
      'import { issue } from "@jinn-network/attestation-issuer";',
      'import { put } from "@jinn-network/evidence-repository";',
      'import { postTask } from "@jinn-network/marketplace-binding";',
    ].join('\n'));
    assert.equal(forbiddenImports(source, TASK_SUPPLY_FOREIGN_PACKAGES).length, 4);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('task-supply source boundaries remain one-way across the approved graph', () => {
  // admission imports environments/record, trust-core, and the portable protocol/profile pair
  // used to build and validate its deterministic prediction receipt fixture.
  // `src/testing.ts` is production source under this same boundary: its `vitest` import is an
  // optional peer (not a Jinn package), and its only Jinn import is the approved
  // `@jinn-network/environment-record`.
  assertBoundary(
    join(packages, 'admission', 'src'),
    admissionForbiddenPackages(),
    FORBIDDEN_ROOTS,
  );
  // curation is a pure projection over verdict observations (design §9) and imports NO Jinn
  // package at all, so it gets the whole foreign list with no carve-out -- the strictest boundary
  // in the tree, and the one that keeps a projection from acquiring a record-shaped dependency.
  assertBoundary(
    join(packages, 'curation', 'src'),
    TASK_SUPPLY_FOREIGN_PACKAGES,
    FORBIDDEN_ROOTS,
  );
  // derivation imports environments/record, task-admission (types only), and the two
  // task-execution packages that own Task and EvaluationSpec sealing (planning Finding (a)).
  assertBoundary(
    join(packages, 'derivation', 'src'),
    derivationForbiddenPackages(DERIVATION_TASK_EXECUTION_ALLOWED),
    FORBIDDEN_ROOTS,
  );
  // chain-scenarios imports chain-record (CE1), the two sealing packages, derivation's seam
  // types and admission's chain receipt types. Never chain-verification (design §3).
  assertBoundary(
    join(packages, 'chain-scenarios', 'src'),
    chainScenariosForbiddenPackages(),
    [...FORBIDDEN_ROOTS, join(root, 'packages', 'environments', 'chain-verification')],
  );
  // posting imports the marketplace requester backend and the protocol package that owns
  // Submission sealing. Task derivation is permitted only in a compile-time test fixture.
  assertBoundary(
    join(packages, 'posting', 'src'),
    postingForbiddenPackages(),
    // `packages/marketplace` is NOT a forbidden root for posting: the binding is its approved
    // dependency. The relative-path bans on the legacy tree and the verification package hold.
    FORBIDDEN_ROOTS.filter((forbiddenRoot) => forbiddenRoot !== join(root, 'packages', 'marketplace')),
  );
});

test('posting\'s marketplace and task-execution carve-outs admit one package each and ban the rest', () => {
  const forbidden = postingForbiddenPackages();
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-task-supply-posting-carveout-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'allowed.ts'), [
      ...POSTING_MARKETPLACE_ALLOWED,
      ...POSTING_TASK_EXECUTION_ALLOWED,
      '@jinn-network/task-derivation',
    ].map((name) => `import x from ${JSON.stringify(name)};`).join('\n'));
    assert.deepEqual(forbiddenImports(source, forbidden), []);

    const banned = [
      ...familyMembers('marketplace').filter((name) => !POSTING_MARKETPLACE_ALLOWED.includes(name)),
      ...familyMembers('task-execution').filter((name) => !POSTING_TASK_EXECUTION_ALLOWED.includes(name)),
      ...POSTING_FORBIDDEN_EXTRA,
      'viem',
    ];
    assert.ok(banned.length > POSTING_FORBIDDEN_EXTRA.length + 1, 'expected sibling family members to ban');
    writeFileSync(join(source, 'banned.ts'),
      banned.map((name) => `import y from ${JSON.stringify(name)};`).join('\n'));
    assert.equal(forbiddenImports(join(source, 'banned.ts'), forbidden).length, banned.length);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('chain-scenarios reaches task-admission for types only (design §3: admission is a port)', () => {
  const production = files(join(packages, 'chain-scenarios', 'src'))
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  const valueImports = production.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']@jinn-network\/task-admission["']/gmu)]
      .map((match) => `${relative(root, file)} -> ${match[0].trim()}`);
  });
  assert.deepEqual(valueImports, [],
    'chain-scenarios may import @jinn-network/task-admission with `import type` only: it '
      + 'calls admission through an injected port, never directly (program ruling R4)');
});

test('task-posting reaches task-derivation only from its compile-time structural fixture', () => {
  const production = files(join(packages, 'posting', 'src'))
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  const imports = production.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/^\s*import\s+[^;]*?from\s+["']@jinn-network\/task-derivation["']/gmu)]
      .map((match) => `${relative(root, file)} -> ${match[0].trim()}`);
  });
  assert.deepEqual(imports, [],
    'posting production code has no dependency on @jinn-network/task-derivation');

  const structuralFixture = readFileSync(join(packages, 'posting', 'src', 'pool-shape.test.ts'), 'utf8');
  assert.match(structuralFixture,
    /^import type \{ SupplyPool \} from "@jinn-network\/task-derivation";/mu,
    'the sole task-derivation edge must remain an explicitly type-only structural fixture');
});

test('task-posting exposes the requester backend and no raw posting-operation ports', () => {
  const execution = readFileSync(join(packages, 'posting', 'src', 'execute.ts'), 'utf8');
  const publicIndex = readFileSync(join(packages, 'posting', 'src', 'index.ts'), 'utf8');
  assert.match(execution, /readonly backend: MarketplaceRequesterBackend;/u);
  assert.doesNotMatch(execution, /\bPostTaskFn\b|readonly postTask:|readonly ports:|readonly chain:/u);
  assert.doesNotMatch(publicIndex, /\bPostTaskFn\b/u);
});

test('derivation\'s task-execution carve-out admits exactly two packages and bans the rest', () => {
  const forbidden = derivationForbiddenPackages(DERIVATION_TASK_EXECUTION_ALLOWED);
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-task-supply-derivation-carveout-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'allowed.ts'), DERIVATION_TASK_EXECUTION_ALLOWED
      .map((name) => `import x from ${JSON.stringify(name)};`).join('\n'));
    assert.deepEqual(forbiddenImports(source, forbidden), []);

    const otherTaskExecution = readdirSync(join(root, 'packages', 'task-execution'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', 'task-execution', entry.name, 'package.json')))
      .map((entry) => JSON.parse(readFileSync(join(root, 'packages', 'task-execution', entry.name, 'package.json'), 'utf8')).name)
      .filter((name) => !DERIVATION_TASK_EXECUTION_ALLOWED.includes(name));
    assert.ok(otherTaskExecution.length > 0, 'expected at least one non-allowed task-execution package');
    writeFileSync(join(source, 'banned.ts'), [
      ...otherTaskExecution.map((name) => `import y from ${JSON.stringify(name)};`),
      'import z from "@jinn-network/trust-core";',
      'import w from "@jinn-network/marketplace-binding";',
    ].join('\n'));
    assert.equal(
      forbiddenImports(join(source, 'banned.ts'), forbidden).length,
      otherTaskExecution.length + 2,
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('locale-sensitive API detection catches member calls, optional chaining, and Intl', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-task-supply-locale-boundary-'));
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
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-task-supply-network-boundary-'));
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

test('Task Supply production source never uses ambient network APIs', () => {
  for (const directory of taskSupplyDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(ambientNetworkUsesInFiles(production), [], `${directory} production source must receive I/O through injected ports`);
  }
});

test('Task Supply production source never orders or formats with the host locale', () => {
  for (const directory of taskSupplyDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source)
      .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(
      localeSensitiveUsesInFiles(production),
      [],
      `${directory} production source must not depend on the host locale or ICU data; `
        + 'canonical task-supply bytes would differ between hosts. Use compareCodeUnitStrings from @jinn-network/trust-core.',
    );
  }
});
