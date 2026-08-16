import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'marketplace');
const marketplaceDirectories = ['binding', 'projector', 'pipeline', 'venue-base', 'testing'];
const APPLICATION_AND_LEGACY_ROOTS = [
  join(root, 'apps'), join(root, 'operator'),
  ...['autopilot', 'core', 'indexer', 'indexer-enrichment', 'layer', 'plugin', 'sdk']
    .map((d) => join(root, 'packages', d)),
];

const LEGACY_PIPELINE_CLIENT_IMPORTS = [
  'operator/src/config/shape-v2.ts',
  'operator/src/daemon/composition-root.ts',
  'operator/src/daemon/engagement-ledger.ts',
  'operator/src/daemon/work-loop.ts',
];

// binding implements the requester-facing TaskExecutionBackend as a peer (ruling §7.18): it may
// consume task-execution-{protocol,backend,profiles} and trust-{core,resolve}, never
// -supervisor/-workspace/-launchers/-backend-local (the embedder-only assembly seam), never a
// sibling marketplace package (binding is the base of the tree's DAG), and never any
// record-discovery-* package (the projector is the one chain-reading machine, §8; binding
// consumes the projector's output through its own venue-verb interface, not by importing
// discovery packages directly).
const BINDING_FORBIDDEN_PACKAGES = [
  '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-testing',
  '@jinn-network/marketplace-projector', '@jinn-network/marketplace-pipeline',
  '@jinn-network/marketplace-testing',
  '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-client', '@jinn-network/record-discovery-testing',
];
// projector is the one chain-reading machine (design §8): protocol + record-discovery-{protocol,
// serve} + the sibling binding (shared ABIs/event decoders + the ContractGeneration seam, M0.1
// Step 1) are allowed; never trust-*, never the embedder-only backend-local packages, never
// pipeline (the projector does not compose the pipeline; the pipeline composes venue verbs).
const PROJECTOR_FORBIDDEN_PACKAGES = [
  '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-backend', '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-testing',
  '@jinn-network/marketplace-pipeline', '@jinn-network/marketplace-testing',
  '@jinn-network/record-discovery-client', '@jinn-network/record-discovery-testing',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
];
// pipeline composes the binding's venue verbs with an embedded local backend, consumed ONLY
// through the assembly's standard TaskExecutionBackend interface (ruling §7.18, must #5): it may
// import task-execution-{protocol,backend,backend-local} + the sibling binding; it may NEVER
// reach into -supervisor/-workspace/-launchers (the assembly's own internals), never the
// projector (the pipeline does not read chain events itself), and never trust-*/
// record-discovery-* directly (those are binding/projector concerns).
const PIPELINE_FORBIDDEN_PACKAGES = [
  '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-testing',
  '@jinn-network/marketplace-projector', '@jinn-network/marketplace-testing',
  '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-client', '@jinn-network/record-discovery-testing',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
];
// venue-base is the tier-3 chain-adapter tree (composition design §6.1): it consumes the
// binding's port surface (including the three pipeline-declared ports re-exported there at
// stage 0) and the projector's decode/finality/observe machinery. It may NEVER import
// marketplace-pipeline (program §6 contract 8), never the backend-local internals, never
// marketplace-testing (one-directional kit rule), and never a record-discovery package
// directly -- the projector is the one chain-reading machine and owns that edge.
const VENUE_BASE_FORBIDDEN_PACKAGES = [
  '@jinn-network/marketplace-pipeline', '@jinn-network/marketplace-testing',
  '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-testing',
  '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-client', '@jinn-network/record-discovery-testing',
];

// Signer-injection only (program §6 contract 11 / design §6.1 npm posture): venue-base holds
// no key material and no key-loading code. Injected viem WalletClients are the only signing
// authority. Banned on venue-base production source.
const KEY_MATERIAL_APIS = [
  'privateKeyToAccount', 'mnemonicToAccount', 'hdKeyToAccount', 'generatePrivateKey',
  'privateKeyToAddress', 'toAccount',
];
const keyMaterialIdentifier = new RegExp(
  String.raw`(?<![\w$."'\x60])(?:${KEY_MATERIAL_APIS.join('|')})\b`, 'g',
);

// Storage location is a host parameter (`config.stateDbPath`), never an absolute default.
const HOST_PATH_APIS = ['homedir', 'userInfo'];
const hostPathIdentifier = new RegExp(
  String.raw`(?<![\w$."'\x60])(?:${HOST_PATH_APIS.join('|')})\b|(?:~\/\.jinn)`, 'g',
);

function matchesInFiles(sourceFiles, pattern) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(pattern)].map((match) => `${relative(root, file)} -> ${match[0]}`);
  }).sort();
}

// testing consumes marketplace-{binding,projector} + task-execution-testing +
// record-discovery-testing (the kits it builds on); never pipeline (pipeline is a composition
// LIBRARY exercised by its own tests, not by this conformance kit), never the embedder-only
// backend-local internals. Revised at M2.5 (this was "never trust-* directly ... at M0-M1
// scope" before M2.5 existed, per M0.1's own "later tasks extend the guard as they register
// modules"): the native §16.2 profile conformance (M2.5) composes the trust verification
// procedures `authenticateRequester`/`verifyEnvelopeBinding` directly
// (`@jinn-network/trust-core`, implemented by `@jinn-network/trust-resolve`) -- both were already
// declared as `testing`'s devDependencies at M0.1 in anticipation of this. M5.3 additionally
// consumes `trust-testing` for real sealed KeyBinding fixtures in the named-check suite.
// Program ruling §7.55 additionally requires `evidence-protocol`'s family validator before the
// kit inspects any Delivery-bound Execution Evidence fields.
const TESTING_FORBIDDEN_PACKAGES = [
  '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-backend-local',
  '@jinn-network/marketplace-pipeline',
  '@jinn-network/record-discovery-client',
];

// The one backend-local package every marketplace package but binding/projector/testing must
// never import, and the sole permitted route through it (ruling §7.18): only `pipeline`, and
// only the assembly (`-backend-local`), never its internal component packages.
const BACKEND_LOCAL_INTERNALS = [
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers',
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

// Canonical marketplace bytes must not depend on the host locale or the bundled ICU data. These
// APIs all consult one or both, so an ordering or formatting decision made with them can change
// a record's SHA-256 digest between two hosts running identical code. Use a code-unit comparator
// instead; see src/order.ts.
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
    if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === 'dist')) return [];
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
    `${relative(root, sourceRoot)} crosses a marketplace architecture boundary`);
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-marketplace-boundary-'));
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
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-marketplace-locale-boundary-'));
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

test('marketplace-binding production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'binding', 'src'), BINDING_FORBIDDEN_PACKAGES, APPLICATION_AND_LEGACY_ROOTS);
});

test('marketplace-projector production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'projector', 'src'), PROJECTOR_FORBIDDEN_PACKAGES, APPLICATION_AND_LEGACY_ROOTS);
});

test('marketplace-pipeline production source stays within its architecture boundary', () => {
  const productionFiles = files(join(packages, 'pipeline', 'src')).filter(
    (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
  );
  assert.deepEqual(
    forbiddenImportsInFiles(productionFiles, PIPELINE_FORBIDDEN_PACKAGES, APPLICATION_AND_LEGACY_ROOTS),
    [],
    'packages/marketplace/pipeline/src crosses a marketplace architecture boundary',
  );
});

// packages/marketplace/pipeline/src/facts-mapper-kinds.ts duplicates RECORD_KINDS.submission by
// value on purpose (the pipeline may never import `@jinn-network/record-discovery-protocol`,
// enforced above by PIPELINE_FORBIDDEN_PACKAGES). Its own comment says "the host asserts that
// equality in its own test" -- this file is that host: it is the one place that already
// legitimately reasons about both the pipeline's source tree and record-discovery-protocol's
// package boundary (see PIPELINE_FORBIDDEN_PACKAGES above), without either package depending on
// the other at runtime.
test('drift: pipeline\'s duplicated RECORD_KINDS_SUBMISSION still equals record-discovery-protocol\'s RECORD_KINDS.submission', () => {
  const pipelineSource = readFileSync(
    join(packages, 'pipeline', 'src', 'facts-mapper-kinds.ts'), 'utf8');
  const pipelineMatch = /RECORD_KINDS_SUBMISSION\s*=\s*\n?\s*"([^"]+)"/.exec(pipelineSource);
  assert.ok(pipelineMatch, 'pipeline no longer declares RECORD_KINDS_SUBMISSION as a string literal');

  const protocolSource = readFileSync(
    join(root, 'packages', 'discovery', 'protocol', 'src', 'identifiers.ts'), 'utf8');
  const protocolMatch = /submission:\s*"([^"]+)"/.exec(protocolSource);
  assert.ok(protocolMatch,
    'record-discovery-protocol no longer declares RECORD_KINDS.submission as a string literal');

  assert.equal(pipelineMatch[1], protocolMatch[1],
    "pipeline's duplicated RECORD_KINDS_SUBMISSION drifted from record-discovery-protocol's RECORD_KINDS.submission");
});

test('marketplace-pipeline has only the frozen legacy client import allowlist', () => {
  assert.deepEqual(
    files(join(root, 'operator', 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes('@jinn-network/marketplace-pipeline'))
      .map((file) => relative(root, file))
      .sort(),
    LEGACY_PIPELINE_CLIENT_IMPORTS,
    'native and new client code must compose task-execution/backend and marketplace-binding directly',
  );
});

test('marketplace-testing production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'testing', 'src'), TESTING_FORBIDDEN_PACKAGES, APPLICATION_AND_LEGACY_ROOTS);
});

test('marketplace-venue-base production source stays within its architecture boundary', () => {
  const productionFiles = files(join(packages, 'venue-base', 'src')).filter(
    (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
  );
  assert.deepEqual(
    forbiddenImportsInFiles(productionFiles, VENUE_BASE_FORBIDDEN_PACKAGES, APPLICATION_AND_LEGACY_ROOTS),
    [],
    'packages/marketplace/venue-base/src crosses a marketplace architecture boundary',
  );
});

test('marketplace-venue-base never loads or derives key material (signer-injection only)', () => {
  const productionFiles = files(join(packages, 'venue-base', 'src')).filter(
    (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
  );
  assert.deepEqual(matchesInFiles(productionFiles, keyMaterialIdentifier), [],
    'venue-base is signer-injection only: no keystore, no key-loading code, no key material');
});

test('marketplace-venue-base never hardcodes a host storage location', () => {
  const productionFiles = files(join(packages, 'venue-base', 'src')).filter(
    (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
  );
  assert.deepEqual(matchesInFiles(productionFiles, hostPathIdentifier), [],
    'venue-base persists only under the host-supplied config.stateDbPath');
});

test('no marketplace package imports the backend-local component internals (ruling §7.18)', () => {
  for (const directory of marketplaceDirectories) {
    if (directory === 'pipeline') continue; // pipeline may import the assembly (-backend-local) only, checked above
    assertBoundary(join(packages, directory, 'src'), BACKEND_LOCAL_INTERNALS);
  }
  // pipeline itself may never reach into supervisor/workspace/launchers either -- only the
  // assembly (-backend-local), already covered by PIPELINE_FORBIDDEN_PACKAGES above.
  const pipelineProductionFiles = files(join(packages, 'pipeline', 'src')).filter(
    (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
  );
  assert.deepEqual(forbiddenImportsInFiles(pipelineProductionFiles, BACKEND_LOCAL_INTERNALS), []);
});

test('marketplace exports stay root-only except for the native testing conformance subpaths', () => {
  for (const [directory, name, entries] of [
    // stack-publish-path plan Task 13 / design §5 ("retrievable without cloning"): a packed
    // fixtures/ directory must be reachable through an exports subpath, so binding and testing
    // (the two marketplace trees that ship a fixtures/ directory) each get './fixtures/*'.
    // projector and pipeline have no fixtures/ directory, so their surface stays root-only.
    ['binding', '@jinn-network/marketplace-binding', ['.', './fixtures/*']],
    ['projector', '@jinn-network/marketplace-projector', ['.']],
    ['pipeline', '@jinn-network/marketplace-pipeline', ['.']],
    ['venue-base', '@jinn-network/marketplace-venue-base', ['.']],
    // The native §16.2 suite is intentionally a public testing subpath; it does not turn the
    // profile checks into a parameter of the unmodified TEP core kit (ruling §7.19).
    ['testing', '@jinn-network/marketplace-testing', [
      '.', './backend-conformance', './named-check-fixtures', './projector-conformance',
      './revised-contract-conformance', './venue-conformance', './fixtures/*',
    ]],
  ]) {
    const manifest = JSON.parse(readFileSync(join(packages, directory, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.exports ?? {}), entries,
      `${name} exports do not match the marketplace public-surface contract`);
  }
});

test('marketplace production source never uses ambient network APIs', () => {
  for (const directory of marketplaceDirectories) {
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

test('marketplace production source never orders or formats with the host locale', () => {
  for (const directory of marketplaceDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source)
      .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(
      localeSensitiveUsesInFiles(production),
      [],
      `${directory} production source must not depend on the host locale or ICU data; `
        + 'canonical marketplace bytes would differ between hosts. Use src/order.ts.',
    );
  }
});
