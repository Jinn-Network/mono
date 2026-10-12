import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { canonicalPublicKeySha256 } from './dsse.mjs';
import { loadPlatformCatalog } from './platform-catalog.mjs';
import { fixtureCatalog, fixtureRepo } from './platform-catalog-test-fixture.mjs';
import { signManifest } from './sign-profile-manifest.mjs';
import {
  PROVENANCE_PATH,
  RELEASE_COPY_DIRECTORY,
  fetchRelease,
  formatReport,
  parseArgs,
  syncSpecRelease,
} from './sync-spec-release.mjs';

// Everything here is built by the suite: a toy catalog, a toy tree, a toy release, and a key
// pair generated in the test. Nothing is fetched and nothing is written outside the OS tmpdir.
const SCRIPT = resolve(import.meta.dirname, 'sync-spec-release.mjs');
const GROUP = 'platform-v1';
const PACKAGE = '@jinn-network/fixture-protocol';
const PACKAGE_PATH = 'packages/fixture/protocol';
const KEY_ID = 'toy-spec-key-2026';
const CATALOG_PATH = 'architecture/platform-packages.v1.json';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const TRUSTED = keyPair();
const OTHER = keyPair();
const IDENTITY = { keyId: KEY_ID, publicKeySha256: canonicalPublicKeySha256(TRUSTED.publicKeyPem).sha256 };

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// One document of each way a served path is decided: a schema served at the identity it
// declares, a profile document that declares none and is served at its package-relative
// path, and a fixture served under its package's name.
const SCHEMA = {
  repoPath: `${PACKAGE_PATH}/schemas/thing.schema.json`,
  servedPath: 'schemas/thing/v1',
  text: `${JSON.stringify({ $id: 'https://spec.jinn.network/schemas/thing/v1', type: 'object' }, null, 2)}\n`,
};
const NOTES = {
  repoPath: `${PACKAGE_PATH}/profiles/notes.md`,
  servedPath: 'profiles/notes.md',
  text: '# Notes\n',
};
const VECTOR = {
  repoPath: `${PACKAGE_PATH}/fixtures/vector-1.json`,
  servedPath: `${PACKAGE}/fixtures/vector-1.json`,
  text: '{"vector":1}\n',
};
const DOCUMENTS = [SCHEMA, NOTES, VECTOR];

function writeText(base, relativePath, text) {
  const absolute = join(base, ...relativePath.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, 'utf8');
}

/** A toy checkout whose first package declares a document surface and holds `files`. */
function toyRepo(files = DOCUMENTS, { publicKeyPem = TRUSTED.publicKeyPem } = {}) {
  const catalog = fixtureCatalog();
  catalog.packages[0].publicSurface = {
    schemas: ['schemas'],
    profiles: ['profiles'],
    fixtures: ['fixtures'],
    conformance: [],
  };
  const repo = fixtureRepo({ catalog });
  for (const surface of ['schemas', 'profiles', 'fixtures']) {
    mkdirSync(join(repo, PACKAGE_PATH, surface), { recursive: true });
  }
  for (const { repoPath, text } of files) writeText(repo, repoPath, text);
  writeText(repo, `.github/keys/${KEY_ID}.pub`, publicKeyPem);
  return repo;
}

/** A toy release on disk: the documents tree, one group manifest, and its signed envelope. */
function toyRelease(documents = DOCUMENTS, {
  signer = TRUSTED,
  keyId = KEY_ID,
  group = GROUP,
  manifestGroup = group,
  reshape = (manifest) => manifest,
} = {}) {
  const release = mkdtempSync(join(tmpdir(), 'jinn-toy-spec-release-'));
  mkdirSync(join(release, 'documents'), { recursive: true });
  for (const document of documents) {
    if (document.unwritten !== true) writeText(join(release, 'documents'), document.servedPath, document.text);
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(reshape({
    version: 1,
    generatedFrom: { repository: 'Jinn-Network/mono', commit: '0'.repeat(40) },
    releaseGroup: manifestGroup,
    lane: 'stable',
    packages: [PACKAGE],
    documents: documents.map((document) => ({
      path: document.servedPath,
      sha256: sha256(document.text),
      mediaType: 'application/json',
      sourcePackage: document.sourcePackage ?? PACKAGE,
    })),
  }), null, 2)}\n`, 'utf8');
  writeFileSync(join(release, `${group}.manifest.json`), manifestBytes);
  writeFileSync(
    join(release, `${group}.manifest.dsse.json`),
    `${JSON.stringify(signManifest(manifestBytes, signer.privateKeyPem, keyId), null, 2)}\n`,
    'utf8',
  );
  return release;
}

function snapshot(directory, prefix = '', found = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) snapshot(join(directory, entry.name), relativePath, found);
    else found.set(relativePath, entry.isSymbolicLink() ? 'symlink' : sha256(readFileSync(join(directory, entry.name))));
  }
  return found;
}

const sync = (repo, release, options = {}) => syncSpecRelease({
  repoRoot: repo,
  releaseDir: release,
  tag: 'v0.1.0',
  adopt: true,
  ...IDENTITY,
  ...options,
});

/** A refused sync is refused in write mode, and leaves the checkout byte for byte as it was. */
async function assertRefused(repo, release, pattern, options = {}) {
  const before = snapshot(repo);
  await assert.rejects(sync(repo, release, options), pattern);
  assert.deepEqual(snapshot(repo), before, 'a refused sync must write nothing');
}

async function withFixture(build, body) {
  const created = [];
  const track = (directory) => {
    created.push(directory);
    return directory;
  };
  try {
    await body(build(track));
  } finally {
    for (const directory of created) rmSync(directory, { recursive: true, force: true });
  }
}

const standard = (track) => ({ repo: track(toyRepo()), release: track(toyRelease()) });

test('check mode verifies a release, reports what a sync would write, and writes nothing', async () => {
  await withFixture(standard, async ({ repo, release }) => {
    writeText(repo, VECTOR.repoPath, '{"vector":"stale"}\n');
    const before = snapshot(repo);
    const plan = await sync(repo, release, { check: true });
    assert.deepEqual(snapshot(repo), before);

    const documents = plan.writes.filter(({ kind }) => kind === 'document');
    assert.deepEqual(
      documents.map(({ servedPath, repoPath, action, mapping }) => ({ servedPath, repoPath, action, mapping })),
      [
        { servedPath: VECTOR.servedPath, repoPath: VECTOR.repoPath, action: 'change', mapping: 'adopted' },
        { servedPath: NOTES.servedPath, repoPath: NOTES.repoPath, action: 'identical', mapping: 'adopted' },
        { servedPath: SCHEMA.servedPath, repoPath: SCHEMA.repoPath, action: 'identical', mapping: 'adopted' },
      ],
    );
    assert.equal(plan.catalog.pinBefore, null);
    assert.deepEqual(plan.catalog.marked, [PACKAGE]);
    assert.deepEqual(plan.pin, {
      tag: 'v0.1.0',
      groups: { [GROUP]: { manifestSha256: sha256(readFileSync(join(release, `${GROUP}.manifest.json`))) } },
      signingKey: IDENTITY,
    });

    const report = formatReport(plan, { check: true });
    assert.match(report, /^spec release Jinn-Network\/spec v0\.1\.0$/mu);
    assert.match(report, /^platform-v1: signature verified, manifest sha256 [0-9a-f]{64}, 3 documents match their digests$/mu);
    assert.match(report, /^mapping: 0 by provenance row, 3 adopted from this tree$/mu);
    assert.match(report, /^documents: 2 identical, 1 to change, 0 to create$/mu);
    assert.match(report, new RegExp(`^  change ${VECTOR.repoPath} \\([0-9a-f]{64} -> ${sha256(VECTOR.text)}\\)$`, 'mu'));
    assert.match(report, /^  specPin null -> v0\.1\.0$/mu);
    assert.match(report, /^check only: nothing written; a sync would write 5 files$/mu);
  });
});

test('a sync writes the documents, the provenance manifest, the signed manifests, and the catalog pin', async () => {
  await withFixture(standard, async ({ repo, release }) => {
    writeText(repo, VECTOR.repoPath, '{"vector":"stale"}\n');
    await sync(repo, release);

    for (const { repoPath, text } of DOCUMENTS) assert.equal(readFileSync(join(repo, repoPath), 'utf8'), text);
    for (const asset of [`${GROUP}.manifest.json`, `${GROUP}.manifest.dsse.json`]) {
      assert.deepEqual(
        readFileSync(join(repo, RELEASE_COPY_DIRECTORY, asset)),
        readFileSync(join(release, asset)),
        `${asset} is copied byte for byte`,
      );
    }
    const pin = {
      tag: 'v0.1.0',
      groups: { [GROUP]: { manifestSha256: sha256(readFileSync(join(release, `${GROUP}.manifest.json`))) } },
      signingKey: IDENTITY,
    };
    assert.deepEqual(JSON.parse(readFileSync(join(repo, PROVENANCE_PATH), 'utf8')), {
      schemaVersion: 1,
      repository: 'Jinn-Network/spec',
      release: pin,
      documents: [VECTOR, NOTES, SCHEMA].map(({ servedPath, repoPath, text }) => ({
        servedPath,
        repoPath,
        sha256: sha256(text),
        release: 'v0.1.0',
      })),
    });

    // The rewritten catalog is one the loader accepts, and only the pin moved in it.
    const catalog = loadPlatformCatalog(repo);
    assert.deepEqual(catalog.specPin, pin);
    assert.deepEqual(catalog.packages.filter((pkg) => pkg.pinned === true).map(({ name }) => name), [PACKAGE]);
    const keys = Object.keys(catalog.packages[0]);
    assert.equal(keys[keys.indexOf('publicSurface') + 1], 'pinned');
    const unpinned = JSON.parse(readFileSync(join(repo, CATALOG_PATH), 'utf8'));
    unpinned.specPin = null;
    delete unpinned.packages[0].pinned;
    const original = fixtureCatalog();
    original.packages[0].publicSurface = unpinned.packages[0].publicSurface;
    assert.deepEqual(unpinned, original);

    // Once pinned, the rows and the catalog carry the mapping and the key: no flags, no --adopt.
    const before = snapshot(repo);
    const again = await syncSpecRelease({ repoRoot: repo, releaseDir: release });
    assert.equal(again.tag, 'v0.1.0');
    assert.ok(again.writes.every(({ action }) => action === 'identical'));
    assert.ok(again.writes.filter(({ kind }) => kind === 'document').every(({ mapping }) => mapping === 'row'));
    assert.deepEqual(snapshot(repo), before);
    assert.match(formatReport(again, { check: false }), /^wrote 0 files$/mu);
  });
});

test('a new tag is the whole refresh: changed bytes, a new vector, and the moved pin', async () => {
  const revisedNotes = { ...NOTES, text: '# Notes\n\nRevised.\n' };
  const newVector = {
    repoPath: `${PACKAGE_PATH}/fixtures/vector-2.json`,
    servedPath: `${PACKAGE}/fixtures/vector-2.json`,
    text: '{"vector":2}\n',
  };
  await withFixture((track) => ({
    repo: track(toyRepo()),
    first: track(toyRelease()),
    second: track(toyRelease([SCHEMA, revisedNotes, VECTOR, newVector])),
  }), async ({ repo, first, second }) => {
    await sync(repo, first);

    // The new vector has no row yet. Without --adopt that is an error, not a skip.
    await assertRefused(
      repo,
      second,
      new RegExp(`have no provenance row \\(pass --adopt[^)]*\\):\\n  ${newVector.servedPath}$`, 'u'),
      { tag: 'v0.2.0', adopt: false },
    );

    const plan = await sync(repo, second, { tag: 'v0.2.0' });
    assert.deepEqual(
      plan.writes.filter(({ kind, action }) => kind === 'document' && action !== 'identical')
        .map(({ repoPath, action, mapping }) => ({ repoPath, action, mapping })),
      [
        { repoPath: newVector.repoPath, action: 'create', mapping: 'adopted' },
        { repoPath: NOTES.repoPath, action: 'change', mapping: 'row' },
      ],
    );
    assert.equal(readFileSync(join(repo, NOTES.repoPath), 'utf8'), revisedNotes.text);
    assert.equal(readFileSync(join(repo, newVector.repoPath), 'utf8'), newVector.text);
    assert.equal(loadPlatformCatalog(repo).specPin.tag, 'v0.2.0');
    const provenance = JSON.parse(readFileSync(join(repo, PROVENANCE_PATH), 'utf8'));
    assert.equal(provenance.release.tag, 'v0.2.0');
    assert.equal(provenance.documents.length, 4);
    assert.ok(provenance.documents.every((row) => row.release === 'v0.2.0'), 'every row names the release it came from');
  });
});

test('self-test: a release that the pinned key did not sign is refused', async (t) => {
  await withFixture(standard, async ({ repo, release }) => {
    await assert.doesNotReject(sync(repo, release, { check: true }), 'the near miss: the same release, correctly signed');
  });
  await t.test('the key file is not the pinned key', async () => {
    await withFixture((track) => ({
      repo: track(toyRepo(DOCUMENTS, { publicKeyPem: OTHER.publicKeyPem })),
      release: track(toyRelease()),
    }), async ({ repo, release }) => {
      await assertRefused(repo, release, /has SPKI PEM sha256 [0-9a-f]{64}, but the pinned key toy-spec-key-2026 is/u);
    });
  });
  await t.test('another key signed under the pinned key id', async () => {
    await withFixture((track) => ({
      repo: track(toyRepo()),
      release: track(toyRelease(DOCUMENTS, { signer: OTHER })),
    }), async ({ repo, release }) => {
      await assertRefused(repo, release, /platform-v1\.manifest\.dsse\.json does not verify against the pinned key toy-spec-key-2026/u);
    });
  });
  await t.test('the pinned key signed under another key id', async () => {
    await withFixture((track) => ({
      repo: track(toyRepo()),
      release: track(toyRelease(DOCUMENTS, { keyId: 'some-other-key' })),
    }), async ({ repo, release }) => {
      await assertRefused(repo, release, /platform-v1\.manifest\.dsse\.json carries no signature by the pinned key toy-spec-key-2026/u);
    });
  });
  await t.test('the envelope is missing', async () => {
    await withFixture(standard, async ({ repo, release }) => {
      rmSync(join(release, `${GROUP}.manifest.dsse.json`));
      await assertRefused(repo, release, /release asset platform-v1\.manifest\.dsse\.json is missing/u);
    });
  });
  await t.test('the envelope carries another payload type', async () => {
    await withFixture(standard, async ({ repo, release }) => {
      const path = join(release, `${GROUP}.manifest.dsse.json`);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), payloadType: 'text/plain' }));
      await assertRefused(repo, release, /payload type is text\/plain, expected application\/vnd\.jinn\.profile-manifest\+json/u);
    });
  });
});

test('self-test: an altered document is refused', async () => {
  await withFixture(standard, async ({ repo, release }) => {
    await assert.doesNotReject(sync(repo, release, { check: true }), 'the near miss: the release before it is altered');
    writeText(join(release, 'documents'), NOTES.servedPath, '# Notes, altered\n');
    await assertRefused(
      repo,
      release,
      new RegExp(`release document profiles/notes\\.md has sha256 [0-9a-f]{64}, but platform-v1\\.manifest\\.json names ${sha256(NOTES.text)}`, 'u'),
    );
  });
  await withFixture(standard, async ({ repo, release }) => {
    rmSync(join(release, 'documents', ...NOTES.servedPath.split('/')));
    await assertRefused(repo, release, /release document profiles\/notes\.md is missing/u);
  });
});

test('self-test: an altered manifest is refused', async (t) => {
  const alter = (bytes) => Buffer.from(bytes.toString('utf8').replace(sha256(NOTES.text), sha256('# Notes, altered\n')), 'utf8');
  await t.test('the manifest file no longer matches what was signed', async () => {
    await withFixture(standard, async ({ repo, release }) => {
      await assert.doesNotReject(sync(repo, release, { check: true }), 'the near miss: the manifest as signed');
      const path = join(release, `${GROUP}.manifest.json`);
      writeFileSync(path, alter(readFileSync(path)));
      writeText(join(release, 'documents'), NOTES.servedPath, '# Notes, altered\n');
      await assertRefused(repo, release, /platform-v1\.manifest\.dsse\.json does not envelope the exact bytes of platform-v1\.manifest\.json/u);
    });
  });
  await t.test('the manifest and the enveloped payload were altered together', async () => {
    await withFixture(standard, async ({ repo, release }) => {
      const manifestPath = join(release, `${GROUP}.manifest.json`);
      const altered = alter(readFileSync(manifestPath));
      writeFileSync(manifestPath, altered);
      const envelopePath = join(release, `${GROUP}.manifest.dsse.json`);
      const envelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
      writeFileSync(envelopePath, JSON.stringify({ ...envelope, payload: altered.toString('base64') }));
      writeText(join(release, 'documents'), NOTES.servedPath, '# Notes, altered\n');
      await assertRefused(repo, release, /platform-v1\.manifest\.dsse\.json does not verify against the pinned key/u);
    });
  });
  await t.test('the manifest is for another release group', async () => {
    await withFixture((track) => ({
      repo: track(toyRepo()),
      release: track(toyRelease(DOCUMENTS, { manifestGroup: 'some-other-group' })),
    }), async ({ repo, release }) => {
      await assertRefused(repo, release, /platform-v1\.manifest\.json names release group some-other-group, expected platform-v1/u);
    });
  });
});

test('self-test: a signed manifest that is malformed is still refused', async (t) => {
  const cases = [
    {
      name: 'an unknown manifest version',
      reshape: (manifest) => ({ ...manifest, version: 2 }),
      pattern: /platform-v1\.manifest\.json has manifest version 2, expected 1/u,
    },
    {
      name: 'no documents',
      reshape: (manifest) => ({ ...manifest, documents: [] }),
      pattern: /platform-v1\.manifest\.json lists no documents/u,
    },
    {
      name: 'a document without a digest',
      reshape: (manifest) => ({ ...manifest, documents: manifest.documents.map(({ sha256: _, ...rest }) => rest) }),
      pattern: /documents\[0\] \(schemas\/thing\/v1\) carries no lowercase SHA-256 digest/u,
    },
    {
      name: 'a document without a source package',
      reshape: (manifest) => ({ ...manifest, documents: manifest.documents.map(({ sourcePackage: _, ...rest }) => rest) }),
      pattern: /documents\[0\] \(schemas\/thing\/v1\) names no source package/u,
    },
    {
      name: 'a path listed twice',
      reshape: (manifest) => ({ ...manifest, documents: [...manifest.documents, manifest.documents[0]] }),
      pattern: /schemas\/thing\/v1 is listed more than once/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await withFixture((track) => ({
        repo: track(toyRepo()),
        release: track(toyRelease(DOCUMENTS, { reshape: entry.reshape })),
      }), async ({ repo, release }) => {
        await assertRefused(repo, release, entry.pattern);
      });
    });
  }
});

test('self-test: a document the manifests do not list is refused', async (t) => {
  await t.test('an extra file in the documents tree', async () => {
    await withFixture(standard, async ({ repo, release }) => {
      await assert.doesNotReject(sync(repo, release, { check: true }), 'the near miss: the tree the manifest lists');
      writeText(join(release, 'documents'), 'profiles/unlisted.md', '# Unlisted\n');
      await assertRefused(repo, release, /the release holds documents no signed manifest lists:\n  profiles\/unlisted\.md$/u);
    });
  });
  await t.test('a manifest for a group the catalog does not serve', async () => {
    await withFixture(standard, async ({ repo, release }) => {
      writeFileSync(join(release, 'surprise-v1.manifest.json'), '{}\n');
      await assertRefused(repo, release, /the release ships a manifest for surprise-v1/u);
    });
  });
});

test('self-test: a provenance row with no released document is refused', async () => {
  await withFixture((track) => ({
    repo: track(toyRepo()),
    first: track(toyRelease()),
    second: track(toyRelease([SCHEMA, VECTOR])),
  }), async ({ repo, first, second }) => {
    await sync(repo, first);
    await assert.doesNotReject(sync(repo, first, { check: true }), 'the near miss: every row still has its document');
    await assertRefused(
      repo,
      second,
      /provenance rows name documents the release does not ship:\n  profiles\/notes\.md$/u,
      { tag: 'v0.2.0' },
    );
  });
});

test('self-test: a pinned tag that comes back with another manifest is refused', async () => {
  await withFixture((track) => ({
    repo: track(toyRepo()),
    first: track(toyRelease()),
    second: track(toyRelease([SCHEMA, { ...NOTES, text: '# Notes, republished\n' }, VECTOR])),
  }), async ({ repo, first, second }) => {
    await sync(repo, first);
    await assert.doesNotReject(sync(repo, second, { check: true, tag: 'v0.1.1' }), 'the near miss: a new tag');
    await assertRefused(
      repo,
      second,
      /release v0\.1\.0 ships a platform-v1 manifest with sha256 [0-9a-f]{64}, but the catalog pins [0-9a-f]{64} for that tag/u,
    );
  });
});

test('self-test: a damaged provenance manifest is refused', async (t) => {
  const cases = [
    {
      name: 'not JSON',
      damage: () => '{',
      pattern: /architecture\/spec-provenance\.v1\.json is not valid JSON/u,
    },
    {
      name: 'another schema version',
      damage: (provenance) => JSON.stringify({ ...provenance, schemaVersion: 2 }),
      pattern: /architecture\/spec-provenance\.v1\.json is not a version 1 provenance manifest/u,
    },
    {
      name: 'a repository path that leaves the tree',
      damage: (provenance) => JSON.stringify({
        ...provenance,
        documents: provenance.documents.map((row) => ({ ...row, repoPath: `../${row.repoPath}` })),
      }),
      pattern: /documents\[0\] repoPath must be a normalized repository-relative path/u,
    },
    {
      name: 'a row that names no release',
      damage: (provenance) => JSON.stringify({
        ...provenance,
        documents: provenance.documents.map(({ release: _, ...row }) => row),
      }),
      pattern: /documents\[0\] names no release it came from/u,
    },
    {
      name: 'two rows for one file',
      damage: (provenance) => JSON.stringify({
        ...provenance,
        documents: provenance.documents.map((row) => ({ ...row, repoPath: provenance.documents[0].repoPath })),
      }),
      pattern: /documents\[1\] repeats repository path packages\/fixture\/protocol\/fixtures\/vector-1\.json/u,
    },
    {
      name: 'a row that points outside the declared surface',
      damage: (provenance) => JSON.stringify({
        ...provenance,
        documents: provenance.documents.map((row) => ({ ...row, repoPath: row.repoPath.replace('/profiles/', '/src/') })),
      }),
      pattern: /profiles\/notes\.md maps to packages\/fixture\/protocol\/src\/notes\.md, which is outside the schemas, profiles, and fixtures/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await withFixture(standard, async ({ repo, release }) => {
        await sync(repo, release);
        const path = join(repo, PROVENANCE_PATH);
        writeFileSync(path, entry.damage(JSON.parse(readFileSync(path, 'utf8'))));
        await assertRefused(repo, release, entry.pattern, { adopt: false });
      });
    });
  }
});

test('self-test: a released document that cannot be placed is refused', async (t) => {
  const cases = [
    {
      name: 'no provenance row and no --adopt',
      documents: DOCUMENTS,
      options: { adopt: false },
      pattern: /have no provenance row \(pass --adopt[^)]*\):\n {2}@jinn-network\/fixture-protocol\/fixtures\/vector-1\.json\n {2}profiles\/notes\.md\n {2}schemas\/thing\/v1$/u,
    },
    {
      name: 'an identifier path this tree serves nowhere',
      documents: [...DOCUMENTS, { servedPath: 'schemas/unknown/v1', text: '{}\n' }],
      pattern: /no provenance row and no rule in this tree places these released documents:\n {2}schemas\/unknown\/v1$/u,
    },
    {
      name: 'a package-scoped path outside the declared surface',
      documents: [...DOCUMENTS, { servedPath: `${PACKAGE}/src/index.ts`, text: 'export {};\n' }],
      pattern: /maps to packages\/fixture\/protocol\/src\/index\.ts, which is outside the schemas, profiles, and fixtures @jinn-network\/fixture-protocol declares/u,
    },
    {
      name: 'a path that leaves the tree',
      documents: [...DOCUMENTS, { servedPath: '../escape.json', text: '{}\n', unwritten: true }],
      pattern: /must name a canonical relative spec\.jinn\.network hosted path/u,
    },
    {
      name: 'a Git control file',
      documents: [...DOCUMENTS, { servedPath: `${PACKAGE}/fixtures/.gitattributes`, text: '* text\n' }],
      pattern: /must name a canonical relative spec\.jinn\.network hosted path/u,
    },
    {
      name: 'a source package the catalog does not hold',
      documents: [...DOCUMENTS, { servedPath: 'schemas/elsewhere/v1', text: '{}\n', sourcePackage: '@jinn-network/missing' }],
      pattern: /schemas\/elsewhere\/v1 names source package @jinn-network\/missing, which the catalog does not hold/u,
    },
    {
      name: 'a source package in another release group',
      documents: [...DOCUMENTS, { servedPath: 'schemas/elsewhere/v1', text: '{}\n', sourcePackage: '@jinn-network/core' }],
      pattern: /schemas\/elsewhere\/v1 is listed by platform-v1, but its source package @jinn-network\/core is in legacy-product-lines/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await withFixture((track) => ({
        repo: track(toyRepo()),
        release: track(toyRelease(entry.documents)),
      }), async ({ repo, release }) => {
        await assertRefused(repo, release, entry.pattern, entry.options);
      });
    });
  }
});

test('self-test: a write target behind a symbolic link is refused', async () => {
  await withFixture((track) => ({
    repo: track(toyRepo()),
    release: track(toyRelease()),
    outside: track(mkdtempSync(join(tmpdir(), 'jinn-toy-outside-'))),
  }), async ({ repo, release, outside }) => {
    // The rows now place the vector, so the only thing between the release and a write
    // outside the checkout is the write target's own inspection.
    await sync(repo, release);
    await assert.doesNotReject(sync(repo, release, { check: true }), 'the near miss: a real directory');
    rmSync(join(repo, PACKAGE_PATH, 'fixtures'), { recursive: true });
    symlinkSync(outside, join(repo, PACKAGE_PATH, 'fixtures'));
    await assertRefused(
      repo,
      release,
      /write target packages\/fixture\/protocol\/fixtures\/vector-1\.json crosses a symbolic link/u,
      { adopt: false },
    );
    assert.deepEqual(readdirSync(outside), [], 'nothing is written through the link');
  });
});

test('self-test: the signing key identity is the catalog pin or both flags, never a guess', async () => {
  await withFixture(standard, async ({ repo, release }) => {
    await assertRefused(
      repo,
      release,
      /no signing key is pinned: the catalog pins no spec release, so --key-id and --public-key-sha256 are required/u,
      { keyId: undefined, publicKeySha256: undefined },
    );
    await assertRefused(repo, release, /--key-id and --public-key-sha256 must be given together/u, {
      publicKeySha256: undefined,
    });
    await assertRefused(repo, release, /--public-key-sha256 must be a lowercase SHA-256 digest/u, {
      publicKeySha256: IDENTITY.publicKeySha256.toUpperCase(),
    });
    await assertRefused(repo, release, /a spec release tag is v<major>\.<minor>\.<patch>, got main/u, { tag: 'main' });
    await assertRefused(repo, release, /--tag is required: the catalog pins no spec release to sync/u, {
      tag: undefined,
    });

    await sync(repo, release);
    await assertRefused(
      repo,
      release,
      /the catalog pins signing key toy-spec-key-2026 \([0-9a-f]{64}\); a sync does not replace a pinned key/u,
      { publicKeySha256: canonicalPublicKeySha256(OTHER.publicKeyPem).sha256 },
    );
  });
});

test('fetchRelease lays out the attached manifests beside the tagged documents tree', async () => {
  await withFixture((track) => ({
    repo: track(toyRepo()),
    release: track(toyRelease()),
  }), async ({ repo, release }) => {
    const requested = [];
    const fetched = [];
    const plan = await syncSpecRelease({
      repoRoot: repo,
      tag: 'v0.1.0',
      check: true,
      adopt: true,
      ...IDENTITY,
      fetch: async (url) => {
        requested.push(url);
        const name = url.slice(url.lastIndexOf('/') + 1);
        return { status: 200, arrayBuffer: async () => readFileSync(join(release, name)) };
      },
      runGit: (args) => {
        fetched.push(args);
        const target = args.at(-1);
        for (const document of DOCUMENTS) writeText(join(target, 'documents'), document.servedPath, document.text);
      },
    });
    assert.deepEqual(requested, [
      'https://github.com/Jinn-Network/spec/releases/download/v0.1.0/platform-v1.manifest.json',
      'https://github.com/Jinn-Network/spec/releases/download/v0.1.0/platform-v1.manifest.dsse.json',
    ]);
    assert.deepEqual(fetched.map((args) => args.slice(0, -1)), [[
      '-c', 'core.autocrlf=false',
      'clone', '--quiet', '--depth', '1', '--branch', 'v0.1.0',
      'https://github.com/Jinn-Network/spec.git',
    ]]);
    assert.equal(plan.writes.filter(({ kind }) => kind === 'document').length, 3);
    assert.equal(existsSync(dirname(fetched[0].at(-1))), false, 'the fetched copy is removed afterwards');
  });
});

test('self-test: a release that does not attach a signed manifest is refused', async () => {
  const into = mkdtempSync(join(tmpdir(), 'jinn-toy-fetch-'));
  try {
    await assert.rejects(
      fetchRelease({
        tag: 'v0.1.0',
        groups: [GROUP],
        into,
        fetch: async (url) => ({ status: url.endsWith('.dsse.json') ? 404 : 200, arrayBuffer: async () => Buffer.from('{}') }),
        runGit: () => {},
      }),
      /releases\/download\/v0\.1\.0\/platform-v1\.manifest\.dsse\.json returned 404; release v0\.1\.0 must attach platform-v1\.manifest\.dsse\.json/u,
    );
    await assert.rejects(
      fetchRelease({
        tag: 'v0.1.0',
        groups: [GROUP],
        into,
        fetch: async () => ({ status: 200, arrayBuffer: async () => Buffer.from('{}') }),
        runGit: () => {},
      }),
      /Jinn-Network\/spec at v0\.1\.0 has no documents directory/u,
    );
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
});

test('the CLI prints the report and exits 0 on a check-only run, and exits 1 naming a refusal', async () => {
  await withFixture(standard, async ({ repo, release }) => {
    const args = [
      SCRIPT, '--root', repo, '--release-dir', release, '--tag', 'v0.1.0', '--check', '--adopt',
      '--key-id', IDENTITY.keyId, '--public-key-sha256', IDENTITY.publicKeySha256,
    ];
    const before = snapshot(repo);
    const checked = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /^check only: nothing written; a sync would write 4 files$/mu);
    assert.deepEqual(snapshot(repo), before);

    writeText(join(release, 'documents'), NOTES.servedPath, '# Notes, altered\n');
    const refused = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /^spec release sync failed: release document profiles\/notes\.md has sha256/u);
    assert.deepEqual(snapshot(repo), before);
  });
});

test('the CLI refuses an unknown argument and a flag without its value', () => {
  assert.throws(() => parseArgs(['--force']), /unknown argument: --force/u);
  assert.throws(() => parseArgs(['--tag']), /--tag requires a value/u);
  assert.throws(() => parseArgs(['--tag', '--check']), /--tag requires a value/u);
  assert.deepEqual(parseArgs(['--tag', 'v0.1.0', '--check', '--root', '/somewhere']), {
    repoRoot: '/somewhere',
    check: true,
    adopt: false,
    tag: 'v0.1.0',
  });
});
