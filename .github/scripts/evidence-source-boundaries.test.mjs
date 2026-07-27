import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'evidence');
const evidenceDirectories = [
  'protocol', 'repository', 'repository-oci', 'discovery', 'catalog-sqlite',
  'execution-recorder', 'attestation-issuer', 'derivation', 'local-runtime',
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
      'import "../forbidden/local.js";',
    ].join('\n'));
    const findings = forbiddenImports(source, ['@jinn-network/'], [forbidden]);
    assert.equal(findings.length, 9);
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

test('evidence source boundaries remain one-way across the approved graph', () => {
  const discovery = join(packages, 'discovery', 'src');
  const catalog = join(discovery, 'catalog');
  const indexer = join(discovery, 'indexer');
  const journal = join(discovery, 'journal');
  const repositoryFs = join(packages, 'repository', 'src', 'fs');
  const concreteBindings = [
    '@jinn-network/evidence-discovery/journal', '@jinn-network/evidence-repository/fs',
    '@jinn-network/evidence-repository-oci', '@jinn-network/evidence-catalog-sqlite',
  ];

  assertBoundary(join(packages, 'protocol', 'src'), ['@jinn-network/']);
  assertPackageRootBoundary('repository', ['@jinn-network/evidence-repository/fs'], repositoryFs);
  assert.deepEqual(manifest('repository').exports['./fs'], {
    import: './dist/fs/index.js', types: './dist/fs/index.d.ts',
  });
  assert.deepEqual(Object.keys(manifest('discovery').exports).sort(),
    ['.', './indexer', './journal', './testing']);

  assertBoundary(catalog, ['@jinn-network/evidence-discovery/indexer', '@jinn-network/evidence-discovery/journal'], [indexer, journal]);
  assertBoundary(indexer, ['@jinn-network/evidence-discovery/journal', ...concreteBindings], [journal, repositoryFs, join(packages, 'repository-oci'), join(packages, 'catalog-sqlite')]);
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
    assertBoundary(join(packages, producer, 'src'), [...concreteBindings, '@jinn-network/evidence-local-runtime'], [journal, repositoryFs, join(packages, 'repository-oci'), join(packages, 'catalog-sqlite'), join(packages, 'local-runtime')]);
  }
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
});
