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
import { join } from 'node:path';
import { test } from 'node:test';

const implementation = import('./public-surface-assets.mjs');

const PACKAGE_NAME = '@jinn-network/public-surface-fixture';
const PACKAGE_PATH = 'packages/fixture/public-surface';

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
      '{"$id":"https://jinn.network/fixtures/not-an-id","profile":"https://jinn.network/fixtures/not-a-claim"}\n',
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
        $id: 'https://jinn.network/schemas/alpha',
        profile: 'https://jinn.network/profiles/beta',
      }),
    );
    assert.throws(
      () => enumeratePublicSurfaceAssets({ repoRoot: root, packages: [pkg] }),
      /dual\.schema\.json declares multiple public self-identifying claims: \$id=https:\/\/jinn\.network\/schemas\/alpha, profile=https:\/\/jinn\.network\/profiles\/beta/u,
      'one document must not silently choose its first qualifying identity field',
    );

    writeFileSync(
      join(root, PACKAGE_PATH, 'schemas/beta.schema.json'),
      JSON.stringify({ profile: 'https://jinn.network/profiles/beta' }),
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
