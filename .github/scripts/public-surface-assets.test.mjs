import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const implementation = import('./public-surface-assets.mjs');

const PACKAGE_NAME = '@jinn-network/public-surface-fixture';
const PACKAGE_PATH = 'packages/fixture/public-surface';
const repoRoot = resolve(import.meta.dirname, '../..');

function fixturePackage(root, publicSurface) {
  const directory = join(root, PACKAGE_PATH);
  mkdirSync(directory, { recursive: true });
  return {
    name: PACKAGE_NAME,
    directory: PACKAGE_PATH,
    catalog: { publicSurface },
    manifest: {
      exports: {
        './testing': {
          import: './dist/testing.js',
          types: './dist/testing.d.ts',
        },
      },
    },
  };
}

test('enumerates non-identity schemas, fixtures, and conformance source/targets as exact assets', async () => {
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'],
      profiles: [],
      fixtures: ['fixtures'],
      conformance: ['./testing'],
    });
    mkdirSync(join(root, PACKAGE_PATH, 'schemas'), { recursive: true });
    mkdirSync(join(root, PACKAGE_PATH, 'fixtures'), { recursive: true });
    mkdirSync(join(root, PACKAGE_PATH, 'src'), { recursive: true });
    writeFileSync(join(root, PACKAGE_PATH, 'schemas/plain.schema.json'), '{"type":"object"}\n');
    writeFileSync(
      join(root, PACKAGE_PATH, 'fixtures/case.json'),
      '{"$id":"https://spec.jinn.network/fixtures/not-an-id","profile":"https://spec.jinn.network/fixtures/not-a-claim"}\n',
    );
    writeFileSync(join(root, PACKAGE_PATH, 'src/testing.ts'), 'export {};\n');

    assert.deepEqual(enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }), [
      {
        claim: null,
        export: null,
        kind: 'fixtures',
        package: PACKAGE_NAME,
        packedTargets: [],
        path: `${PACKAGE_PATH}/fixtures/case.json`,
        relativeSource: 'fixtures/case.json',
      },
      {
        claim: null,
        export: null,
        kind: 'schemas',
        package: PACKAGE_NAME,
        packedTargets: [],
        path: `${PACKAGE_PATH}/schemas/plain.schema.json`,
        relativeSource: 'schemas/plain.schema.json',
      },
      {
        claim: null,
        export: './testing',
        kind: 'conformance',
        package: PACKAGE_NAME,
        packedTargets: ['./dist/testing.d.ts', './dist/testing.js'],
        path: `${PACKAGE_PATH}/src/testing.ts`,
        relativeSource: 'src/testing.ts',
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git candidate inventory excludes ignored public-root files and includes unignored untracked assets', async () => {
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'], profiles: [], fixtures: [], conformance: [],
    });
    mkdirSync(join(root, PACKAGE_PATH, 'schemas'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '**/.DS_Store\n');
    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/tracked.schema.json'),
      '{"type":"object"}\n',
    );
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });

    const baseline = enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] });
    writeFileSync(join(root, PACKAGE_PATH, 'schemas/.DS_Store'), 'machine-local\n');
    assert.deepEqual(
      enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      baseline,
      'an ignored machine file must not alter public asset bytes or counts',
    );

    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/untracked.schema.json'),
      '{"type":"string"}\n',
    );
    const withUntracked = enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] });
    assert.equal(withUntracked.length, baseline.length + 1);
    assert.ok(withUntracked.some(({ relativeSource }) => (
      relativeSource === 'schemas/untracked.schema.json'
    )));
    assert.equal(withUntracked.some(({ relativeSource }) => relativeSource.endsWith('.DS_Store')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects multiple top-level Jinn identity fields before collision selection', async () => {
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'], profiles: [], fixtures: [], conformance: [],
    });
    mkdirSync(join(root, PACKAGE_PATH, 'schemas'), { recursive: true });
    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/dual.schema.json'),
      JSON.stringify({
        $id: 'https://spec.jinn.network/schemas/alpha',
        profile: 'https://spec.jinn.network/profiles/beta',
      }),
    );
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /dual\.schema\.json declares multiple public self-identifying claims: \$id=https:\/\/spec\.jinn\.network\/schemas\/alpha, profile=https:\/\/spec\.jinn\.network\/profiles\/beta/u,
      'one document must not silently choose its first qualifying identity field',
    );

    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/beta.schema.json'),
      JSON.stringify({ profile: 'https://spec.jinn.network/profiles/beta' }),
    );
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /dual\.schema\.json declares multiple public self-identifying claims/u,
      'a second beta claimant must not hide the ambiguous document',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Jinn identifiers map only to canonical relative hosted paths', async () => {
  const { jinnIdentifierServedPath } = await implementation;
  assert.equal(
    jinnIdentifierServedPath('https://spec.jinn.network/records/trace/v1/schema'),
    'records/trace/v1/schema',
  );

  for (const identifier of [
    'https://spec.jinn.network/',
    'https://spec.jinn.network/.',
    'https://spec.jinn.network/../escaped.json',
    'https://spec.jinn.network/a//b',
    'https://spec.jinn.network/a/./b',
    'https://spec.jinn.network/a/../b',
    'https://spec.jinn.network/%2e%2e/escaped.json',
    'https://spec.jinn.network/a%2fb',
    'https://spec.jinn.network/a%5cb',
    'https://spec.jinn.network/a\\b',
    'https://spec.jinn.network//server/share',
    'https://spec.jinn.network/C:/windows/path',
    'https://SPEC.jinn.network/schema',
    'https://spec.jinn.network:443/schema',
    'https://user@spec.jinn.network/schema',
    'https://spec.jinn.network/schema?draft=1',
    'https://spec.jinn.network/schema#fragment',
    'https://spec.jinn.network/manifest.json',
    'https://spec.jinn.network/manifest.dsse.json',
  ]) {
    assert.throws(
      () => jinnIdentifierServedPath(identifier, 'fixture identity'),
      /fixture identity must name a canonical relative spec\.jinn\.network hosted path/u,
      identifier,
    );
  }
});

// --- DR-2026-08-04, transition window closed: spec.jinn.network only ---

test('the retired apex origin is rejected by name, citing the re-seal', async () => {
  // Not a generic shape complaint: the whole point of keeping the retired origin recognized
  // is that a stray unmigrated document says so, in the words of the decision that moved it.
  const { jinnIdentifierServedPath } = await implementation;
  for (const identifier of [
    'https://jinn.network/records/trajectory/1.0/schema',
    'https://jinn.network/schemas/task/v1',
    'https://JINN.network/schema',
    'https://jinn.network:443/schema',
    'https://user@jinn.network/schema',
    'https://jinn.network/',
  ]) {
    assert.throws(
      () => jinnIdentifierServedPath(identifier, 'fixture identity'),
      /fixture identity names the retired https:\/\/jinn\.network\/ origin; protocol identifiers moved to https:\/\/spec\.jinn\.network\/ in the DR-2026-08-04 re-seal/u,
      identifier,
    );
  }
});

test('a retired-origin claim is still detected as a claim, so it fails loudly', async () => {
  // The fail-open this guards from the other side: if the enumerator stopped recognizing the
  // retired origin entirely, an unmigrated document would pass as "declares nothing".
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'], profiles: [], fixtures: [], conformance: [],
    });
    mkdirSync(join(root, PACKAGE_PATH, 'schemas'), { recursive: true });
    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/unmigrated.schema.json'),
      JSON.stringify({ $id: 'https://jinn.network/schemas/task/v1' }),
    );
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /unmigrated\.schema\.json \$id names the retired https:\/\/jinn\.network\/ origin/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a neighbouring host that merely contains a recognized one is not an identifier', async () => {
  const { jinnIdentifierServedPath } = await implementation;
  for (const identifier of [
    'https://notjinn.network/schema',
    'https://jinn.network.evil.example/schema',
    'https://spec.jinn.network.evil.example/schema',
    'https://evil.example/https://jinn.network/schema',
  ]) {
    assert.throws(
      () => jinnIdentifierServedPath(identifier, 'fixture identity'),
      /fixture identity must name a canonical relative spec\.jinn\.network hosted path/u,
      identifier,
    );
  }
});

test('a canonical-origin claim is detected as a claim, not silently unclaimed', async () => {
  // The fail-open this guards: an origin the enumerator does not recognize yields no claim,
  // so a migrated document would pass as "declares nothing" instead of being validated.
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'], profiles: [], fixtures: [], conformance: [],
    });
    mkdirSync(join(root, PACKAGE_PATH, 'schemas'), { recursive: true });
    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/migrated.schema.json'),
      JSON.stringify({ $id: 'https://spec.jinn.network/records/trace/v1/schema' }),
    );
    const [asset] = enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] });
    assert.deepEqual(asset.claim, {
      field: '$id',
      identifier: 'https://spec.jinn.network/records/trace/v1/schema',
      servedPath: 'records/trace/v1/schema',
    });

    // ... and a malformed one under the canonical origin still fails loudly rather than
    // dropping out of the claim set.
    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/escape.schema.json'),
      JSON.stringify({ $id: 'https://spec.jinn.network/%2e%2e/escaped.json' }),
    );
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /escape\.schema\.json \$id must name a canonical relative spec\.jinn\.network hosted path/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a half-migrated document fails on the identity that did not move', async () => {
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'], profiles: [], fixtures: [], conformance: [],
    });
    mkdirSync(join(root, PACKAGE_PATH, 'schemas'), { recursive: true });
    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/half-migrated.schema.json'),
      JSON.stringify({
        $id: 'https://spec.jinn.network/schemas/alpha',
        profile: 'https://jinn.network/profiles/beta',
      }),
    );
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /half-migrated\.schema\.json profile names the retired https:\/\/jinn\.network\/ origin/u,
      'the unmoved identity must be named, not quietly ignored',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enumeration rejects a semantically Jinn identifier with noncanonical URL spelling', async () => {
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'], profiles: [], fixtures: [], conformance: [],
    });
    mkdirSync(join(root, PACKAGE_PATH, 'schemas'), { recursive: true });
    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/noncanonical.schema.json'),
      JSON.stringify({ $id: 'https://JINN.network/records/noncanonical/schema' }),
    );
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /noncanonical\.schema\.json \$id names the retired https:\/\/jinn\.network\/ origin/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enumeration rejects an encoded traversal identity before exposing a served path', async () => {
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'], profiles: [], fixtures: [], conformance: [],
    });
    mkdirSync(join(root, PACKAGE_PATH, 'schemas'), { recursive: true });
    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/escape.schema.json'),
      JSON.stringify({ $id: 'https://spec.jinn.network/%2e%2e/escaped.json' }),
    );
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /escape\.schema\.json \$id must name a canonical relative spec\.jinn\.network hosted path/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all 45 current Jinn self-identifiers remain valid canonical hosted paths', async () => {
  const { enumeratePublicSurfaceAssets, jinnIdentifierServedPath } = await implementation;
  const { loadCatalogPackages } = await import('./platform-catalog.mjs');
  const claims = enumeratePublicSurfaceAssets({
    repoRoot,
    packages: loadCatalogPackages(repoRoot),
  }).filter(({ claim }) => claim !== null);
  assert.equal(claims.length, 45);
  for (const { claim } of claims) {
    assert.equal(jinnIdentifierServedPath(claim.identifier), claim.servedPath);
  }
});

test('rejects a declared public root that is a symlink', async () => {
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'], profiles: [], fixtures: [], conformance: [],
    });
    mkdirSync(join(root, 'outside-schemas'), { recursive: true });
    writeFileSync(join(root, 'outside-schemas/item.schema.json'), '{"type":"object"}\n');
    symlinkSync(join(root, 'outside-schemas'), join(root, PACKAGE_PATH, 'schemas'));
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /publicSurface\.schemas.*symlink/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a symlink nested below a declared public root', async () => {
  const { enumeratePublicSurfaceAssets } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-public-assets-'));
  try {
    const pkg = fixturePackage(root, {
      schemas: ['schemas'], profiles: [], fixtures: [], conformance: [],
    });
    mkdirSync(join(root, PACKAGE_PATH, 'schemas'), { recursive: true });
    writeFileSync(join(root, 'outside.schema.json'), '{"type":"object"}\n');
    symlinkSync(join(root, 'outside.schema.json'), join(root, PACKAGE_PATH, 'schemas/alias.schema.json'));
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /publicSurface\.schemas.*schemas\/alias\.schema\.json.*symlink/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
