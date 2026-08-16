import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { canonicalJsonBytes } from './build-prepublication-bundle.mjs';
import {
  buildPlatformPublicSurface,
} from './build-platform-public-surface.mjs';
import {
  fixtureCatalog,
  fixtureRepo,
  packageEntry,
} from './platform-catalog-test-fixture.mjs';
import { loadCatalogPackages } from './platform-catalog.mjs';

const SHA = 'e'.repeat(40);
const repoRoot = resolve(import.meta.dirname, '../..');

function digest(root) {
  return createHash('sha256')
    .update(readFileSync(join(root, 'architecture/platform-packages.v1.json')))
    .digest('hex');
}

test('writes a canonical public-surface manifest for the exact sealed-platform-v1 set', () => {
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-surface-out-'));
  const outputPath = join(root, 'public-surface-manifest.json');
  try {
    const catalogDigest = digest(repoRoot);
    const manifest = buildPlatformPublicSurface({
      repoRoot,
      outputPath,
      sourceSha: SHA,
      catalogDigest,
      releaseGroup: 'sealed-platform-v1',
      lane: 'canary',
    });
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.sourceSha, SHA);
    assert.deepEqual(manifest.catalog, {
      path: 'architecture/platform-packages.v1.json',
      sha256: catalogDigest,
    });
    assert.equal(manifest.releaseGroup, 'sealed-platform-v1');
    assert.equal(manifest.lane, 'canary');
    const expectedNames = loadCatalogPackages(repoRoot, { releaseGroup: 'sealed-platform-v1' })
      .map(({ name }) => name);
    assert.deepEqual(manifest.packages.map(({ name }) => name), expectedNames);
    assert.equal(new Set(manifest.packages.map(({ name }) => name)).size, expectedNames.length);
    assert.ok(manifest.packages.some(({ name, publicSurface }) => (
      name === '@jinn-network/evidence-protocol'
        && publicSurface.schemas.includes('profiles/execution-evidence/v1/schemas')
    )));
    assert.equal(readFileSync(outputPath, 'utf8'), canonicalJsonBytes(manifest));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to emit a public artifact when a catalog declaration is not publishable', () => {
  const catalog = fixtureCatalog();
  const index = catalog.packages.findIndex(({ name }) => name === '@jinn-network/fixture-core-01');
  catalog.packages[index] = packageEntry(
    '@jinn-network/fixture-core-01',
    'packages/fixture/core-01',
    { publicSurface: { schemas: ['schemas'], profiles: [], fixtures: [], conformance: [] } },
  );
  const manifests = Object.fromEntries(catalog.packages.map((pkg) => [pkg.path, {
    name: pkg.name,
    version: '0.1.0',
    files: pkg.name === '@jinn-network/fixture-core-01' ? ['schemas/'] : [],
    ...(pkg.name === '@jinn-network/fixture-core-01'
      ? { exports: { './schemas/*': './schemas/*' } }
      : {}),
    ...(pkg.name === '@jinn-network/fixture-application'
      ? { dependencies: { '@jinn-network/fixture-protocol': '0.1.0' } }
      : {}),
  }]));
  const fixture = fixtureRepo({ catalog, manifests });
  const outputPath = join(fixture, 'public-surface-manifest.json');
  try {
    assert.throws(
      () => buildPlatformPublicSurface({
        repoRoot: fixture,
        outputPath,
        sourceSha: SHA,
        catalogDigest: digest(fixture),
        releaseGroup: 'platform-v1',
        lane: 'canary',
      }),
      /public surface validation failed: packages\/fixture\/core-01: publicSurface\.schemas path schemas/u,
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('source and catalog identities are validated before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-surface-out-'));
  const outputPath = join(root, 'manifest.json');
  try {
    assert.throws(
      () => buildPlatformPublicSurface({
        repoRoot,
        outputPath,
        sourceSha: 'bad',
        catalogDigest: digest(repoRoot),
        releaseGroup: 'sealed-platform-v1',
        lane: 'canary',
      }),
      /sourceSha must be a 40-character lowercase commit SHA/u,
    );
    assert.throws(
      () => buildPlatformPublicSurface({
        repoRoot,
        outputPath,
        sourceSha: SHA,
        catalogDigest: '0'.repeat(64),
        releaseGroup: 'sealed-platform-v1',
        lane: 'canary',
      }),
      /catalog digest mismatch/u,
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
