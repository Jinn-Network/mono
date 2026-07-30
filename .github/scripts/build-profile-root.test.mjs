import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildProfileRoot, manifestBytes } from './build-profile-root.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const SHA = 'e'.repeat(40);

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'jinn-profile-root-'));
  const packageDir = join(root, 'packages/evidence/protocol');
  mkdirSync(join(packageDir, 'profiles/execution-evidence/1.0/schemas'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@jinn-network/evidence-protocol',
    version: '0.1.0',
    publishConfig: { access: 'public' },
    files: ['dist/', 'profiles/'],
  }, null, 2)}\n`, 'utf8');
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
  const root = scratchRepo();
  const second = join(root, 'packages/trust/core');
  mkdirSync(join(second, 'profiles/execution-evidence/1.0'), { recursive: true });
  writeFileSync(join(second, 'package.json'), `${JSON.stringify({
    name: '@jinn-network/trust-core', version: '0.1.0', publishConfig: { access: 'public' }, files: ['profiles/'],
  }, null, 2)}\n`, 'utf8');
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
