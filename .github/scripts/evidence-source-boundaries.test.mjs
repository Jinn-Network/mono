import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages');
const evidenceDirectories = [
  'evidence-protocol', 'evidence-repository', 'evidence-repository-fs',
  'evidence-repository-oci', 'evidence-catalog', 'evidence-catalog-sqlite',
  'evidence-indexer', 'evidence-announcement-journal', 'execution-recorder',
  'attestation-issuer', 'evidence-local-runtime',
];

function files(directory) {
  if (!existsSync(directory)) return [];
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

function forbiddenImports(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  return files(sourceRoot).flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const packageMatch = forbiddenPackages.some((forbidden) => forbidden.endsWith('/')
      ? specifier.startsWith(forbidden)
      : specifier === forbidden || specifier.startsWith(`${forbidden}/`));
    const pathMatch = specifier.startsWith('.') && forbiddenRoots.some((forbiddenRoot) =>
      inside(resolve(dirname(file), specifier), forbiddenRoot));
    return packageMatch || pathMatch ? [`${relative(root, file)} -> ${specifier}`] : [];
  })).sort();
}

function assertBoundary(directory, forbiddenPackages, forbiddenDirectories = []) {
  assert.deepEqual(
    forbiddenImports(
      join(packages, directory, 'src'),
      forbiddenPackages,
      forbiddenDirectories.map((forbidden) => join(packages, forbidden)),
    ),
    [],
    `${directory} crosses an evidence architecture boundary`,
  );
}

function manifest(directory) {
  return JSON.parse(readFileSync(join(packages, directory, 'package.json'), 'utf8'));
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-evidence-boundary-'));
  try {
    const source = join(fixture, 'src');
    const forbidden = join(fixture, 'forbidden');
    mkdirSync(source);
    mkdirSync(forbidden);
    writeFileSync(join(source, 'source.ts'), [
      'import value from "@jinn-network/forbidden";',
      'export { value } from "@jinn-network/forbidden/export";',
      'await import("@jinn-network/forbidden/dynamic");',
      'require("@jinn-network/forbidden/require");',
      'await import(/* webpackIgnore: true */ "@jinn-network/forbidden/commented-dynamic");',
      'export { value } from /* boundary */ "@jinn-network/forbidden/commented-export";',
      'await import(// boundary',
      '  "@jinn-network/forbidden/line-comment");',
      'export { value } from /* first */ /* second */ "@jinn-network/forbidden/multiple-comments";',
      'import "../forbidden/local.js";',
    ].join('\n'));
    const findings = forbiddenImports(source, ['@jinn-network/'], [forbidden]);
    assert.equal(findings.length, 9);
    assert.ok(findings.some((finding) => finding.endsWith('-> @jinn-network/forbidden')));
    assert.ok(findings.some((finding) => finding.endsWith('-> @jinn-network/forbidden/export')));
    assert.ok(findings.some((finding) => finding.endsWith('-> @jinn-network/forbidden/dynamic')));
    assert.ok(findings.some((finding) => finding.endsWith('-> @jinn-network/forbidden/require')));
    assert.ok(findings.some((finding) => finding.endsWith('-> @jinn-network/forbidden/commented-dynamic')));
    assert.ok(findings.some((finding) => finding.endsWith('-> @jinn-network/forbidden/commented-export')));
    assert.ok(findings.some((finding) => finding.endsWith('-> @jinn-network/forbidden/line-comment')));
    assert.ok(findings.some((finding) => finding.endsWith('-> @jinn-network/forbidden/multiple-comments')));
    assert.ok(findings.some((finding) => finding.endsWith('-> ../forbidden/local.js')));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('evidence source boundaries remain one-way', () => {
  const concreteBindings = [
    '@jinn-network/evidence-announcement-journal',
    '@jinn-network/evidence-repository-fs',
    '@jinn-network/evidence-repository-oci',
    '@jinn-network/evidence-catalog-sqlite',
  ];
  assertBoundary('evidence-protocol', ['@jinn-network/']);
  assertBoundary('evidence-repository', ['@jinn-network/evidence-repository-fs'], ['evidence-repository-fs']);
  assert.equal(manifest('evidence-repository').exports['./fs'], undefined);
  assertBoundary('evidence-catalog', [
    '@jinn-network/evidence-indexer', '@jinn-network/evidence-announcement-journal',
  ], ['evidence-indexer', 'evidence-announcement-journal']);
  assertBoundary('evidence-indexer', [
    '@jinn-network/evidence-announcement-journal', ...concreteBindings,
  ], ['evidence-announcement-journal', 'evidence-repository-fs', 'evidence-repository-oci', 'evidence-catalog-sqlite']);
  assertBoundary('evidence-announcement-journal', ['@jinn-network/evidence-indexer'], ['evidence-indexer']);
  for (const producer of ['execution-recorder', 'attestation-issuer']) {
    assertBoundary(producer, [...concreteBindings, '@jinn-network/evidence-local-runtime'], [
      'evidence-announcement-journal', 'evidence-repository-fs', 'evidence-repository-oci',
      'evidence-catalog-sqlite', 'evidence-local-runtime',
    ]);
  }
  for (const directory of evidenceDirectories) {
    if (directory === 'evidence-local-runtime' || directory === 'evidence-catalog-sqlite') continue;
    for (const section of ['dependencies', 'devDependencies']) {
      assert.ok(!Object.hasOwn(manifest(directory)[section] ?? {}, '@jinn-network/evidence-catalog-sqlite'),
        `${directory} may not depend on concrete Catalog storage`);
    }
    assertBoundary(directory, ['@jinn-network/evidence-catalog-sqlite'], ['evidence-catalog-sqlite']);
  }
});
