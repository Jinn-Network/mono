import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalJsonBytes } from './build-prepublication-bundle.mjs';
import { fixtureCatalog, fixtureRepo } from './platform-catalog-test-fixture.mjs';
import {
  REQUIRED_VERIFICATION_GATES,
  createVerificationReceipt,
} from './platform-verification-receipt.mjs';

const SHA = 'c'.repeat(40);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function successfulConclusions() {
  return Object.fromEntries(REQUIRED_VERIFICATION_GATES.map((gate) => [gate, 'success']));
}

function receiptFixture() {
  const repoRoot = fixtureRepo();
  const root = mkdtempSync(join(tmpdir(), 'jinn-verification-receipt-'));
  const packRoot = join(root, 'pack');
  mkdirSync(join(packRoot, 'tarballs'), { recursive: true });
  const catalog = fixtureCatalog();
  const packages = catalog.packages
    .filter(({ releaseGroup }) => releaseGroup === 'platform-v1')
    .sort((left, right) => left.path.localeCompare(right.path));
  const coreNames = packages
    .map(({ name }) => name)
    .filter((name) => name.startsWith('@jinn-network/fixture-core-'))
    .sort();
  const firstWave = [...coreNames, '@jinn-network/fixture-protocol'].sort();
  const packageOrder = [...firstWave, '@jinn-network/fixture-application'];
  const catalogDigest = sha256(readFileSync(join(repoRoot, 'architecture/platform-packages.v1.json')));
  const tarballs = packageOrder.map((name, index) => {
    const filename = `tarballs/package-${String(index + 1).padStart(2, '0')}.tgz`;
    const bytes = Buffer.from(`receipt-tarball:${name}`);
    writeFileSync(join(packRoot, filename), bytes);
    return { name, filename, integrity: sri(bytes) };
  });
  const pack = {
    schemaVersion: 1,
    sourceSha: SHA,
    catalog: { path: 'architecture/platform-packages.v1.json', sha256: catalogDigest },
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packageVersion: `0.1.0-canary.sha.${SHA}`,
    distTag: 'canary',
    waves: [firstWave, ['@jinn-network/fixture-application']],
    packageOrder,
    tarballs,
  };
  const publicSurface = {
    schemaVersion: 1,
    sourceSha: SHA,
    catalog: { path: 'architecture/platform-packages.v1.json', sha256: catalogDigest },
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packages: packages.map(({ name, path, publicSurface: surface }) => ({
      name,
      path,
      publicSurface: surface,
    })),
  };
  const profile = {
    version: 1,
    generatedFrom: { repository: 'Jinn-Network/mono', commit: SHA },
    catalog: { path: 'architecture/platform-packages.v1.json', sha256: catalogDigest },
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packages: packageOrder,
    documents: [],
  };
  const packManifestPath = join(packRoot, 'manifest.json');
  const publicManifestPath = join(root, 'public-surface-manifest.json');
  const profileManifestPath = join(root, 'profile-manifest.json');
  writeFileSync(packManifestPath, canonicalJsonBytes(pack), 'utf8');
  writeFileSync(publicManifestPath, canonicalJsonBytes(publicSurface), 'utf8');
  writeFileSync(profileManifestPath, canonicalJsonBytes(profile), 'utf8');
  return {
    repoRoot,
    root,
    catalogDigest,
    pack,
    publicSurface,
    profile,
    packManifestPath,
    publicManifestPath,
    profileManifestPath,
  };
}

function receiptArgs(fixture, outputName = 'receipt.json') {
  return {
    repoRoot: fixture.repoRoot,
    sourceSha: SHA,
    catalogDigest: fixture.catalogDigest,
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packManifestPath: fixture.packManifestPath,
    publicManifestPath: fixture.publicManifestPath,
    profileManifestPath: fixture.profileManifestPath,
    conclusions: successfulConclusions(),
    outputPath: join(fixture.root, outputName),
  };
}

test('writes a canonical receipt binding source, catalog, gates, package order, tarballs, and surfaces', () => {
  const fixture = receiptFixture();
  try {
    const args = receiptArgs(fixture);
    const receipt = createVerificationReceipt(args);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.sourceSha, SHA);
    assert.deepEqual(receipt.catalog, {
      path: 'architecture/platform-packages.v1.json',
      sha256: fixture.catalogDigest,
    });
    assert.equal(receipt.releaseGroup, 'platform-v1');
    assert.equal(receipt.lane, 'canary');
    assert.deepEqual(receipt.packageOrder, fixture.pack.packageOrder);
    assert.deepEqual(receipt.waves, fixture.pack.waves);
    assert.deepEqual(receipt.tarballs, fixture.pack.tarballs);
    assert.deepEqual(receipt.conclusions, successfulConclusions());
    assert.equal(receipt.surfaces.public.packageCount, 50);
    assert.equal(receipt.surfaces.profile.documentCount, 0);
    assert.match(receipt.surfaces.public.manifestSha256, /^[0-9a-f]{64}$/u);
    assert.match(receipt.surfaces.profile.manifestSha256, /^[0-9a-f]{64}$/u);
    assert.equal(readFileSync(args.outputPath, 'utf8'), canonicalJsonBytes(receipt));
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('failed, skipped, neutral, cancelled, and missing gates cannot produce a receipt', () => {
  const fixture = receiptFixture();
  try {
    for (const conclusion of ['failure', 'skipped', 'neutral', 'cancelled']) {
      const args = receiptArgs(fixture, `receipt-${conclusion}.json`);
      args.conclusions.benchmarking = conclusion;
      assert.throws(
        () => createVerificationReceipt(args),
        new RegExp(`gate benchmarking must be exact success, got ${conclusion}`, 'u'),
      );
      assert.equal(existsSync(args.outputPath), false);
    }

    const missing = receiptArgs(fixture, 'receipt-missing.json');
    delete missing.conclusions.trust;
    assert.throws(
      () => createVerificationReceipt(missing),
      /missing required gate conclusion trust/u,
    );
    assert.equal(existsSync(missing.outputPath), false);
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('catalog digest drift cannot produce a receipt', () => {
  const fixture = receiptFixture();
  const args = receiptArgs(fixture);
  try {
    fixture.publicSurface.catalog.sha256 = '0'.repeat(64);
    writeFileSync(fixture.publicManifestPath, canonicalJsonBytes(fixture.publicSurface), 'utf8');
    assert.throws(
      () => createVerificationReceipt(args),
      /public surface manifest catalog digest does not match the receipt input/u,
    );
    assert.equal(existsSync(args.outputPath), false);
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('source drift cannot produce a receipt', () => {
  const fixture = receiptFixture();
  const args = receiptArgs(fixture);
  try {
    fixture.profile.generatedFrom.commit = 'd'.repeat(40);
    writeFileSync(fixture.profileManifestPath, canonicalJsonBytes(fixture.profile), 'utf8');
    assert.throws(
      () => createVerificationReceipt(args),
      /profile manifest source SHA does not match the receipt input/u,
    );
    assert.equal(existsSync(args.outputPath), false);
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('package-set drift cannot produce a receipt', () => {
  const fixture = receiptFixture();
  const args = receiptArgs(fixture);
  try {
    fixture.publicSurface.packages.pop();
    writeFileSync(fixture.publicManifestPath, canonicalJsonBytes(fixture.publicSurface), 'utf8');
    assert.throws(
      () => createVerificationReceipt(args),
      /public surface package set does not match platform-v1/u,
    );
    assert.equal(existsSync(args.outputPath), false);
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a missing tarball cannot produce a receipt', () => {
  const fixture = receiptFixture();
  const args = receiptArgs(fixture);
  try {
    unlinkSync(join(fixture.root, 'pack', fixture.pack.tarballs[0].filename));
    assert.throws(
      () => createVerificationReceipt(args),
      /pack manifest tarball is missing or escapes the bundle/u,
    );
    assert.equal(existsSync(args.outputPath), false);
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an existing receipt is immutable and cannot be overwritten', () => {
  const fixture = receiptFixture();
  const args = receiptArgs(fixture);
  try {
    writeFileSync(args.outputPath, 'keep-me\n', 'utf8');
    assert.throws(
      () => createVerificationReceipt(args),
      /refusing to overwrite existing verification receipt/u,
    );
    assert.equal(readFileSync(args.outputPath, 'utf8'), 'keep-me\n');
  } finally {
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
