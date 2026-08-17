import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  FIXTURE_MANIFEST_NAME,
  buildFixtureManifest,
  readFixtureManifest,
  writeFixtureManifest,
} from './fixture-manifest.mjs';
import { loadStackPublishedCatalogPackages } from './platform-catalog.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

function fixturePackage(files) {
  const root = mkdtempSync(join(tmpdir(), 'jinn-fixture-manifest-'));
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, 'fixtures', relative);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return root;
}

test('the manifest lists every fixture file by sorted relative id with its sha256', () => {
  const root = fixturePackage({ 'b.json': '{"b":1}', 'nested/a.json': '{"a":1}' });
  try {
    const manifest = buildFixtureManifest(root);
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.entries.map((entry) => entry.id), ['b.json', 'nested/a.json']);
    assert.equal(manifest.entries[0].sha256, createHash('sha256').update('{"b":1}').digest('hex'));
    assert.deepEqual(manifest.errata, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the manifest never lists itself', () => {
  const root = fixturePackage({ 'a.json': '{}', [FIXTURE_MANIFEST_NAME]: '{"version":1,"entries":[],"errata":[]}' });
  try {
    assert.deepEqual(buildFixtureManifest(root).entries.map((entry) => entry.id), ['a.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('regeneration preserves a hand-authored errata array', () => {
  const root = fixturePackage({ 'a.json': '{}', 'a-corrected.json': '{}' });
  try {
    const erratum = { id: 'a.json', supersededBy: 'a-corrected.json', date: '2026-07-30', reason: 'sealed the wrong outcome value' };
    writeFixtureManifest(root, { ...buildFixtureManifest(root), errata: [erratum] });
    const rebuilt = { ...buildFixtureManifest(root), errata: readFixtureManifest(root).errata };
    assert.deepEqual(rebuilt.errata, [erratum]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeFixtureManifest emits stable two-space JSON with a trailing newline', () => {
  const root = fixturePackage({ 'a.json': '{}' });
  try {
    const manifest = buildFixtureManifest(root);
    writeFixtureManifest(root, manifest);
    const bytes = readFileSync(join(root, 'fixtures', FIXTURE_MANIFEST_NAME), 'utf8');
    assert.equal(bytes, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFixtureManifest(root, manifest);
    assert.equal(readFileSync(join(root, 'fixtures', FIXTURE_MANIFEST_NAME), 'utf8'), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFixtureManifest returns null for a package with no fixtures directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'jinn-fixture-manifest-empty-'));
  try {
    assert.equal(readFixtureManifest(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every fixture-bearing platform package has a current manifest on disk', () => {
  const drift = [];
  for (const pkg of loadStackPublishedCatalogPackages(repoRoot)) {
    const packageRoot = join(repoRoot, pkg.directory);
    const built = buildFixtureManifest(packageRoot);
    if (built === null) continue;
    const stored = readFixtureManifest(packageRoot);
    if (stored === null) {
      drift.push(`${pkg.directory}: missing fixtures/${FIXTURE_MANIFEST_NAME}`);
      continue;
    }
    if (JSON.stringify(stored.entries) !== JSON.stringify(built.entries)) {
      drift.push(`${pkg.directory}: fixtures/${FIXTURE_MANIFEST_NAME} is stale`);
    }
  }
  assert.deepEqual(drift, []);
});
