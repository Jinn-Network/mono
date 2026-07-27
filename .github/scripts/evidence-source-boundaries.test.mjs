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
  'publication', 'local-runtime',
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

const AMBIENT_NETWORK_APIS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
const ambientNetworkIdentifier = new RegExp(
  String.raw`(?<![\w$."'\x60])(?:${AMBIENT_NETWORK_APIS.join('|')})\b`,
  'g',
);
const ambientNetworkGlobal = new RegExp(
  String.raw`\b(?:globalThis|global)\s*(?:(?:\.|\?\.)\s*(?:${AMBIENT_NETWORK_APIS.join('|')})\b|(?:\?\.)?\s*\[\s*["'](?:${AMBIENT_NETWORK_APIS.join('|')})["']\s*\])`,
  'g',
);

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
  for (const directory of evidenceDirectories) {
    if (directory === 'local-runtime' || directory === 'catalog-sqlite') continue;
    for (const section of ['dependencies', 'devDependencies']) {
      assert.ok(!Object.hasOwn(manifest(directory)[section] ?? {}, '@jinn-network/evidence-catalog-sqlite'), `${directory} may not depend on concrete Catalog storage`);
    }
    assertBoundary(join(packages, directory, 'src'), ['@jinn-network/evidence-catalog-sqlite'], [join(packages, 'catalog-sqlite')]);
  }
  for (const directory of evidenceDirectories) {
    if (directory === 'local-runtime' || directory === 'repository') continue;
    assertBoundary(join(packages, directory, 'src'), ['@jinn-network/evidence-repository/fs'], [repositoryFs]);
  }
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
