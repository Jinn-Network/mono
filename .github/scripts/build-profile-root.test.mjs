import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildProfileRoot, manifestBytes } from './build-profile-root.mjs';
import {
  fixtureCatalog,
  fixtureRepo,
  packageEntry,
} from './platform-catalog-test-fixture.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const SHA = 'e'.repeat(40);

function controlledRepo(packages) {
  const catalog = fixtureCatalog();
  const replacementIndexes = catalog.packages
    .map((pkg, index) => ({ pkg, index }))
    .filter(({ pkg }) => pkg.name.startsWith('@jinn-network/fixture-core-'))
    .map(({ index }) => index);
  const manifests = {};
  packages.forEach(({ directory, name, manifest }, index) => {
    catalog.packages[replacementIndexes[index]] = packageEntry(name, directory);
    manifests[directory] = { name, version: '0.1.0', ...manifest };
  });
  return fixtureRepo({ catalog, manifests });
}

function scratchRepo(extraPackages = []) {
  const root = controlledRepo([
    {
      directory: 'packages/evidence/protocol',
      name: '@jinn-network/evidence-protocol',
      manifest: { files: ['dist/', 'profiles/'] },
    },
    ...extraPackages,
  ]);
  const packageDir = join(root, 'packages/evidence/protocol');
  mkdirSync(join(packageDir, 'profiles/execution-evidence/1.0/schemas'), { recursive: true });
  writeFileSync(join(packageDir, 'profiles/execution-evidence/1.0/schemas/a.schema.json'), '{"type":"object"}', 'utf8');
  writeFileSync(join(packageDir, 'profiles/execution-evidence/1.0/profile.md'), '# profile\n', 'utf8');
  return root;
}

test('documents are served at the paths their profile URIs name', () => {
  const root = scratchRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((d) => d.path), [
      'profiles/execution-evidence/1.0/profile.md',
      'profiles/execution-evidence/1.0/schemas/a.schema.json',
    ]);
    assert.ok(existsSync(join(outDir, 'profiles/execution-evidence/1.0/schemas/a.schema.json')));
    assert.equal(
      readFileSync(join(outDir, 'profiles/execution-evidence/1.0/schemas/a.schema.json'), 'utf8'),
      '{"type":"object"}',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('each document carries its exact-byte digest, media type, and source package', () => {
  const root = scratchRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    const schema = manifest.documents.find((d) => d.path.endsWith('a.schema.json'));
    assert.equal(schema.sha256, createHash('sha256').update('{"type":"object"}').digest('hex'));
    assert.equal(schema.mediaType, 'application/schema+json');
    assert.equal(schema.sourcePackage, '@jinn-network/evidence-protocol');
    assert.equal(manifest.documents.find((d) => d.path.endsWith('profile.md')).mediaType, 'text/markdown');
    assert.deepEqual(manifest.generatedFrom, { repository: 'Jinn-Network/mono', commit: SHA });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a colliding served path across two packages is refused', () => {
  const root = scratchRepo([{
    directory: 'packages/trust/core',
    name: '@jinn-network/trust-core',
    manifest: { files: ['profiles/'] },
  }]);
  const second = join(root, 'packages/trust/core');
  mkdirSync(join(second, 'profiles/execution-evidence/1.0'), { recursive: true });
  writeFileSync(join(second, 'profiles/execution-evidence/1.0/profile.md'), '# other\n', 'utf8');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    assert.throws(
      () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
      /profiles\/execution-evidence\/1\.0\/profile\.md is claimed by both @jinn-network\/evidence-protocol and @jinn-network\/trust-core/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a document is served at its declared $id, not its directory location', () => {
  const root = controlledRepo([{
    directory: 'packages/evidence/repository-ipfs',
    name: '@jinn-network/evidence-repository-ipfs',
    manifest: { files: ['dist/', 'profile/'] },
  }]);
  const packageDir = join(root, 'packages/evidence/repository-ipfs');
  mkdirSync(join(packageDir, 'profile/v1'), { recursive: true });
  writeFileSync(
    join(packageDir, 'profile/v1/registration.schema.json'),
    JSON.stringify({ $id: 'https://jinn.network/profiles/evidence-repository-ipfs-registration/1/registration.schema.json' }),
    'utf8',
  );
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((d) => d.path), [
      'profiles/evidence-repository-ipfs-registration/1/registration.schema.json',
    ]);
    assert.ok(existsSync(join(outDir, 'profiles/evidence-repository-ipfs-registration/1/registration.schema.json')));
    assert.ok(!existsSync(join(outDir, 'profile/v1/registration.schema.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a record-discovery facts profile document is served at its declared "profile" field', () => {
  const root = controlledRepo([{
    directory: 'packages/discovery/facts/evidence',
    name: '@jinn-network/record-discovery-facts-evidence',
    manifest: { files: ['dist/', 'profiles/'] },
  }]);
  const packageDir = join(root, 'packages/discovery/facts/evidence');
  mkdirSync(join(packageDir, 'profiles'), { recursive: true });
  writeFileSync(
    join(packageDir, 'profiles/execution-evidence.1.0.json'),
    JSON.stringify({ profile: 'https://jinn.network/records/execution-evidence/1.0/facts/1.0' }),
    'utf8',
  );
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((d) => d.path), ['records/execution-evidence/1.0/facts/1.0']);
    assert.equal(manifest.documents[0].mediaType, 'application/json');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a .sha256 sidecar next to a remapped document is dropped from the profile root, not stranded at the old path', () => {
  // Regression: profile.json remaps to its declared "profile" identifier
  // (a different top-level path than its on-disk directory), but its sibling
  // profile.sha256 names no identifier of its own and would otherwise stay
  // behind at the pre-remap, directory-derived path -- a verifier resolving
  // the remapped document and reaching for the conventional adjacent .sha256
  // would 404. manifest.json's per-document sha256 field is the sole digest
  // surface; the sidecar file itself is simply not served.
  const root = controlledRepo([{
    directory: 'packages/task-execution/profiles',
    name: '@jinn-network/task-execution-profiles',
    manifest: { files: ['dist/', 'profiles/'] },
  }]);
  const packageDir = join(root, 'packages/task-execution/profiles');
  mkdirSync(join(packageDir, 'profiles/task-profiles/repository-work/1.0'), { recursive: true });
  writeFileSync(
    join(packageDir, 'profiles/task-profiles/repository-work/1.0/profile.json'),
    JSON.stringify({ profile: 'https://jinn.network/task-profiles/repository-work/1.0' }),
    'utf8',
  );
  writeFileSync(
    join(packageDir, 'profiles/task-profiles/repository-work/1.0/profile.sha256'),
    'sha256:829c28d91e324098739bcd6dfd3e32f7c6902efd737333c8f5659dc354a0475a',
    'utf8',
  );
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((d) => d.path), ['task-profiles/repository-work/1.0']);
    assert.equal(existsSync(join(outDir, 'profiles/task-profiles/repository-work/1.0/profile.sha256')), false);
    assert.equal(existsSync(join(outDir, 'task-profiles/repository-work/1.0.sha256')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a fixture that reuses a "profile" value as test data is never treated as self-identifying', () => {
  const root = controlledRepo([{
    directory: 'packages/task-execution/profiles',
    name: '@jinn-network/task-execution-profiles',
    manifest: { files: ['dist/', 'profiles/'] },
  }]);
  const packageDir = join(root, 'packages/task-execution/profiles');
  mkdirSync(join(packageDir, 'profiles/fixtures/task-profile/golden'), { recursive: true });
  writeFileSync(
    join(packageDir, 'profiles/fixtures/task-profile/golden/minimal-profile.json'),
    JSON.stringify({ profile: 'https://jinn.network/task-profiles/example-domain/1.0' }),
    'utf8',
  );
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((d) => d.path), [
      'profiles/fixtures/task-profile/golden/minimal-profile.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a flat top-level schemas/ directory is not part of the profile root', () => {
  const root = controlledRepo([{
    directory: 'packages/task-execution/protocol',
    name: '@jinn-network/task-execution-protocol',
    manifest: { files: ['dist/', 'schemas/'] },
  }]);
  const packageDir = join(root, 'packages/task-execution/protocol');
  mkdirSync(join(packageDir, 'schemas'), { recursive: true });
  writeFileSync(join(packageDir, 'schemas/task.schema.json'), '{"type":"object"}', 'utf8');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('manifestBytes are canonical and stable', () => {
  const manifest = { version: 1, generatedFrom: { repository: 'Jinn-Network/mono', commit: SHA }, documents: [] };
  assert.equal(manifestBytes(manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(manifestBytes(manifest), manifestBytes(structuredClone(manifest)));
});

test('the real repository produces a non-empty profile root', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot, outDir, commit: SHA });
    assert.ok(manifest.documents.length > 0, 'the platform must serve at least one profile document');
    for (const document of manifest.documents) {
      assert.match(document.sha256, /^[0-9a-f]{64}$/);
      assert.ok(existsSync(join(outDir, document.path)));
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('URI resolution gate: every real document declaring a jinn.network identifier is served at exactly that path', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot, outDir, commit: SHA });
    let checked = 0;
    for (const document of manifest.documents) {
      if (document.path.split('/').includes('fixtures')) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(join(outDir, document.path), 'utf8'));
      } catch {
        continue;
      }
      for (const field of ['$id', 'profile']) {
        const value = parsed?.[field];
        if (typeof value !== 'string' || !value.startsWith('https://jinn.network/')) continue;
        checked += 1;
        assert.equal(
          `https://jinn.network/${document.path}`,
          value,
          `${document.path} declares ${field} ${value} but is served elsewhere`,
        );
      }
    }
    assert.ok(checked >= 20, `expected to check at least 20 self-declaring documents, checked ${checked}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
