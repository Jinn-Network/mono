import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  buildPrepublicationBundle,
  canonicalJsonBytes,
} from './build-prepublication-bundle.mjs';
import {
  disableReleaseGroup,
  fixtureCatalog,
  fixtureRepo,
} from './platform-catalog-test-fixture.mjs';
import { loadCatalogPackages } from './platform-catalog.mjs';

const SHA = 'a'.repeat(40);
const repoRoot = resolve(import.meta.dirname, '../..');

function digestCatalog(root) {
  return createHash('sha256')
    .update(readFileSync(join(root, 'architecture/platform-packages.v1.json')))
    .digest('hex');
}

function fakePackExec(calls) {
  return (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    if (args[0] === 'publish') throw new Error('prepublication must never invoke npm publish');
    if (command !== 'npm' || args[0] !== 'pack') {
      return { status: 0, stdout: '', stderr: '' };
    }
    const destination = args[args.indexOf('--pack-destination') + 1];
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const filename = `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`;
    writeFileSync(join(destination, filename), `tarball:${manifest.name}:${manifest.version}`, 'utf8');
    return {
      status: 0,
      stdout: JSON.stringify([{ name: manifest.name, version: manifest.version, filename }]),
      stderr: '',
    };
  };
}

test('canonical JSON recursively sorts object keys while preserving array order', () => {
  assert.equal(
    canonicalJsonBytes({ zebra: 1, alpha: { delta: 4, beta: 2 }, waves: [['b', 'a']] }),
    '{"alpha":{"beta":2,"delta":4},"waves":[["b","a"]],"zebra":1}\n',
  );
});

test('packs the exact platform-v1 graph in runtime waves without publishing', async () => {
  const root = fixtureRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-prepublication-out-'));
  const calls = [];
  try {
    const catalogDigest = digestCatalog(root);
    const manifest = await buildPrepublicationBundle({
      repoRoot: root,
      outDir,
      sourceSha: SHA,
      catalogDigest,
      releaseGroup: 'platform-v1',
      lane: 'canary',
      exec: fakePackExec(calls),
    });

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.sourceSha, SHA);
    assert.deepEqual(manifest.catalog, {
      path: 'architecture/platform-packages.v1.json',
      sha256: catalogDigest,
    });
    assert.equal(manifest.releaseGroup, 'platform-v1');
    assert.equal(manifest.lane, 'canary');
    assert.equal(manifest.packageVersion, `0.1.0-canary.sha.${SHA}`);
    assert.equal(manifest.distTag, 'canary');
    assert.equal(manifest.waves.length, 2);
    assert.ok(manifest.waves[0].includes('@jinn-network/fixture-protocol'));
    assert.deepEqual(manifest.waves[1], ['@jinn-network/fixture-application']);
    assert.deepEqual(manifest.packageOrder, manifest.waves.flat());
    const expectedNames = loadCatalogPackages(root, { releaseGroup: 'platform-v1' })
      .map(({ name }) => name);
    assert.deepEqual(new Set(manifest.packageOrder), new Set(expectedNames));
    assert.equal(manifest.tarballs.length, expectedNames.length);
    assert.deepEqual(manifest.tarballs.map(({ name }) => name), manifest.packageOrder);
    for (const tarball of manifest.tarballs) {
      assert.match(tarball.filename, /^tarballs\/.+\.tgz$/u);
      const bytes = readFileSync(join(outDir, tarball.filename));
      assert.equal(
        tarball.integrity,
        `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      );
    }

    assert.equal(calls.filter(({ command, args }) => command === 'yarn' && args[0] === 'install').length, expectedNames.length);
    assert.equal(calls.filter(({ command, args }) => command === 'yarn' && args[0] === 'build').length, expectedNames.length);
    assert.equal(calls.filter(({ command, args }) => command === 'npm' && args[0] === 'pack').length, expectedNames.length);
    assert.equal(calls.some(({ args }) => args[0] === 'publish'), false);
    assert.equal(calls.some(({ cwd }) => cwd.startsWith(repoRoot)), false);
    assert.equal(readFileSync(join(outDir, 'manifest.json'), 'utf8'), canonicalJsonBytes(manifest));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('packs a differently sized release group using only its catalog-derived membership', async () => {
  const catalog = fixtureCatalog();
  const selected = new Set([
    '@jinn-network/fixture-protocol',
    '@jinn-network/fixture-application',
    '@jinn-network/fixture-core-01',
  ]);
  catalog.packages = catalog.packages.filter(({ name, releaseGroup }) => (
    releaseGroup !== 'platform-v1' || selected.has(name)
  ));
  catalog.releaseGroups['platform-v1'].expectedPackageCount = selected.size;
  const root = fixtureRepo({ catalog });
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-prepublication-dynamic-out-'));
  const calls = [];
  try {
    const manifest = await buildPrepublicationBundle({
      repoRoot: root,
      outDir,
      sourceSha: SHA,
      catalogDigest: digestCatalog(root),
      releaseGroup: 'platform-v1',
      lane: 'canary',
      exec: fakePackExec(calls),
    });
    assert.deepEqual(new Set(manifest.packageOrder), selected);
    assert.equal(manifest.tarballs.length, selected.size);
    assert.equal(calls.filter(({ command, args }) => command === 'npm' && args[0] === 'pack').length, selected.size);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a catalog-disabled canary group fails before any package command', async () => {
  const catalog = disableReleaseGroup(fixtureCatalog());
  const root = fixtureRepo({ catalog });
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-prepublication-disabled-out-'));
  const calls = [];
  try {
    await assert.rejects(
      buildPrepublicationBundle({
        repoRoot: root,
        outDir,
        sourceSha: SHA,
        catalogDigest: digestCatalog(root),
        releaseGroup: 'platform-v1',
        lane: 'canary',
        exec: fakePackExec(calls),
      }),
      /release group platform-v1 is not eligible for canary publication/u,
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('stable verification derives the package version and latest dist-tag without publishing', async () => {
  const root = fixtureRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-prepublication-out-'));
  const calls = [];
  try {
    const manifest = await buildPrepublicationBundle({
      repoRoot: root,
      outDir,
      sourceSha: SHA,
      catalogDigest: digestCatalog(root),
      releaseGroup: 'platform-v1',
      lane: 'stable',
      exec: fakePackExec(calls),
    });
    assert.equal(manifest.packageVersion, '0.1.0');
    assert.equal(manifest.distTag, 'latest');
    assert.equal(calls.some(({ args }) => args[0] === 'publish'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('source and catalog identity are validated before any package command runs', async () => {
  const root = fixtureRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-prepublication-out-'));
  const calls = [];
  const common = {
    repoRoot: root,
    outDir,
    catalogDigest: digestCatalog(root),
    releaseGroup: 'platform-v1',
    lane: 'canary',
    exec: fakePackExec(calls),
  };
  try {
    await assert.rejects(
      buildPrepublicationBundle({ ...common, sourceSha: 'not-a-sha' }),
      /sourceSha must be a 40-character lowercase commit SHA/u,
    );
    await assert.rejects(
      buildPrepublicationBundle({ ...common, sourceSha: SHA, catalogDigest: '0'.repeat(64) }),
      /catalog digest mismatch/u,
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
