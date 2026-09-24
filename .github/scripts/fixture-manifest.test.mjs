import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  FIXTURE_MANIFEST_NAME,
  buildFixtureManifest,
  readFixtureManifest,
  rewriteFixtureManifest,
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
    const rewritten = rewriteFixtureManifest(root);
    assert.deepEqual(rewritten.errata, [erratum]);
    assert.deepEqual(readFixtureManifest(root).errata, [erratum]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const ids = (root) => buildFixtureManifest(root).entries.map((entry) => entry.id);

test('.DS_Store is never listed, at any depth', () => {
  const root = fixturePackage({ 'a.json': '{}', '.DS_Store': 'x', 'sub/.DS_Store': 'x', 'sub/b.json': '{}' });
  try {
    assert.deepEqual(ids(root), ['a.json', 'sub/b.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only the root manifest is excluded; a nested one is a fixture', () => {
  const empty = '{"version":1,"entries":[],"errata":[]}';
  const root = fixturePackage({ [FIXTURE_MANIFEST_NAME]: empty, [`sub/${FIXTURE_MANIFEST_NAME}`]: empty });
  try {
    assert.deepEqual(ids(root), [`sub/${FIXTURE_MANIFEST_NAME}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node_modules is never walked', () => {
  const root = fixturePackage({ 'a.json': '{}', 'node_modules/x.json': '{}' });
  try {
    assert.deepEqual(ids(root), ['a.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fixture that is neither a file nor a directory is refused, not skipped', () => {
  const root = fixturePackage({ 'a.json': '{}' });
  try {
    symlinkSync(join(root, 'fixtures', 'a.json'), join(root, 'fixtures', 'link.json'));
    assert.throws(() => buildFixtureManifest(root), { name: 'FixtureEntryTypeError', message: /link\.json/ });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rewriteFixtureManifest returns null for a package with no fixtures directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'jinn-fixture-manifest-empty-'));
  try {
    assert.equal(rewriteFixtureManifest(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The golden writers used to carry their own copies of the walk, which drifted from
// this one (#3920). They now delegate; a regrown private walk reads the tree again.
test('the golden-fixture writers delegate to the shared walk', () => {
  for (const relative of [
    'packages/benchmarking/protocol/scripts/write-golden-fixtures.mjs',
    'packages/benchmarking/evidence/scripts/write-golden-lifecycle-digests.mjs',
  ]) {
    const source = readFileSync(join(repoRoot, relative), 'utf8');
    assert.match(source, /from ['"](?:\.\.\/)+\.github\/scripts\/fixture-manifest\.mjs['"]/, relative);
    assert.doesNotMatch(source, /\breaddirSync\b/, relative);
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

// #4647: URL-equality entry guards silent-noop when argv[1] has a space or is a
// symlink (Node realpaths the module, not argv). The #4144 selectors already
// compare realpathSync on both sides; this is the same fence on the drift checker
// stack-fixture-immutability.yml invokes without jq-validating its stdout.
test('the CLI runs from a checkout path containing a space or reached through a symlink (#4647)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-fixture-cli-space-'));
  try {
    const spaced = join(dir, 'via link');
    mkdirSync(spaced);
    const script = join(spaced, 'fixture-manifest.mjs');
    symlinkSync(resolve(import.meta.dirname, 'fixture-manifest.mjs'), script);
    const result = spawnSync(process.execPath, [script, '--check', '--root', repoRoot], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `CLI exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /fixture manifests are current/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const REALPATH_ENTRY_GUARD = /existsSync\(\s*process\.argv\[1\]\s*\)[\s\S]*realpathSync\(\s*process\.argv\[1\]\s*\)\s*===\s*realpathSync\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)/u;
const ENTRY_GUARD_CANDIDATE = /process\.argv\[1\][\s\S]{0,400}import\.meta\.(?:url|filename)/u;

test('remaining .github/scripts CLI entry guards compare real filesystem paths (#4647)', () => {
  const scriptsDir = resolve(import.meta.dirname);
  const offenders = [];
  for (const name of readdirSync(scriptsDir).filter((file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs')).sort()) {
    const source = readFileSync(join(scriptsDir, name), 'utf8');
    if (!ENTRY_GUARD_CANDIDATE.test(source)) continue;
    if (!REALPATH_ENTRY_GUARD.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
