import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'evidence');
const evidenceDirectories = [
  'protocol', 'repository', 'repository-oci', 'repository-ipfs', 'discovery',
  'catalog-sqlite', 'execution-recorder', 'attestation-issuer', 'derivation',
  'publication', 'local-runtime', 'execution-recorder-bridge', 'retrieval',
  'contribution', 'trajectory',
];
const APPLICATION_AND_LEGACY_ROOTS = [
  join(root, 'apps'),
  join(root, 'client'),
  ...[
    'autopilot', 'core', 'indexer', 'indexer-enrichment', 'layer', 'plugin',
    'sdk',
  ].map((directory) => join(root, 'packages', directory)),
];
const IPFS_PRODUCTION_FORBIDDEN_ROOTS = [
  ...evidenceDirectories
    .filter((directory) => !['repository-ipfs', 'repository'].includes(directory))
    .map((directory) => join(packages, directory)),
  ...APPLICATION_AND_LEGACY_ROOTS,
];

const IPFS_FORBIDDEN_PACKAGES = [
  '@jinn-network/autopilot',
  '@jinn-network/attestation-issuer',
  '@jinn-network/broadcast-bot',
  '@jinn-network/client',
  '@jinn-network/core',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/execution-recorder',
  '@jinn-network/indexer',
  '@jinn-network/indexer-enrichment',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace',
  '@jinn-network/plugin',
  '@jinn-network/sdk',
  'better-sqlite3',
  'hermes-agent',
  'viem',
];

const IPFS_ALLOWED_DEPENDENCIES = [
  '@jinn-network/evidence-repository',
  'kubo-rpc-client',
];

const IPFS_ALLOWED_DEV_DEPENDENCIES = [
  '@jinn-network/evidence-protocol',
  '@types/node',
  'typescript',
  'vitest',
];

const IPFS_CID_FORBIDDEN_PACKAGES = [
  'kubo-rpc-client',
  'node:dgram',
  'node:dns',
  'node:fs',
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls',
];

const DERIVATION_FORBIDDEN_PACKAGES = [
  '@huggingface/transformers',
  '@jinn-network/attestation-issuer',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-derivation-ml',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-repository',
  '@jinn-network/execution-recorder',
  '@lmoe/gliner-onnx',
  'better-sqlite3',
  'node:dgram',
  'node:dns',
  'node:fs',
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls',
  'viem',
];

const DERIVATION_ALLOWED_DEPENDENCIES = [
  '@jinn-network/evidence-protocol',
  '@noble/hashes',
  '@secretlint/core',
  '@secretlint/secretlint-rule-preset-recommend',
  'canonicalize',
  'zod',
];

const DERIVATION_ALLOWED_DEV_DEPENDENCIES = [
  '@types/node',
  'typescript',
  'vitest',
];

const DERIVATION_ALLOWED_PEER_DEPENDENCIES = ['vitest'];

const PUBLICATION_FORBIDDEN_PACKAGES = [
  '@jinn-network/autopilot',
  '@jinn-network/attestation-issuer',
  '@jinn-network/broadcast-bot',
  '@jinn-network/client',
  '@jinn-network/core',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-publication/fs',
  '@jinn-network/evidence-publication/testing',
  '@jinn-network/evidence-repository/fs',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/execution-recorder',
  '@jinn-network/indexer',
  '@jinn-network/indexer-enrichment',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace',
  '@jinn-network/plugin',
  '@jinn-network/sdk',
  'better-sqlite3',
  'hermes-agent',
  'node:child_process',
  'node:dgram',
  'node:dns',
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls',
  'viem',
];

const PUBLICATION_ALLOWED_DEPENDENCIES = [
  '@jinn-network/evidence-repository',
];

const PUBLICATION_ALLOWED_DEV_DEPENDENCIES = [
  '@jinn-network/evidence-protocol',
  '@types/node',
  'typescript',
  'vitest',
];

const PUBLICATION_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
const PUBLICATION_FORBIDDEN_MANIFEST_PACKAGES =
  PUBLICATION_FORBIDDEN_PACKAGES.filter(
    (dependency) => dependency !== '@jinn-network/evidence-protocol',
  );

// The bridge has production dependencies only on Repository and Recorder;
// `@jinn-network/evidence-repository/fs` is a concrete binding permitted
// solely from the filesystem CLI composition root (`src/cli.ts`), and
// `@jinn-network/evidence-protocol` is a development-only portal dependency
// that must never reach bridge production source (see the Task 1 addendum).
const BRIDGE_FOREIGN_PACKAGES = [
  '@jinn-network/attestation-issuer',
  '@jinn-network/autopilot',
  '@jinn-network/broadcast-bot',
  '@jinn-network/client',
  '@jinn-network/core',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/indexer',
  '@jinn-network/indexer-enrichment',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace',
  '@jinn-network/plugin',
  '@jinn-network/sdk',
  'better-sqlite3',
  'hermes-agent',
  'viem',
];

const RETRIEVAL_ALLOWED_DEPENDENCIES = [
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
];
const RETRIEVAL_ALLOWED_DEV_DEPENDENCIES = [
  '@types/node',
  'typescript',
  'vitest',
];
const RETRIEVAL_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
const RETRIEVAL_FORBIDDEN_PACKAGES = [
  '@huggingface/transformers',
  '@jinn-network/autopilot',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-discovery/indexer',
  '@jinn-network/evidence-discovery/journal',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-repository/fs',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace',
  '@jinn-network/plugin',
  '@jinn-network/sdk',
  'better-sqlite3',
  'kubo-rpc-client',
  'node:dgram',
  'node:dns',
  'node:fs',
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls',
  'viem',
];

// Contribution composes Protocol, Repository, Derivation, and Publication
// through injected ports. It never touches a concrete Repository binding,
// Discovery, the Local Evidence Runtime, application/legacy paths, or
// ambient I/O -- see Task 1 addendum.
const CONTRIBUTION_ALLOWED_DEPENDENCIES = [
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-repository',
  'canonicalize',
];
const CONTRIBUTION_ALLOWED_DEV_DEPENDENCIES = [
  '@types/node',
  'typescript',
  'vitest',
];
const CONTRIBUTION_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
const CONTRIBUTION_FORBIDDEN_PACKAGES = [
  '@huggingface/transformers',
  '@jinn-network/attestation-issuer',
  '@jinn-network/autopilot',
  '@jinn-network/broadcast-bot',
  '@jinn-network/client',
  '@jinn-network/core',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-repository/fs',
  '@jinn-network/evidence-retrieval',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/indexer',
  '@jinn-network/indexer-enrichment',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace',
  '@jinn-network/plugin',
  '@jinn-network/sdk',
  'better-sqlite3',
  'hermes-agent',
  'kubo-rpc-client',
  'node:child_process',
  'node:crypto',
  'node:dgram',
  'node:dns',
  'node:fs',
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls',
  'viem',
];

// Trajectory is a tier-2 record kind: schemas, sealing, and derived identity. It composes
// Protocol only, never a repository binding, discovery, a runtime, or any product tree,
// and performs no I/O outside its fixture loaders in the testing region.
const TRAJECTORY_ALLOWED_DEPENDENCIES = [
  '@jinn-network/evidence-protocol',
  '@jinn-network/trust-core',
  '@noble/hashes',
  'ajv',
  'zod',
];
const TRAJECTORY_ALLOWED_DEV_DEPENDENCIES = [
  '@types/node',
  'canonicalize',
  'typescript',
  'vitest',
];
const TRAJECTORY_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
const TRAJECTORY_FORBIDDEN_PACKAGES = [
  '@jinn-network/attestation-issuer',
  '@jinn-network/autopilot',
  '@jinn-network/client',
  '@jinn-network/core',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-contribution',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/evidence-retrieval',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/indexer',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace',
  '@jinn-network/plugin',
  '@jinn-network/sdk',
  'better-sqlite3',
  'node:child_process',
  'node:dgram',
  'node:dns',
  'node:fs',
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls',
  'viem',
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

// Canonical Evidence bytes must not depend on the host locale or the bundled
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
    `${relative(root, sourceRoot)} crosses an evidence architecture boundary`);
}

function assertPackageRootBoundary(directory, forbiddenPackages, implementationRoot) {
  const sourceRoot = join(packages, directory, 'src');
  const findings = files(sourceRoot)
    .filter((file) => !inside(file, implementationRoot))
    .flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
      const packageMatch = forbiddenPackages.some((forbidden) =>
        specifier === forbidden || specifier.startsWith(`${forbidden}/`));
      const pathMatch = specifier.startsWith('.') && inside(resolve(dirname(file), specifier), implementationRoot);
      return packageMatch || pathMatch ? [`${relative(root, file)} -> ${specifier}`] : [];
    }));
  assert.deepEqual(findings.sort(), [], `${directory} package root exposes a concrete implementation`);
}

function manifest(directory) {
  return JSON.parse(readFileSync(join(packages, directory, 'package.json'), 'utf8'));
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-evidence-boundary-'));
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

test('Discovery boundary checks catch bare, relative, and root-helper Journal escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-discovery-boundary-'));
  try {
    const source = join(fixture, 'src');
    const catalog = join(fixture, 'catalog');
    const indexer = join(source, 'indexer');
    const journal = join(fixture, 'journal');
    mkdirSync(source); mkdirSync(catalog); mkdirSync(indexer); mkdirSync(journal);
    writeFileSync(join(catalog, 'source.ts'), [
      'import "@jinn-network/evidence-discovery/journal";',
      'export * from "../journal/index.js";',
    ].join('\n'));
    assert.equal(
      forbiddenImports(catalog, ['@jinn-network/evidence-discovery/journal'], [journal]).length,
      2,
    );
    writeFileSync(join(source, 'index.ts'), 'export * from "./bridge.js";');
    writeFileSync(join(source, 'bridge.ts'), 'export * from "../journal/index.js";');
    assert.equal(
      forbiddenImportsInFiles(
        files(source).filter((file) => !inside(file, indexer)),
        ['@jinn-network/evidence-discovery/journal'],
        [journal],
      ).length,
      1,
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('Derivation boundary checks catch package, I/O, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-derivation-boundary-'));
  try {
    const source = join(fixture, 'src');
    const forbidden = join(fixture, 'forbidden');
    mkdirSync(source); mkdirSync(forbidden);
    writeFileSync(join(source, 'source.ts'), [
      'import "@jinn-network/evidence-repository";',
      'export * from "@jinn-network/evidence-publication";',
      'await import("@jinn-network/evidence-discovery");',
      'require("@jinn-network/execution-recorder");',
      'import "node:fs/promises";',
      'import "node:http";',
      'export * from "node:https";',
      'await import("node:net");',
      'require("node:dns/promises");',
      'import "@huggingface/transformers";',
      'import "../forbidden/local.js";',
    ].join('\n'));
    assert.equal(
      forbiddenImports(source, DERIVATION_FORBIDDEN_PACKAGES, [forbidden]).length,
      11,
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('Derivation boundary checks catch ambient network APIs without imports', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-derivation-network-boundary-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), AMBIENT_NETWORK_APIS.flatMap((api) => [
      `${api};`,
      `globalThis.${api};`,
      `globalThis[${JSON.stringify(api)}];`,
      `globalThis?.${api};`,
      `globalThis?.[${JSON.stringify(api)}];`,
    ]).join('\n'));
    assert.equal(
      ambientNetworkUsesInFiles(files(source)).length,
      AMBIENT_NETWORK_APIS.length * 5,
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('Derivation root and testing boundaries distinguish test-only dependencies', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-derivation-testing-boundary-'));
  try {
    const source = join(fixture, 'src');
    const testing = join(source, 'testing.ts');
    const testingFixtures = join(source, 'fixtures.ts');
    const testingInvocation = join(
      source,
      'detector-contract-invocation.ts',
    );
    mkdirSync(source);
    writeFileSync(join(source, 'index.ts'), [
      'import "vitest";',
      'export * from "./testing.js";',
      'export * from "./fixtures.js";',
      'export * from "./detector-contract-invocation.js";',
    ].join('\n'));
    writeFileSync(testing, [
      'import "@jinn-network/evidence-repository";',
      'import "node:fs/promises";',
    ].join('\n'));
    writeFileSync(testingFixtures, 'export const syntheticFixture = true;\n');
    writeFileSync(
      testingInvocation,
      'export const invokeContractDetector = true;\n',
    );
    assert.equal(
      forbiddenImportsInFiles(
        [join(source, 'index.ts')],
        ['vitest'],
        [testing, testingFixtures, testingInvocation],
      ).length,
      4,
    );
    assert.equal(
      forbiddenImportsInFiles(
        [testing],
        DERIVATION_FORBIDDEN_PACKAGES,
      ).length,
      2,
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('IPFS boundary checks catch foreign packages and /cid reader escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-ipfs-boundary-'));
  try {
    const source = join(fixture, 'src');
    const foreign = join(fixture, 'foreign');
    const cid = join(source, 'cid.ts');
    const readers = join(source, 'readers.ts');
    const registration = join(source, 'registration.ts');
    mkdirSync(source); mkdirSync(foreign);
    writeFileSync(join(source, 'index.ts'), [
      'import "@jinn-network/evidence-protocol";',
      'import "@jinn-network/evidence-publication";',
      'import "@jinn-network/evidence-repository-oci";',
      'import "../foreign/application.js";',
    ].join('\n'));
    writeFileSync(cid, [
      'import "kubo-rpc-client";',
      'import "node:http";',
      'export * from "./readers.js";',
      'export * from "./registration.js";',
      'fetch;',
      'globalThis.fetch;',
    ].join('\n'));
    writeFileSync(readers, 'export const reader = true;\n');
    writeFileSync(registration, 'export const registration = true;\n');
    assert.equal(
      forbiddenImports(
        source,
        IPFS_FORBIDDEN_PACKAGES,
        [foreign],
      ).length,
      4,
    );
    assert.equal(
      forbiddenImportsInFiles(
        [cid],
        IPFS_CID_FORBIDDEN_PACKAGES,
        [readers, registration],
      ).length,
      4,
    );
    assert.equal(ambientNetworkUsesInFiles([cid]).length, 2);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('IPFS production boundary configuration catches application and legacy escapes', () => {
  const fixture = mkdtempSync(join(
    packages,
    'repository-ipfs',
    '.jinn-ipfs-production-boundary-',
  ));
  try {
    const source = join(fixture, 'source.ts');
    const localSpecifier = (target) => {
      const specifier = relative(fixture, target).replaceAll('\\', '/');
      return specifier.startsWith('.') ? specifier : `./${specifier}`;
    };
    writeFileSync(source, [
      'import "@jinn-network/core";',
      'import "@jinn-network/jinn-layer";',
      'import "@jinn-network/plugin";',
      'import "@jinn-network/autopilot";',
      `import ${JSON.stringify(localSpecifier(join(root, 'packages', 'core', 'src')))};`,
      `import ${JSON.stringify(localSpecifier(join(root, 'packages', 'layer', 'src')))};`,
      `import ${JSON.stringify(localSpecifier(join(root, 'client', 'src')))};`,
      `import ${JSON.stringify(localSpecifier(join(root, 'apps', 'jinn-agent')))};`,
      'await import(`@jinn-network/evidence-protocol`);',
      `require(\`${localSpecifier(join(root, 'client', 'plugins'))}\`);`,
    ].join('\n'));
    assert.equal(
      forbiddenImportsInFiles(
        [source],
        IPFS_FORBIDDEN_PACKAGES,
        IPFS_PRODUCTION_FORBIDDEN_ROOTS,
      ).length,
      10,
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('Publication boundary checks catch root, testing, filesystem, application, and legacy escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-publication-boundary-'));
  try {
    const source = join(fixture, 'src');
    const publicationFs = join(source, 'fs');
    const publicationTesting = join(source, 'testing.ts');
    const applications = join(fixture, 'applications');
    const legacy = join(fixture, 'legacy');
    mkdirSync(source);
    mkdirSync(publicationFs);
    mkdirSync(applications);
    mkdirSync(legacy);
    const rootSource = join(source, 'root.ts');
    const testingSource = publicationTesting;
    const fsSource = join(publicationFs, 'index.ts');
    writeFileSync(rootSource, [
      'import "@jinn-network/evidence-publication/fs";',
      'export * from "./fs/index.js";',
      'export * from "./testing.js";',
      'import "@jinn-network/evidence-discovery";',
      'import "@jinn-network/evidence-repository/fs";',
      'import "@jinn-network/evidence-repository-oci";',
      'import "@jinn-network/evidence-repository-ipfs";',
      'import "@jinn-network/core";',
      'import "../applications/index.js";',
      'import "../legacy/index.js";',
      'import "node:fs/promises";',
      'import "node:https";',
      'fetch;',
    ].join('\n'));
    writeFileSync(testingSource, [
      'import "@jinn-network/evidence-publication/fs";',
      'export * from "./fs/index.js";',
      'import "@jinn-network/evidence-discovery";',
      'import "@jinn-network/evidence-repository-ipfs";',
      'import "@jinn-network/core";',
      'import "../applications/index.js";',
      'import "node:http";',
      'WebSocket;',
    ].join('\n'));
    writeFileSync(fsSource, [
      'export * from "../testing.js";',
      'import "@jinn-network/evidence-discovery";',
      'import "@jinn-network/evidence-repository-oci";',
      'import "@jinn-network/core";',
      'import "../../legacy/index.js";',
      'import "node:net";',
      'EventSource;',
    ].join('\n'));

    assert.equal(
      forbiddenImportsInFiles(
        [rootSource],
        [...PUBLICATION_FORBIDDEN_PACKAGES, 'node:fs'],
        [publicationFs, publicationTesting, applications, legacy],
      ).length,
      12,
    );
    assert.equal(ambientNetworkUsesInFiles([rootSource]).length, 1);
    assert.equal(
      forbiddenImportsInFiles(
        [testingSource],
        [...PUBLICATION_FORBIDDEN_PACKAGES, 'node:fs'],
        [publicationFs, applications, legacy],
      ).length,
      7,
    );
    assert.equal(ambientNetworkUsesInFiles([testingSource]).length, 1);
    assert.equal(
      forbiddenImportsInFiles(
        [fsSource],
        PUBLICATION_FORBIDDEN_PACKAGES,
        [publicationTesting, applications, legacy],
      ).length,
      6,
    );
    assert.equal(ambientNetworkUsesInFiles([fsSource]).length, 1);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('Retrieval boundary checks catch package, I/O, and ambient-network escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-retrieval-boundary-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import "@jinn-network/plugin";',
      'export * from "@jinn-network/evidence-catalog-sqlite";',
      'await import("@jinn-network/evidence-repository/fs");',
      'require("@jinn-network/evidence-discovery/journal");',
      'import "node:fs";',
      'fetch;',
    ].join('\n'));
    assert.equal(
      forbiddenImports(source, RETRIEVAL_FORBIDDEN_PACKAGES).length,
      5,
    );
    assert.equal(ambientNetworkUsesInFiles(files(source)).length, 1);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('Contribution boundary checks catch package, I/O, and ambient-network escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-contribution-boundary-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import "@jinn-network/plugin";',
      'export * from "@jinn-network/evidence-discovery";',
      'await import("@jinn-network/evidence-repository/fs");',
      'require("@jinn-network/evidence-catalog-sqlite");',
      'import "node:fs";',
      'import "node:crypto";',
      'fetch;',
    ].join('\n'));
    assert.equal(
      forbiddenImports(source, CONTRIBUTION_FORBIDDEN_PACKAGES).length,
      6,
    );
    assert.equal(ambientNetworkUsesInFiles(files(source)).length, 1);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('Trajectory boundary checks catch package, I/O, and ambient-network escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-trajectory-boundary-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import "@jinn-network/plugin";',
      'export * from "@jinn-network/core";',
      'await import("@jinn-network/jinn-layer");',
      'require("@jinn-network/evidence-local-runtime");',
      'import "node:fs";',
      'fetch;',
    ].join('\n'));
    assert.equal(
      forbiddenImports(source, TRAJECTORY_FORBIDDEN_PACKAGES).length,
      5,
    );
    assert.equal(ambientNetworkUsesInFiles(files(source)).length, 1);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('evidence source boundaries remain one-way across the approved graph', () => {
  const discovery = join(packages, 'discovery', 'src');
  const catalog = join(discovery, 'catalog');
  const indexer = join(discovery, 'indexer');
  const journal = join(discovery, 'journal');
  const repositoryFs = join(packages, 'repository', 'src', 'fs');
  const repositoryIpfs = join(packages, 'repository-ipfs');
  const concreteBindings = [
    '@jinn-network/evidence-discovery/journal', '@jinn-network/evidence-repository/fs',
    '@jinn-network/evidence-repository-oci', '@jinn-network/evidence-repository-ipfs',
    '@jinn-network/evidence-catalog-sqlite',
  ];

  assertBoundary(join(packages, 'protocol', 'src'), ['@jinn-network/']);
  assertPackageRootBoundary('repository', ['@jinn-network/evidence-repository/fs'], repositoryFs);
  assert.deepEqual(manifest('repository').exports['./fs'], {
    import: './dist/fs/index.js', types: './dist/fs/index.d.ts',
  });
  assert.deepEqual(Object.keys(manifest('discovery').exports).sort(),
    ['.', './indexer', './journal', './testing']);

  assertBoundary(catalog, ['@jinn-network/evidence-discovery/indexer', '@jinn-network/evidence-discovery/journal'], [indexer, journal]);
  assertBoundary(indexer, ['@jinn-network/evidence-discovery/journal', ...concreteBindings], [journal, repositoryFs, join(packages, 'repository-oci'), repositoryIpfs, join(packages, 'catalog-sqlite')]);
  assertBoundary(journal, ['@jinn-network/evidence-discovery/indexer'], [indexer]);
  const discoveryRootFiles = files(discovery)
    .filter((file) => ![catalog, indexer, journal].some((ownedRoot) => inside(file, ownedRoot)));
  assert.deepEqual(
    forbiddenImportsInFiles(
      discoveryRootFiles,
      [
        '@jinn-network/evidence-discovery/indexer',
        '@jinn-network/evidence-discovery/journal',
      ],
      [indexer, journal],
    ),
    [],
    'the Discovery root region must not expose Indexer or Journal',
  );

  for (const producer of ['execution-recorder', 'attestation-issuer']) {
    assertBoundary(join(packages, producer, 'src'), [...concreteBindings, '@jinn-network/evidence-local-runtime'], [journal, repositoryFs, join(packages, 'repository-oci'), repositoryIpfs, join(packages, 'catalog-sqlite'), join(packages, 'local-runtime')]);
  }
  const ipfsSource = join(repositoryIpfs, 'src');
  const ipfsManifest = manifest('repository-ipfs');
  const ipfsProductionFiles = files(ipfsSource)
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  assert.deepEqual(
    forbiddenImportsInFiles(
      ipfsProductionFiles,
      IPFS_FORBIDDEN_PACKAGES,
      IPFS_PRODUCTION_FORBIDDEN_ROOTS,
    ),
    [],
    'the IPFS binding may depend only on the Repository contract',
  );
  const ipfsCid = join(ipfsSource, 'cid.ts');
  const ipfsReader = join(ipfsSource, 'readers.ts');
  const ipfsRegistration = join(ipfsSource, 'registration.ts');
  const ipfsRepository = join(ipfsSource, 'repository.ts');
  assert.deepEqual(
    forbiddenImportsInFiles(
      [ipfsCid],
      IPFS_CID_FORBIDDEN_PACKAGES,
      [ipfsReader, ipfsRegistration, ipfsRepository],
    ),
    [],
    'the IPFS /cid entrypoint must remain pure mapping',
  );
  assert.deepEqual(
    ambientNetworkUsesInFiles([ipfsCid]),
    [],
    'the IPFS /cid entrypoint may not use ambient network APIs',
  );
  assert.deepEqual(Object.keys(ipfsManifest.exports).sort(), ['.', './cid', './profile/*']);
  assert.deepEqual(ipfsManifest.exports['.'], {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  });
  assert.deepEqual(ipfsManifest.exports['./cid'], {
    import: './dist/cid.js',
    types: './dist/cid.d.ts',
  });
  assert.equal(ipfsManifest.exports['./profile/*'], './profile/*');
  assert.deepEqual(
    Object.keys(ipfsManifest.dependencies ?? {}).sort(),
    IPFS_ALLOWED_DEPENDENCIES,
    'IPFS production dependencies must match the approved design inventory',
  );
  assert.deepEqual(
    Object.keys(ipfsManifest.devDependencies ?? {}).sort(),
    IPFS_ALLOWED_DEV_DEPENDENCIES,
    'IPFS development dependencies must match the approved toolchain',
  );
  assert.deepEqual(Object.keys(ipfsManifest.optionalDependencies ?? {}), []);
  assert.deepEqual(Object.keys(ipfsManifest.peerDependencies ?? {}), []);
  const derivation = join(packages, 'derivation');
  const derivationSource = join(derivation, 'src');
  const derivationTesting = join(derivationSource, 'testing.ts');
  const derivationTestingFixtures = join(derivationSource, 'fixtures.ts');
  const derivationTestingInvocation = join(
    derivationSource,
    'detector-contract-invocation.ts',
  );
  const derivationTestingFiles = [
    derivationTesting,
    derivationTestingFixtures,
    derivationTestingInvocation,
  ];
  const derivationSourceFiles = files(derivationSource);
  const derivationProductionFiles = derivationSourceFiles.filter((file) =>
    !derivationTestingFiles.includes(file)
      && !/\.test\.[cm]?[jt]sx?$/u.test(file));
  const derivationManifest = manifest('derivation');
  const derivationForbiddenRoots = evidenceDirectories
    .filter((directory) => !['derivation', 'protocol'].includes(directory))
    .map((directory) => join(packages, directory));
  assert.deepEqual(
    forbiddenImportsInFiles(
      derivationProductionFiles,
      [...DERIVATION_FORBIDDEN_PACKAGES, 'vitest'],
      [...derivationForbiddenRoots, ...derivationTestingFiles],
    ),
    [],
    'the Derivation root region must not expose /testing or test-only dependencies',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(
      derivationTestingFiles,
      DERIVATION_FORBIDDEN_PACKAGES,
      derivationForbiddenRoots,
    ),
    [],
    'the Derivation /testing region crosses an evidence architecture boundary',
  );
  assert.deepEqual(
    ambientNetworkUsesInFiles([
      ...derivationProductionFiles,
      ...derivationTestingFiles,
    ]),
    [],
    'Derivation production and /testing entrypoints may not use ambient network APIs',
  );
  assert.deepEqual(Object.keys(derivationManifest.exports).sort(), ['.', './testing']);
  assert.deepEqual(derivationManifest.exports['.'], {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  });
  assert.deepEqual(derivationManifest.exports['./testing'], {
    import: './dist/testing.js',
    types: './dist/testing.d.ts',
  });
  assert.deepEqual(
    Object.keys(derivationManifest.dependencies ?? {}).sort(),
    DERIVATION_ALLOWED_DEPENDENCIES,
    'derivation production dependencies must match the approved design inventory',
  );
  assert.deepEqual(
    Object.keys(derivationManifest.devDependencies ?? {}).sort(),
    DERIVATION_ALLOWED_DEV_DEPENDENCIES,
    'derivation development dependencies must match the approved toolchain',
  );
  assert.deepEqual(
    Object.keys(derivationManifest.optionalDependencies ?? {}),
    [],
    'derivation may not declare optional dependencies',
  );
  assert.deepEqual(
    Object.keys(derivationManifest.peerDependencies ?? {}).sort(),
    DERIVATION_ALLOWED_PEER_DEPENDENCIES,
    'derivation peer dependencies must remain test-only',
  );
  assert.deepEqual(derivationManifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  for (const section of [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  ]) {
    for (const dependency of DERIVATION_FORBIDDEN_PACKAGES) {
      assert.ok(
        !Object.hasOwn(derivationManifest[section] ?? {}, dependency),
        `derivation may not declare ${dependency} in ${section}`,
      );
    }
  }
  const publication = join(packages, 'publication');
  const publicationSource = join(publication, 'src');
  const publicationFs = join(publicationSource, 'fs');
  const publicationTesting = join(publicationSource, 'testing.ts');
  const publicationSourceFiles = files(publicationSource);
  const publicationRootFiles = publicationSourceFiles.filter((file) =>
    !inside(file, publicationFs)
      && file !== publicationTesting
      && !/\.test\.[cm]?[jt]sx?$/u.test(file));
  const publicationTestingFiles = [publicationTesting];
  const publicationFsFiles = files(publicationFs)
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  const publicationForeignEvidenceRoots = evidenceDirectories
    .filter((directory) => !['publication', 'repository'].includes(directory))
    .map((directory) => join(packages, directory));
  const publicationManifest = manifest('publication');

  assert.deepEqual(
    forbiddenImportsInFiles(
      publicationRootFiles,
      [...PUBLICATION_FORBIDDEN_PACKAGES, 'node:fs'],
      [
        publicationFs,
        publicationTesting,
        ...publicationForeignEvidenceRoots,
        ...APPLICATION_AND_LEGACY_ROOTS,
      ],
    ),
    [],
    'the Publication root crosses an evidence architecture boundary',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(
      publicationTestingFiles,
      [...PUBLICATION_FORBIDDEN_PACKAGES, 'node:fs'],
      [
        publicationFs,
        ...publicationForeignEvidenceRoots,
        ...APPLICATION_AND_LEGACY_ROOTS,
      ],
    ),
    [],
    'the Publication /testing entrypoint crosses an evidence architecture boundary',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(
      publicationFsFiles,
      PUBLICATION_FORBIDDEN_PACKAGES,
      [
        publicationTesting,
        ...publicationForeignEvidenceRoots,
        ...APPLICATION_AND_LEGACY_ROOTS,
      ],
    ),
    [],
    'the Publication /fs entrypoint crosses an evidence architecture boundary',
  );
  assert.deepEqual(
    ambientNetworkUsesInFiles([
      ...publicationRootFiles,
      ...publicationTestingFiles,
      ...publicationFsFiles,
    ]),
    [],
    'Publication entrypoints may not implement an ambient announcement medium',
  );
  assert.deepEqual(
    Object.keys(publicationManifest.exports).sort(),
    ['.', './fs', './testing'],
  );
  assert.deepEqual(publicationManifest.exports['.'], {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  });
  assert.deepEqual(publicationManifest.exports['./testing'], {
    import: './dist/testing.js',
    types: './dist/testing.d.ts',
  });
  assert.deepEqual(publicationManifest.exports['./fs'], {
    import: './dist/fs/index.js',
    types: './dist/fs/index.d.ts',
  });
  assert.deepEqual(
    Object.keys(publicationManifest.dependencies ?? {}).sort(),
    PUBLICATION_ALLOWED_DEPENDENCIES,
    'Publication production dependencies must match the approved design inventory',
  );
  assert.deepEqual(
    Object.keys(publicationManifest.devDependencies ?? {}).sort(),
    PUBLICATION_ALLOWED_DEV_DEPENDENCIES,
    'Publication development dependencies must match the approved toolchain',
  );
  assert.deepEqual(
    Object.keys(publicationManifest.optionalDependencies ?? {}),
    [],
    'Publication may not declare optional dependencies',
  );
  assert.deepEqual(
    Object.keys(publicationManifest.peerDependencies ?? {}).sort(),
    PUBLICATION_ALLOWED_PEER_DEPENDENCIES,
    'Publication peer dependencies must remain test-only',
  );
  assert.deepEqual(publicationManifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  for (const section of [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  ]) {
    for (const dependency of PUBLICATION_FORBIDDEN_MANIFEST_PACKAGES) {
      assert.ok(
        !Object.hasOwn(publicationManifest[section] ?? {}, dependency),
        `Publication may not declare ${dependency} in ${section}`,
      );
    }
  }
  const retrieval = join(packages, 'retrieval');
  const retrievalSource = join(retrieval, 'src');
  const retrievalTestingDir = join(retrievalSource, 'testing');
  const retrievalTestingEntry = join(retrievalSource, 'testing.ts');
  const retrievalTestSupport = join(retrievalSource, 'test-support.ts');
  const retrievalTestRegex = /\.test\.[cm]?[jt]sx?$/u;
  const retrievalSourceFiles = files(retrievalSource);
  const retrievalTestingFiles = retrievalSourceFiles.filter((file) =>
    file === retrievalTestingEntry
      || file === retrievalTestSupport
      || inside(file, retrievalTestingDir)
      || retrievalTestRegex.test(file));
  const retrievalProductionFiles = retrievalSourceFiles.filter((file) =>
    !retrievalTestingFiles.includes(file));
  const retrievalManifest = manifest('retrieval');
  const retrievalForeignEvidenceRoots = evidenceDirectories
    .filter((directory) =>
      !['retrieval', 'protocol', 'repository', 'discovery'].includes(directory))
    .map((directory) => join(packages, directory));
  const retrievalForeignRoots = [
    ...retrievalForeignEvidenceRoots,
    repositoryFs,
    join(packages, 'repository-oci'),
    repositoryIpfs,
    join(packages, 'catalog-sqlite'),
    indexer,
    journal,
  ];
  assert.deepEqual(
    forbiddenImportsInFiles(
      retrievalProductionFiles,
      [...RETRIEVAL_FORBIDDEN_PACKAGES, 'vitest'],
      [...retrievalForeignRoots, ...retrievalTestingFiles],
    ),
    [],
    'the Retrieval root region must not expose /testing, test-support, or test-only dependencies',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(
      retrievalTestingFiles,
      RETRIEVAL_FORBIDDEN_PACKAGES.filter((dependency) => dependency !== 'node:fs'),
      retrievalForeignRoots,
    ),
    [],
    'the Retrieval /testing region crosses an evidence architecture boundary',
  );
  assert.deepEqual(
    retrievalTestingFiles.flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => specifier === 'node:fs')
        .map((specifier) => `${relative(root, file)} -> ${specifier}`)),
    [],
    'the Retrieval /testing region may only use node:fs/promises, never bare node:fs',
  );
  assert.deepEqual(
    ambientNetworkUsesInFiles([
      ...retrievalProductionFiles,
      ...retrievalTestingFiles,
    ]),
    [],
    'Retrieval production and /testing entrypoints may not use ambient network APIs',
  );
  assert.deepEqual(Object.keys(retrievalManifest.exports).sort(), ['.', './testing']);
  assert.deepEqual(retrievalManifest.exports['.'], {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  });
  assert.deepEqual(retrievalManifest.exports['./testing'], {
    import: './dist/testing.js',
    types: './dist/testing.d.ts',
  });
  assert.deepEqual(
    Object.keys(retrievalManifest.dependencies ?? {}).sort(),
    RETRIEVAL_ALLOWED_DEPENDENCIES,
    'retrieval production dependencies must match the approved design inventory',
  );
  assert.deepEqual(
    Object.keys(retrievalManifest.devDependencies ?? {}).sort(),
    RETRIEVAL_ALLOWED_DEV_DEPENDENCIES,
    'retrieval development dependencies must match the approved toolchain',
  );
  assert.deepEqual(
    Object.keys(retrievalManifest.optionalDependencies ?? {}),
    [],
    'retrieval may not declare optional dependencies',
  );
  assert.deepEqual(
    Object.keys(retrievalManifest.peerDependencies ?? {}).sort(),
    RETRIEVAL_ALLOWED_PEER_DEPENDENCIES,
    'retrieval peer dependencies must remain test-only',
  );
  assert.deepEqual(retrievalManifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  for (const section of [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  ]) {
    for (const dependency of RETRIEVAL_FORBIDDEN_PACKAGES) {
      assert.ok(
        !Object.hasOwn(retrievalManifest[section] ?? {}, dependency),
        `retrieval may not declare ${dependency} in ${section}`,
      );
    }
  }
  for (const directory of ['protocol', 'repository', 'discovery']) {
    for (const section of [
      'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
    ]) {
      assert.ok(
        !Object.hasOwn(manifest(directory)[section] ?? {}, '@jinn-network/evidence-retrieval'),
        `${directory} may not depend on Retrieval`,
      );
    }
    assertBoundary(
      join(packages, directory, 'src'),
      ['@jinn-network/evidence-retrieval'],
      [retrieval],
    );
  }
  assert.deepEqual(
    forbiddenImportsInFiles(
      [join(retrievalSource, 'index.ts')],
      [],
      [retrievalTestingDir, retrievalTestingEntry],
    ),
    [],
    'the Retrieval root entrypoint must not export testing.ts or files under src/testing',
  );

  const contribution = join(packages, 'contribution');
  const contributionSource = join(contribution, 'src');
  const contributionTestingEntry = join(contributionSource, 'testing.ts');
  const contributionTestingFixtures = join(
    contributionSource,
    'testing-fixtures.ts',
  );
  const contributionTestRegex = /\.test\.[cm]?[jt]sx?$/u;
  const contributionSourceFiles = files(contributionSource);
  const contributionTestingFiles = contributionSourceFiles.filter((file) =>
    file === contributionTestingEntry
      || file === contributionTestingFixtures
      || contributionTestRegex.test(file));
  const contributionProductionFiles = contributionSourceFiles.filter((file) =>
    !contributionTestingFiles.includes(file));
  const contributionManifest = manifest('contribution');
  const contributionForeignEvidenceRoots = evidenceDirectories
    .filter((directory) =>
      !['contribution', 'protocol', 'repository', 'derivation', 'publication']
        .includes(directory))
    .map((directory) => join(packages, directory));
  const contributionForeignRoots = [
    ...contributionForeignEvidenceRoots,
    repositoryFs,
    join(packages, 'repository-oci'),
    repositoryIpfs,
    join(packages, 'catalog-sqlite'),
    indexer,
    journal,
  ];
  assert.deepEqual(
    forbiddenImportsInFiles(
      contributionProductionFiles,
      [...CONTRIBUTION_FORBIDDEN_PACKAGES, 'vitest'],
      [...contributionForeignRoots, ...contributionTestingFiles],
    ),
    [],
    'the Contribution root region must not expose /testing, test-only fixtures, or test-only dependencies',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(
      contributionTestingFiles,
      CONTRIBUTION_FORBIDDEN_PACKAGES.filter((dependency) =>
        dependency !== 'node:fs'),
      contributionForeignRoots,
    ),
    [],
    'the Contribution /testing region crosses an evidence architecture boundary',
  );
  assert.deepEqual(
    contributionTestingFiles.flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => specifier === 'node:fs')
        .map((specifier) => `${relative(root, file)} -> ${specifier}`)),
    [],
    'the Contribution /testing region may only use node:fs/promises, never bare node:fs',
  );
  assert.deepEqual(
    ambientNetworkUsesInFiles([
      ...contributionProductionFiles,
      ...contributionTestingFiles,
    ]),
    [],
    'Contribution production and /testing entrypoints may not use ambient network APIs',
  );
  assert.deepEqual(Object.keys(contributionManifest.exports).sort(), ['.', './testing']);
  assert.deepEqual(contributionManifest.exports['.'], {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  });
  assert.deepEqual(contributionManifest.exports['./testing'], {
    import: './dist/testing.js',
    types: './dist/testing.d.ts',
  });
  assert.deepEqual(
    Object.keys(contributionManifest.dependencies ?? {}).sort(),
    CONTRIBUTION_ALLOWED_DEPENDENCIES,
    'contribution production dependencies must match the approved design inventory',
  );
  assert.deepEqual(
    Object.keys(contributionManifest.devDependencies ?? {}).sort(),
    CONTRIBUTION_ALLOWED_DEV_DEPENDENCIES,
    'contribution development dependencies must match the approved toolchain',
  );
  assert.deepEqual(
    Object.keys(contributionManifest.optionalDependencies ?? {}),
    [],
    'contribution may not declare optional dependencies',
  );
  assert.deepEqual(
    Object.keys(contributionManifest.peerDependencies ?? {}).sort(),
    CONTRIBUTION_ALLOWED_PEER_DEPENDENCIES,
    'contribution peer dependencies must remain test-only',
  );
  assert.deepEqual(contributionManifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  for (const section of [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  ]) {
    for (const dependency of CONTRIBUTION_FORBIDDEN_PACKAGES) {
      assert.ok(
        !Object.hasOwn(contributionManifest[section] ?? {}, dependency),
        `contribution may not declare ${dependency} in ${section}`,
      );
    }
  }
  for (const directory of ['protocol', 'repository', 'derivation', 'publication']) {
    for (const section of [
      'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
    ]) {
      assert.ok(
        !Object.hasOwn(
          manifest(directory)[section] ?? {},
          '@jinn-network/evidence-contribution',
        ),
        `${directory} may not depend on Contribution`,
      );
    }
    assertBoundary(
      join(packages, directory, 'src'),
      ['@jinn-network/evidence-contribution'],
      [contribution],
    );
  }
  assert.deepEqual(
    forbiddenImportsInFiles(
      [join(contributionSource, 'index.ts')],
      [],
      [contributionTestingEntry, contributionTestingFixtures],
    ),
    [],
    'the Contribution root entrypoint must not export testing.ts or testing-fixtures.ts',
  );

  const trajectory = join(packages, 'trajectory');
  const trajectorySource = join(trajectory, 'src');
  const trajectoryTestingEntry = join(trajectorySource, 'testing.ts');
  const trajectoryFixtureLoaders = join(trajectorySource, 'fixtures.ts');
  const trajectoryConformance = join(trajectorySource, 'derivation-conformance.ts');
  const trajectoryThirdReviewProbes = join(trajectorySource, 'third-review-probes.ts');
  const trajectoryFourthReviewProbes = join(trajectorySource, 'fourth-review-probes.ts');
  const trajectoryFifthReviewProbes = join(trajectorySource, 'fifth-review-probes.ts');
  const trajectorySixthReviewProbes = join(trajectorySource, 'sixth-review-probes.ts');
  const trajectoryConformanceCaseManifest = join(trajectorySource, 'conformance-case-manifest.ts');
  const trajectoryConformanceCaseRunner = join(trajectorySource, 'conformance-case-runner.ts');
  const trajectoryExecutionFixtures = join(trajectorySource, 'execution-fixtures.ts');
  const trajectoryTestRegex = /\.test\.[cm]?[jt]sx?$/u;
  const trajectorySourceFiles = files(trajectorySource);
  const trajectoryTestingFiles = trajectorySourceFiles.filter((file) =>
    file === trajectoryTestingEntry
      || file === trajectoryFixtureLoaders
      || file === trajectoryConformance
      || file === trajectoryThirdReviewProbes
      || file === trajectoryFourthReviewProbes
      || file === trajectoryFifthReviewProbes
      || file === trajectorySixthReviewProbes
      || file === trajectoryConformanceCaseManifest
      || file === trajectoryConformanceCaseRunner
      || file === trajectoryExecutionFixtures
      || trajectoryTestRegex.test(file));
  const trajectoryProductionFiles = trajectorySourceFiles.filter((file) =>
    !trajectoryTestingFiles.includes(file));
  const trajectoryManifest = manifest('trajectory');
  const trajectoryForeignRoots = evidenceDirectories
    .filter((directory) => !['trajectory', 'protocol'].includes(directory))
    .map((directory) => join(packages, directory));

  assert.deepEqual(
    forbiddenImportsInFiles(
      trajectoryProductionFiles,
      [...TRAJECTORY_FORBIDDEN_PACKAGES, 'vitest', 'node:fs/promises'],
      [...trajectoryForeignRoots, ...trajectoryTestingFiles],
    ),
    [],
    'Trajectory production source must not import forbidden packages, vitest, filesystem APIs, or the testing region',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(
      trajectoryTestingFiles,
      TRAJECTORY_FORBIDDEN_PACKAGES.filter((dependency) => dependency !== 'node:fs'),
      trajectoryForeignRoots,
    ),
    [],
    'Trajectory testing files must not cross into foreign package roots',
  );
  assert.deepEqual(
    trajectoryTestingFiles.flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => specifier === 'node:fs')
        .map((specifier) => `${relative(root, file)} -> ${specifier}`)),
    [],
    'the Trajectory testing region may only use node:fs/promises, never bare node:fs',
  );
  assert.deepEqual(
    ambientNetworkUsesInFiles(trajectorySourceFiles),
    [],
    'Trajectory source must not use ambient network APIs',
  );
  assert.deepEqual(Object.keys(trajectoryManifest.exports).sort(), [
    '.', './fixtures/*', './schemas/*', './testing',
  ]);
  assert.deepEqual(trajectoryManifest.exports['.'], {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  });
  assert.deepEqual(trajectoryManifest.exports['./testing'], {
    import: './dist/testing.js',
    types: './dist/testing.d.ts',
  });
  assert.deepEqual(
    Object.keys(trajectoryManifest.dependencies ?? {}).sort(),
    TRAJECTORY_ALLOWED_DEPENDENCIES,
  );
  assert.deepEqual(
    Object.keys(trajectoryManifest.devDependencies ?? {}).sort(),
    TRAJECTORY_ALLOWED_DEV_DEPENDENCIES,
  );
  assert.deepEqual(
    Object.keys(trajectoryManifest.peerDependencies ?? {}).sort(),
    TRAJECTORY_ALLOWED_PEER_DEPENDENCIES,
  );
  assert.deepEqual(trajectoryManifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  for (const directory of evidenceDirectories.filter((entry) => entry !== 'trajectory')) {
    assertBoundary(
      join(packages, directory, 'src'),
      ['@jinn-network/evidence-trajectory'],
      [trajectory],
    );
  }
  assert.deepEqual(
    forbiddenImportsInFiles(
      [join(trajectorySource, 'index.ts')],
      [],
      [trajectoryTestingEntry, trajectoryFixtureLoaders, trajectoryConformance, trajectoryThirdReviewProbes, trajectoryConformanceCaseManifest, trajectoryConformanceCaseRunner],
    ),
    [],
    'the Trajectory root entrypoint must not export testing.ts or fixtures.ts',
  );

  for (const directory of evidenceDirectories) {
    if (directory === 'local-runtime' || directory === 'catalog-sqlite') continue;
    for (const section of ['dependencies', 'devDependencies']) {
      assert.ok(!Object.hasOwn(manifest(directory)[section] ?? {}, '@jinn-network/evidence-catalog-sqlite'), `${directory} may not depend on concrete Catalog storage`);
    }
    assertBoundary(join(packages, directory, 'src'), ['@jinn-network/evidence-catalog-sqlite'], [join(packages, 'catalog-sqlite')]);
  }
  for (const directory of evidenceDirectories) {
    if (
      directory === 'local-runtime' ||
      directory === 'repository' ||
      directory === 'execution-recorder-bridge'
    ) continue;
    assertBoundary(join(packages, directory, 'src'), ['@jinn-network/evidence-repository/fs'], [repositoryFs]);
  }
  const bridge = join(packages, 'execution-recorder-bridge');
  const bridgeSource = join(bridge, 'src');
  const bridgeCli = join(bridgeSource, 'cli.ts');
  const bridgeTestRegex = /\.test\.[cm]?[jt]sx?$/u;
  const bridgeSourceFiles = files(bridgeSource);
  const bridgeProductionFiles = bridgeSourceFiles.filter(
    (file) => !bridgeTestRegex.test(file),
  );
  assert.deepEqual(
    forbiddenImportsInFiles(
      bridgeSourceFiles.filter((file) => file !== bridgeCli),
      ['@jinn-network/evidence-repository/fs'],
    ),
    [],
    'only execution-recorder-bridge/src/cli.ts may depend on the concrete filesystem Repository',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(
      [join(bridgeSource, 'index.ts')],
      [],
      [bridgeCli],
    ),
    [],
    'the execution-recorder-bridge root entrypoint must not export cli.ts, which would '
      + 'transitively load the concrete filesystem Repository binding into every consumer '
      + 'of the injection-based bridge core',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(bridgeProductionFiles, [
      '@jinn-network/evidence-protocol',
    ]),
    [],
    'execution-recorder-bridge production source may not depend on the development-only Protocol portal',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(
      bridgeSourceFiles,
      BRIDGE_FOREIGN_PACKAGES,
      [join(packages, 'local-runtime'), ...APPLICATION_AND_LEGACY_ROOTS],
    ),
    [],
    'execution-recorder-bridge may not depend on the Local Evidence Runtime, host, plugin, Autopilot, or marketplace paths',
  );
  for (const directory of evidenceDirectories) {
    if (directory === 'repository-ipfs') continue;
    for (const section of [
      'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
    ]) {
      assert.ok(
        !Object.hasOwn(
          manifest(directory)[section] ?? {},
          '@jinn-network/evidence-repository-ipfs',
        ),
        `${directory} may not depend on the concrete IPFS binding`,
      );
    }
    assertBoundary(
      join(packages, directory, 'src'),
      ['@jinn-network/evidence-repository-ipfs'],
      [repositoryIpfs],
    );
  }
});

test('locale-sensitive API detection catches member calls, optional chaining, and Intl', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-evidence-locale-boundary-'));
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

test('Evidence production source never orders or formats with the host locale', () => {
  for (const directory of evidenceDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source)
      .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(
      localeSensitiveUsesInFiles(production),
      [],
      `${directory} production source must not depend on the host locale or ICU data; `
        + 'canonical Evidence bytes would differ between hosts. Use src/order.ts.',
    );
  }
});
