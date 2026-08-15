import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildProfileRoot, manifestBytes } from './build-profile-root.mjs';
import { loadCatalogPackages } from './platform-catalog.mjs';
import {
  fixtureCatalog,
  fixtureRepo,
  packageEntry,
} from './platform-catalog-test-fixture.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const SHA = 'e'.repeat(40);

function controlledRepo(packages, { resolvableIdentifiers } = {}) {
  const catalog = fixtureCatalog();
  if (resolvableIdentifiers) catalog.resolvableIdentifiers = resolvableIdentifiers;
  const availableCoreIndexes = catalog.packages
    .map((pkg, index) => ({ pkg, index }))
    .filter(({ pkg }) => pkg.name.startsWith('@jinn-network/fixture-core-'))
    .map(({ index }) => index);
  const manifests = {};
  packages.forEach(({ directory, name, manifest, catalog: catalogOverrides = {} }) => {
    const namedIndex = catalog.packages.findIndex((pkg) => pkg.name === name);
    const replacementIndex = namedIndex >= 0 ? namedIndex : availableCoreIndexes.shift();
    catalog.packages[replacementIndex] = packageEntry(name, directory, catalogOverrides);
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
      catalog: { publicSurface: { schemas: [], profiles: ['profiles'], fixtures: [], conformance: [] } },
    },
    ...extraPackages,
  ]);
  const packageDir = join(root, 'packages/evidence/protocol');
  mkdirSync(join(packageDir, 'profiles/execution-evidence/v1/schemas'), { recursive: true });
  writeFileSync(join(packageDir, 'profiles/execution-evidence/v1/schemas/a.schema.json'), '{"type":"object"}', 'utf8');
  writeFileSync(join(packageDir, 'profiles/execution-evidence/v1/profile.md'), '# profile\n', 'utf8');
  return root;
}

function identityRepo(identifier) {
  const root = controlledRepo([{
    directory: 'packages/evidence/protocol',
    name: '@jinn-network/evidence-protocol',
    manifest: { files: ['schemas/'] },
    catalog: {
      publicSurface: { schemas: ['schemas'], profiles: [], fixtures: [], conformance: [] },
    },
  }]);
  const schemas = join(root, 'packages/evidence/protocol/schemas');
  mkdirSync(schemas, { recursive: true });
  writeFileSync(
    join(schemas, 'identity.schema.json'),
    JSON.stringify({ $id: identifier }),
    'utf8',
  );
  return root;
}

test('documents are served at the paths their profile URIs name', () => {
  const root = scratchRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((d) => d.path), [
      'profiles/execution-evidence/v1/profile.md',
      'profiles/execution-evidence/v1/schemas/a.schema.json',
    ]);
    assert.ok(existsSync(join(outDir, 'profiles/execution-evidence/v1/schemas/a.schema.json')));
    assert.equal(
      readFileSync(join(outDir, 'profiles/execution-evidence/v1/schemas/a.schema.json'), 'utf8'),
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

test('ignored public-root files do not alter profile bytes or counts while unignored untracked files do', () => {
  const root = scratchRepo();
  const baselineOut = mkdtempSync(join(tmpdir(), 'jinn-profile-baseline-out-'));
  const ignoredOut = mkdtempSync(join(tmpdir(), 'jinn-profile-ignored-out-'));
  const untrackedOut = mkdtempSync(join(tmpdir(), 'jinn-profile-untracked-out-'));
  try {
    writeFileSync(join(root, '.gitignore'), '**/.DS_Store\n');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    const baseline = buildProfileRoot({ repoRoot: root, outDir: baselineOut, commit: SHA });

    const profileRoot = join(root, 'packages/evidence/protocol/profiles');
    writeFileSync(join(profileRoot, '.DS_Store'), 'machine-local\n');
    const ignored = buildProfileRoot({ repoRoot: root, outDir: ignoredOut, commit: SHA });
    assert.equal(ignored.documents.length, baseline.documents.length);
    assert.equal(manifestBytes(ignored), manifestBytes(baseline));
    assert.equal(existsSync(join(ignoredOut, 'profiles/.DS_Store')), false);

    writeFileSync(join(profileRoot, 'untracked.json'), '{"type":"string"}\n');
    const untracked = buildProfileRoot({ repoRoot: root, outDir: untrackedOut, commit: SHA });
    assert.equal(untracked.documents.length, baseline.documents.length + 1);
    assert.ok(untracked.documents.some(({ path }) => path === 'profiles/untracked.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(baselineOut, { recursive: true, force: true });
    rmSync(ignoredOut, { recursive: true, force: true });
    rmSync(untrackedOut, { recursive: true, force: true });
  }
});

test('the profile manifest binds catalog digest, release group, lane, and exact package set', () => {
  const root = scratchRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const catalogDigest = createHash('sha256')
      .update(readFileSync(join(root, 'architecture/platform-packages.v1.json')))
      .digest('hex');
    const manifest = buildProfileRoot({
      repoRoot: root,
      outDir,
      commit: SHA,
      catalogDigest,
      releaseGroup: 'platform-v1',
      lane: 'stable',
    });
    assert.deepEqual(manifest.catalog, {
      path: 'architecture/platform-packages.v1.json',
      sha256: catalogDigest,
    });
    assert.equal(manifest.releaseGroup, 'platform-v1');
    assert.equal(manifest.lane, 'stable');
    const expectedPackages = loadCatalogPackages(root, { releaseGroup: 'platform-v1' })
      .map(({ name }) => name);
    assert.deepEqual(manifest.packages, expectedPackages);
    assert.equal(new Set(manifest.packages).size, expectedPackages.length);
    assert.ok(manifest.packages.includes('@jinn-network/evidence-protocol'));
    assert.throws(
      () => buildProfileRoot({
        repoRoot: root,
        outDir,
        commit: SHA,
        catalogDigest: '0'.repeat(64),
        releaseGroup: 'platform-v1',
        lane: 'stable',
      }),
      /catalog digest mismatch/u,
    );
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
    catalog: { publicSurface: { schemas: [], profiles: ['profiles'], fixtures: [], conformance: [] } },
  }]);
  const second = join(root, 'packages/trust/core');
  mkdirSync(join(second, 'profiles/execution-evidence/v1'), { recursive: true });
  writeFileSync(join(second, 'profiles/execution-evidence/v1/profile.md'), '# other\n', 'utf8');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    assert.throws(
      () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
      /profiles\/execution-evidence\/v1\/profile\.md is claimed by both @jinn-network\/evidence-protocol and @jinn-network\/trust-core/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

// The collision cannot arise from on-disk layout -- no filesystem holds a file and a
// directory at one path. It arises only when declared $id claims remap documents into
// the served namespace, which is exactly how a profile directory can become a prefix that
// no document can ever be served at.
test('a served path that is both a document and a directory prefix is refused', () => {
  for (const [name, claims] of [
    ['document-first', ['profiles/collide/1.0', 'profiles/collide/1.0/schemas/inner.schema.json']],
    ['prefix-first', ['profiles/collide/1.0/schemas/inner.schema.json', 'profiles/collide/1.0']],
  ]) {
    const root = scratchRepo([{
      directory: 'packages/trust/core',
      name: '@jinn-network/trust-core',
      manifest: { files: ['profiles/'] },
      catalog: { publicSurface: { schemas: [], profiles: ['profiles'], fixtures: [], conformance: [] } },
    }]);
    const packageDir = join(root, 'packages/trust/core');
    const outDir = mkdtempSync(join(tmpdir(), `jinn-profile-out-${name}-`));
    try {
      mkdirSync(join(packageDir, 'profiles'), { recursive: true });
      claims.forEach((claim, index) => {
        writeFileSync(
          join(packageDir, `profiles/claim-${index}.schema.json`),
          `${JSON.stringify({ $id: `https://spec.jinn.network/${claim}` })}\n`,
          'utf8',
        );
      });
      assert.throws(
        () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
        /profiles\/collide\/1\.0 is both a document and a directory prefix of profiles\/collide\/1\.0\/schemas\/inner\.schema\.json/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});

test('a .jsonld document is served as application/ld+json', () => {
  const root = scratchRepo([{
    directory: 'packages/trust/core',
    name: '@jinn-network/trust-core',
    manifest: { files: ['profiles/'] },
    catalog: { publicSurface: { schemas: [], profiles: ['profiles'], fixtures: [], conformance: [] } },
  }]);
  const packageDir = join(root, 'packages/trust/core');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-jsonld-'));
  try {
    mkdirSync(join(packageDir, 'profiles/vocab'), { recursive: true });
    writeFileSync(join(packageDir, 'profiles/vocab/vocabulary.jsonld'), '{"@context":{}}\n', 'utf8');
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    const document = manifest.documents.find(({ path }) => path.endsWith('vocabulary.jsonld'));
    assert.equal(document.mediaType, 'application/ld+json');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('every registered resolvable identifier resolves in the real platform-v1 tree', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-register-'));
  try {
    const packages = loadCatalogPackages(repoRoot, { releaseGroup: 'platform-v1' });
    const manifest = buildProfileRoot({
      repoRoot,
      outDir,
      commit: SHA,
      releaseGroup: 'platform-v1',
      packages,
    });
    const paths = new Set(manifest.documents.map(({ path }) => path));
    const catalog = JSON.parse(readFileSync(join(repoRoot, 'architecture/platform-packages.v1.json'), 'utf8'));
    const register = catalog.resolvableIdentifiers ?? [];
    assert.ok(register.length > 0, 'the catalog must declare which identifiers dereference');
    for (const entry of register) {
      assert.ok(paths.has(entry.entryPoint), `${entry.identifier} has no served entry point`);
      const servedPath = entry.identifier.replace('https://spec.jinn.network/', '');
      if (entry.resolution === 'prefix') {
        assert.equal(
          paths.has(servedPath),
          false,
          `${entry.identifier} is a prefix and must not also be a document`,
        );
        // One profile, one version segment: a prefix identifier must contain the document it
        // declares as its entry point.
        assert.ok(
          entry.entryPoint.startsWith(`${servedPath}/`),
          `${entry.identifier} is a prefix whose entry point ${entry.entryPoint} lives outside it`,
        );
      }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a prefix identifier whose entry point lives outside it is refused', () => {
  // The defect the re-seal's closure surfaced: `profiles/<name>/v1` was registered as a
  // prefix while its entry point still sat in a leftover `profiles/<name>/1.0/` directory --
  // the identifier addressed one half of a profile and its declared entry the other. The
  // builder accepted it because it only checked the entry point existed somewhere.
  const root = controlledRepo([{
    directory: 'packages/evidence/protocol',
    name: '@jinn-network/evidence-protocol',
    manifest: { files: ['profiles/'] },
    catalog: { publicSurface: { schemas: [], profiles: ['profiles'], fixtures: [], conformance: [] } },
  }], {
    resolvableIdentifiers: [{
      identifier: 'https://spec.jinn.network/profiles/example/v1',
      resolution: 'prefix',
      entryPoint: 'profiles/example/1.0/specification.md',
      owner: '@jinn-network/evidence-protocol',
    }],
  });
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-prefix-escape-'));
  try {
    const packageDir = join(root, 'packages/evidence/protocol');
    mkdirSync(join(packageDir, 'profiles/example/1.0'), { recursive: true });
    mkdirSync(join(packageDir, 'profiles/example/v1'), { recursive: true });
    writeFileSync(join(packageDir, 'profiles/example/1.0/specification.md'), '# stray\n', 'utf8');
    writeFileSync(join(packageDir, 'profiles/example/v1/notes.md'), '# inside\n', 'utf8');
    assert.throws(
      () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
      /profiles\/example\/v1 is registered as a prefix but its entry point profiles\/example\/1\.0\/specification\.md is not inside profiles\/example\/v1\//u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

// Scoped to profile crates. A fixture crate describes a captured evidence bundle, so its
// encodingFormat names the original source file's type, not how the served fixture copy
// is typed -- fixture bytes are served opaquely on purpose.
test('every profile RO-Crate encodingFormat agrees with the manifest media type it is served under', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-crate-'));
  try {
    const packages = loadCatalogPackages(repoRoot, { releaseGroup: 'platform-v1' });
    const manifest = buildProfileRoot({
      repoRoot,
      outDir,
      commit: SHA,
      releaseGroup: 'platform-v1',
      packages,
    });
    const mediaTypes = new Map(manifest.documents.map(({ path, mediaType }) => [path, mediaType]));
    const crates = manifest.documents.filter(({ path }) => (
      path.endsWith('/ro-crate-metadata.json') && !path.startsWith('@')
    ));
    assert.ok(crates.length > 0, 'the served tree must contain at least one profile RO-Crate');
    for (const crate of crates) {
      const crateRoot = crate.path.slice(0, crate.path.lastIndexOf('/'));
      const graph = JSON.parse(readFileSync(join(outDir, crate.path), 'utf8'))['@graph'] ?? [];
      for (const node of graph) {
        if (typeof node.encodingFormat !== 'string') continue;
        const served = `${crateRoot}/${node['@id']}`;
        if (!mediaTypes.has(served)) continue;
        assert.equal(
          mediaTypes.get(served),
          node.encodingFormat,
          `${served} is served as ${mediaTypes.get(served)} but its RO-Crate declares ${node.encodingFormat}`,
        );
      }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a document is served at its declared $id, not its directory location', () => {
  const root = controlledRepo([{
    directory: 'packages/evidence/repository-ipfs',
    name: '@jinn-network/evidence-repository-ipfs',
    manifest: { files: ['dist/', 'profile/'] },
    catalog: { publicSurface: { schemas: [], profiles: ['profile'], fixtures: [], conformance: [] } },
  }]);
  const packageDir = join(root, 'packages/evidence/repository-ipfs');
  mkdirSync(join(packageDir, 'profile/v1'), { recursive: true });
  writeFileSync(
    join(packageDir, 'profile/v1/registration.schema.json'),
    JSON.stringify({ $id: 'https://spec.jinn.network/profiles/evidence-repository-ipfs-registration/v1/registration.schema.json' }),
    'utf8',
  );
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((d) => d.path), [
      'profiles/evidence-repository-ipfs-registration/v1/registration.schema.json',
    ]);
    assert.ok(existsSync(join(outDir, 'profiles/evidence-repository-ipfs-registration/v1/registration.schema.json')));
    assert.ok(!existsSync(join(outDir, 'profile/v1/registration.schema.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('direct and encoded traversal identifiers fail before creating a sibling output file', () => {
  for (const [name, identifier] of [
    ['direct', 'https://spec.jinn.network/../escaped.json'],
    ['encoded', 'https://spec.jinn.network/%2e%2e/escaped.json'],
  ]) {
    const root = identityRepo(identifier);
    const outputParent = mkdtempSync(join(tmpdir(), `jinn-profile-${name}-escape-`));
    const outDir = join(outputParent, 'profile-root');
    const escaped = join(outputParent, 'escaped.json');
    try {
      assert.throws(
        () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
        /must name a canonical relative spec\.jinn\.network hosted path/u,
      );
      assert.equal(existsSync(escaped), false, 'validation must precede every out-of-root write');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outputParent, { recursive: true, force: true });
    }
  }
});

test('reserved generated metadata paths cannot be claimed by source documents', () => {
  for (const filename of ['manifest.json', 'manifest.dsse.json']) {
    const root = identityRepo(`https://spec.jinn.network/${filename}`);
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-reserved-'));
    try {
      assert.throws(
        () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
        /must name a canonical relative spec\.jinn\.network hosted path/u,
      );
      assert.equal(existsSync(join(outDir, filename)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});

test('the output root must be a real canonical directory, never a symlink', () => {
  const root = identityRepo('https://spec.jinn.network/records/valid/schema');
  const outputParent = mkdtempSync(join(tmpdir(), 'jinn-profile-output-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'jinn-profile-output-outside-'));
  const outDir = join(outputParent, 'profile-root');
  symlinkSync(outside, outDir);
  try {
    assert.throws(
      () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
      /output root.*symbolic link/u,
    );
    assert.equal(existsSync(join(outside, 'records/valid/schema')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputParent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a nested output parent symlink fails before any outside document is created', () => {
  const root = identityRepo('https://spec.jinn.network/records/valid/schema');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-parent-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'jinn-profile-parent-outside-'));
  symlinkSync(outside, join(outDir, 'records'));
  try {
    assert.throws(
      () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
      /output path records.*symbolic link/u,
    );
    assert.equal(existsSync(join(outside, 'valid/schema')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a dangling output target symlink fails before its outside target is created', () => {
  const root = identityRepo('https://spec.jinn.network/records/valid/schema');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-target-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'jinn-profile-target-outside-'));
  mkdirSync(join(outDir, 'records/valid'), { recursive: true });
  const outsideTarget = join(outside, 'created-by-copy');
  symlinkSync(outsideTarget, join(outDir, 'records/valid/schema'));
  try {
    assert.throws(
      () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
      /output target records\/valid\/schema is a symbolic link/u,
    );
    assert.equal(existsSync(outsideTarget), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('an existing special output target fails before any document copy', () => {
  const root = identityRepo('https://spec.jinn.network/records/valid/schema');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-special-target-'));
  const target = join(outDir, 'records/valid/schema');
  mkdirSync(join(outDir, 'records/valid'), { recursive: true });
  execFileSync('mkfifo', [target]);
  try {
    assert.throws(
      () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
      /output target records\/valid\/schema must be a regular file/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a valid nested identifier remains safely hosted below the output root', () => {
  const root = identityRepo('https://spec.jinn.network/records/valid/v1/schema');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-valid-nested-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map(({ path }) => path), ['records/valid/v1/schema']);
    assert.ok(existsSync(join(outDir, 'records/valid/v1/schema')));
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
    catalog: { publicSurface: { schemas: [], profiles: ['profiles'], fixtures: [], conformance: [] } },
  }]);
  const packageDir = join(root, 'packages/discovery/facts/evidence');
  mkdirSync(join(packageDir, 'profiles'), { recursive: true });
  writeFileSync(
    join(packageDir, 'profiles/execution-evidence.1.0.json'),
    JSON.stringify({ profile: 'https://spec.jinn.network/facts/execution-evidence/v1' }),
    'utf8',
  );
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((d) => d.path), ['facts/execution-evidence/v1']);
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
    catalog: { publicSurface: { schemas: [], profiles: ['profiles'], fixtures: [], conformance: [] } },
  }]);
  const packageDir = join(root, 'packages/task-execution/profiles');
  mkdirSync(join(packageDir, 'profiles/task-profiles/repository-work/1.0'), { recursive: true });
  writeFileSync(
    join(packageDir, 'profiles/task-profiles/repository-work/1.0/profile.json'),
    JSON.stringify({ profile: 'https://spec.jinn.network/task-profiles/repository-work/1.0' }),
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
    catalog: { publicSurface: { schemas: [], profiles: ['profiles'], fixtures: [], conformance: [] } },
  }]);
  const packageDir = join(root, 'packages/task-execution/profiles');
  mkdirSync(join(packageDir, 'profiles/fixtures/task-profile/golden'), { recursive: true });
  writeFileSync(
    join(packageDir, 'profiles/fixtures/task-profile/golden/minimal-profile.json'),
    JSON.stringify({
      $id: 'https://spec.jinn.network/fixtures/example-domain/schema',
      profile: 'https://spec.jinn.network/task-profiles/example-domain/1.0',
    }),
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

test('only catalog-declared schema, profile, and fixture paths are walked', () => {
  const root = controlledRepo([{
    directory: 'packages/evidence/protocol',
    name: '@jinn-network/evidence-protocol',
    manifest: { files: ['dist/', 'api/', 'profiles/'] },
    catalog: {
      publicSurface: {
        schemas: ['api/schema-documents'],
        profiles: [],
        fixtures: ['api/examples'],
        conformance: [],
      },
    },
  }]);
  const packageDir = join(root, 'packages/evidence/protocol');
  mkdirSync(join(packageDir, 'api/schema-documents'), { recursive: true });
  mkdirSync(join(packageDir, 'api/examples'), { recursive: true });
  mkdirSync(join(packageDir, 'profiles'), { recursive: true });
  writeFileSync(
    join(packageDir, 'api/schema-documents/declared.schema.json'),
    JSON.stringify({ $id: 'https://spec.jinn.network/schemas/declared' }),
    'utf8',
  );
  writeFileSync(
    join(packageDir, 'api/examples/profile-shaped.json'),
    JSON.stringify({ profile: 'https://spec.jinn.network/fixtures/not-an-identity' }),
    'utf8',
  );
  writeFileSync(join(packageDir, 'profiles/undeclared.json'), '{}', 'utf8');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((document) => document.path), [
      '@jinn-network/evidence-protocol/api/examples/profile-shaped.json',
      'schemas/declared',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('fixture paths are package-qualified so equal package-relative names stay distinct', () => {
  const root = controlledRepo([{
    directory: 'packages/evidence/trace',
    name: '@jinn-network/evidence-trace',
    manifest: { files: ['fixtures/'] },
    catalog: {
      publicSurface: { schemas: [], profiles: [], fixtures: ['fixtures'], conformance: [] },
    },
  }, {
    directory: 'packages/benchmarking/records',
    name: '@jinn-network/benchmarking-records',
    manifest: { files: ['fixtures/'] },
    catalog: {
      publicSurface: { schemas: [], profiles: [], fixtures: ['fixtures'], conformance: [] },
    },
  }]);
  for (const packagePath of ['evidence/trace', 'benchmarking/records']) {
    mkdirSync(join(root, 'packages', packagePath, 'fixtures'), { recursive: true });
    writeFileSync(join(root, 'packages', packagePath, 'fixtures/example.json'), packagePath, 'utf8');
  }
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((document) => document.path), [
      '@jinn-network/benchmarking-records/fixtures/example.json',
      '@jinn-network/evidence-trace/fixtures/example.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('nested fixture declarations override broader profile classification before deduplication', () => {
  const packages = [
    {
      directory: 'packages/evidence/repository-ipfs',
      name: '@jinn-network/evidence-repository-ipfs',
      manifest: { files: ['profile/'] },
      catalog: {
        publicSurface: {
          schemas: [],
          profiles: ['profile'],
          fixtures: ['profile/v1/fixtures'],
          conformance: [],
        },
      },
    },
    {
      directory: 'packages/evidence/repository-oci',
      name: '@jinn-network/evidence-repository-oci',
      manifest: { files: ['profile/'] },
      catalog: {
        publicSurface: {
          schemas: [],
          profiles: ['profile'],
          fixtures: ['profile/v1/fixtures'],
          conformance: [],
        },
      },
    },
  ];
  const root = controlledRepo(packages);
  for (const pkg of packages) {
    const fixtures = join(root, pkg.directory, 'profile/v1/fixtures');
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(
      join(fixtures, 'registration.json'),
      JSON.stringify({
        profile: 'https://spec.jinn.network/fixtures/not-a-document-identity',
        package: pkg.name,
      }),
      'utf8',
    );
  }
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((document) => document.path), [
      '@jinn-network/evidence-repository-ipfs/profile/v1/fixtures/registration.json',
      '@jinn-network/evidence-repository-oci/profile/v1/fixtures/registration.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('nested catalog declarations copy each source file once', () => {
  const root = controlledRepo([{
    directory: 'packages/evidence/trace',
    name: '@jinn-network/evidence-trace',
    manifest: { files: ['schemas/'] },
    catalog: {
      publicSurface: {
        schemas: ['schemas', 'schemas/v1'],
        profiles: [],
        fixtures: [],
        conformance: [],
      },
    },
  }]);
  const packageDir = join(root, 'packages/evidence/trace');
  mkdirSync(join(packageDir, 'schemas/v1'), { recursive: true });
  writeFileSync(join(packageDir, 'schemas/v1/trace.schema.json'), '{}', 'utf8');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((document) => document.path), [
      'schemas/v1/trace.schema.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('duplicate self-identifier claims fail even within one package', () => {
  const root = controlledRepo([{
    directory: 'packages/evidence/trace',
    name: '@jinn-network/evidence-trace',
    manifest: { files: ['schemas/'] },
    catalog: {
      publicSurface: { schemas: ['schemas'], profiles: [], fixtures: [], conformance: [] },
    },
  }]);
  const packageDir = join(root, 'packages/evidence/trace/schemas');
  mkdirSync(packageDir, { recursive: true });
  const duplicate = JSON.stringify({ $id: 'https://spec.jinn.network/schemas/trace/v1' });
  writeFileSync(join(packageDir, 'one.schema.json'), duplicate, 'utf8');
  writeFileSync(join(packageDir, 'two.schema.json'), duplicate, 'utf8');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    assert.throws(
      () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
      /schemas\/trace\/v1 is claimed more than once/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('release-group selection includes core trace schemas and isolates experimental environment schemas', () => {
  const root = controlledRepo([{
    directory: 'packages/evidence/trace',
    name: '@jinn-network/evidence-trace',
    manifest: { files: ['schemas/'] },
    catalog: {
      publicSurface: { schemas: ['schemas'], profiles: [], fixtures: [], conformance: [] },
    },
  }, {
    directory: 'packages/environments/record',
    name: '@jinn-network/environment-record',
    manifest: { files: ['schemas/'] },
    catalog: {
      releaseGroup: 'experimental-environment-supply',
      publishPolicy: 'disabled',
      stability: 'experimental',
      publicSurface: { schemas: ['schemas'], profiles: [], fixtures: [], conformance: [] },
    },
  }]);
  mkdirSync(join(root, 'packages/evidence/trace/schemas'), { recursive: true });
  mkdirSync(join(root, 'packages/environments/record/schemas'), { recursive: true });
  writeFileSync(
    join(root, 'packages/evidence/trace/schemas/trace.schema.json'),
    JSON.stringify({ $id: 'https://spec.jinn.network/schemas/trace/v1' }),
    'utf8',
  );
  writeFileSync(
    join(root, 'packages/environments/record/schemas/environment.schema.json'),
    JSON.stringify({ $id: 'https://spec.jinn.network/schemas/environment/v1' }),
    'utf8',
  );
  const coreOut = mkdtempSync(join(tmpdir(), 'jinn-profile-core-out-'));
  const experimentalOut = mkdtempSync(join(tmpdir(), 'jinn-profile-experimental-out-'));
  try {
    const core = buildProfileRoot({ repoRoot: root, outDir: coreOut, commit: SHA });
    assert.deepEqual(core.documents.map((document) => document.path), [
      'schemas/trace/v1',
    ]);
    const experimental = buildProfileRoot({
      repoRoot: root,
      outDir: experimentalOut,
      commit: SHA,
      releaseGroup: 'experimental-environment-supply',
    });
    assert.deepEqual(experimental.documents.map((document) => document.path), [
      'schemas/environment/v1',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(coreOut, { recursive: true, force: true });
    rmSync(experimentalOut, { recursive: true, force: true });
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

test('the real core root serves trace identities and excludes the experimental environment surface', () => {
  const coreOut = mkdtempSync(join(tmpdir(), 'jinn-profile-core-out-'));
  const experimentalOut = mkdtempSync(join(tmpdir(), 'jinn-profile-experimental-out-'));
  const experimentalPackages = new Set(loadCatalogPackages(repoRoot, {
    releaseGroup: 'experimental-environment-supply',
  }).map(({ name }) => name));
  try {
    const core = buildProfileRoot({ repoRoot, outDir: coreOut, commit: SHA });
    const corePaths = new Set(core.documents.map((document) => document.path));
    assert.ok(corePaths.has('schemas/trace/v1'));
    assert.ok(corePaths.has('schemas/trace-derivation-statement/v1'));
    assert.equal(corePaths.has('schemas/environment/v1'), false);
    assert.deepEqual(
      core.documents.filter((document) => experimentalPackages.has(document.sourcePackage)),
      [],
    );

    const experimental = buildProfileRoot({
      repoRoot,
      outDir: experimentalOut,
      commit: SHA,
      releaseGroup: 'experimental-environment-supply',
    });
    assert.ok(experimental.documents.some(
      (document) => document.path === 'schemas/environment/v1'
        && document.sourcePackage === '@jinn-network/environment-record',
    ));
  } finally {
    rmSync(coreOut, { recursive: true, force: true });
    rmSync(experimentalOut, { recursive: true, force: true });
  }
});

test('URI resolution gate: every real document declaring a spec.jinn.network identifier is served at exactly that path', () => {
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
        if (typeof value !== 'string' || !value.startsWith('https://spec.jinn.network/')) continue;
        checked += 1;
        assert.equal(
          `https://spec.jinn.network/${document.path}`,
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
