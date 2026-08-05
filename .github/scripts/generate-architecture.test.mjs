import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { validateArchitectureControl } from './architecture-control.mjs';
import { loadCatalogPackages, loadPlatformCatalog } from './platform-catalog.mjs';
import { fixtureCatalog, fixtureRepo } from './platform-catalog-test-fixture.mjs';

const implementation = import('./generate-architecture.mjs');
const repoRoot = resolve(import.meta.dirname, '../..');

test('machine view covers the exact catalog split and manifest-owned dependency kinds', async () => {
  const { buildArchitectureReport } = await implementation;
  const report = buildArchitectureReport(repoRoot);
  const catalog = loadPlatformCatalog(repoRoot);
  const packagesRootEntries = catalog.packages.filter(({ path }) => path.startsWith('packages/')).length;
  const platformV1 = catalog.packages.filter(({ releaseGroup }) => releaseGroup === 'platform-v1').length;
  const experimentalEnvironmentSupply = catalog.packages.filter(
    ({ releaseGroup }) => releaseGroup === 'experimental-environment-supply',
  ).length;

  assert.deepEqual(report.counts, {
    adjacentEntries: catalog.packages.length - packagesRootEntries,
    experimentalEnvironmentSupply,
    inventory: catalog.packages.length,
    otherPackagesRootEntries: packagesRootEntries - platformV1 - experimentalEnvironmentSupply,
    packagesRootEntries,
    platformV1,
  });
  assert.equal(report.packages.length, catalog.packages.length);
  assert.deepEqual(
    report.packages.map(({ path }) => path),
    [...report.packages.map(({ path }) => path)].sort(),
  );
  const evidence = report.packages.find(({ name }) => name === '@jinn-network/evidence-protocol');
  assert.deepEqual(
    Object.keys(evidence).sort(),
    [
      'boundaryPolicy', 'classification', 'dependencies', 'domain', 'name', 'ownerGroup',
      'path', 'publicSurface', 'publishPolicy', 'releaseGroup', 'replacedBy', 'requiredGateIds',
      'role', 'stability', 'supersedes', 'tier', 'transition', 'version',
    ],
  );
  assert.deepEqual(Object.keys(evidence.dependencies).sort(), ['optional', 'peer', 'runtime']);
  assert.equal('dev' in evidence.dependencies, false);
});

test('runtime graph preserves dependency kinds, excludes dev-only edges, and records closure and waves', async () => {
  const { buildArchitectureReport } = await implementation;
  const report = buildArchitectureReport(repoRoot);

  assert.deepEqual(report.graph.edgeSections, {
    optional: 'optionalDependencies',
    peer: 'peerDependencies',
    runtime: 'dependencies',
  });
  assert.ok(report.graph.edges.every(({ kind }) => ['optional', 'peer', 'runtime'].includes(kind)));
  assert.equal(report.graph.edges.some(({ from, to }) => (
    from === '@jinn-network/benchmarking-run'
      && to === '@jinn-network/evidence-protocol'
  )), false, 'a dev-only dependency must not enter generated architecture order');
  for (const wave of report.graph.platformV1.waves) assert.deepEqual(wave, [...wave].sort());
  assert.equal(
    Object.keys(report.graph.platformV1.closure).length,
    report.release.platformV1.packages.length,
  );
  assert.deepEqual(
    report.graph.platformV1.closure['@jinn-network/evidence-protocol'],
    [],
  );
  assert.deepEqual(
    new Set(report.graph.platformV1.waves.flat()),
    new Set(report.release.platformV1.packages),
  );
  const waveByPackage = new Map(report.graph.platformV1.waves.flatMap(
    (wave, index) => wave.map((name) => [name, index]),
  ));
  for (const [name, dependencies] of Object.entries(report.graph.platformV1.closure)) {
    for (const dependency of dependencies) {
      assert.ok(waveByPackage.get(dependency) < waveByPackage.get(name), `${dependency} must precede ${name}`);
    }
  }
});

test('release, public-surface, ownership, and transition views reuse their canonical authorities', async () => {
  const { buildArchitectureReport } = await implementation;
  const report = buildArchitectureReport(repoRoot);
  const expectedPlatform = loadCatalogPackages(repoRoot, { releaseGroup: 'platform-v1' })
    .map(({ name }) => name)
    .sort();

  assert.deepEqual(report.release.platformV1.packages, expectedPlatform);
  assert.deepEqual(
    report.release.platformV1.trustedPublishers.map(({ package: name }) => name),
    expectedPlatform,
  );
  assert.deepEqual(report.release.platformV1.policy, {
    canary: true,
    publishPolicies: ['canary-only'],
    stable: false,
    stableBlocker: 'stable-publish-gate: live https://spec.jinn.network profile host verification of the same run',
    stackPublished: true,
  });
  assert.equal(
    report.release.experimentalEnvironmentSupply.packages.length,
    loadCatalogPackages(repoRoot, { releaseGroup: 'experimental-environment-supply' }).length,
  );
  assert.deepEqual(report.release.experimentalEnvironmentSupply.publishPolicies, ['disabled']);
  assert.ok(report.publicSurfaces.packages.some(({ name, schemas }) => (
    name === '@jinn-network/evidence-trace' && schemas.includes('schemas')
  )));
  assert.equal(new Set(report.publicSurfaces.selfIdentifyingClaims.map(({ identifier }) => identifier)).size,
    report.publicSurfaces.selfIdentifyingClaims.length);
  assert.ok(report.publicSurfaces.selfIdentifyingClaims.every(({ identifier }) => (
    identifier.startsWith('https://spec.jinn.network/')
  )));
  assert.deepEqual(
    report.publicSurfaces.assets.find(({ path }) => (
      path === 'packages/benchmarking/records/schemas/benchmark.schema.json'
    )),
    {
      claim: null,
      export: null,
      kind: 'schemas',
      package: '@jinn-network/benchmarking-records',
      packedTargets: [],
      path: 'packages/benchmarking/records/schemas/benchmark.schema.json',
      relativeSource: 'schemas/benchmark.schema.json',
    },
  );
  assert.deepEqual(
    report.publicSurfaces.assets.find(({ path }) => (
      path === 'packages/evidence/trace/fixtures/derivation/execution-golden-base.json'
    )),
    {
      claim: null,
      export: null,
      kind: 'fixtures',
      package: '@jinn-network/evidence-trace',
      packedTargets: [],
      path: 'packages/evidence/trace/fixtures/derivation/execution-golden-base.json',
      relativeSource: 'fixtures/derivation/execution-golden-base.json',
    },
  );
  assert.deepEqual(
    report.publicSurfaces.assets.find(({ path, export: exportKey }) => (
      path === 'packages/evidence/trace/src/testing.ts' && exportKey === './testing'
    )),
    {
      claim: null,
      export: './testing',
      kind: 'conformance',
      package: '@jinn-network/evidence-trace',
      packedTargets: ['./dist/testing.d.ts', './dist/testing.js'],
      path: 'packages/evidence/trace/src/testing.ts',
      relativeSource: 'src/testing.ts',
    },
  );
  assert.deepEqual(report.ownership, validateArchitectureControl({ repoRoot }));
  assert.equal(report.transitions.length, loadPlatformCatalog(repoRoot).packages.filter(({ transition }) => transition).length);
  assert.ok(report.transitions.every(({ transition }) => (
    transition.reason && transition.status && transition.sunsetCondition
  )));
});

test('catalog-declared public identity extraction fails closed on malformed and duplicate claims', async (t) => {
  const { buildArchitectureReport } = await implementation;
  await t.test('malformed schema JSON', () => {
    const catalog = fixtureCatalog();
    catalog.packages[0].publicSurface.schemas = ['schemas'];
    const root = fixtureRepo({ catalog });
    try {
      mkdirSync(join(root, catalog.packages[0].path, 'schemas'), { recursive: true });
      writeFileSync(join(root, catalog.packages[0].path, 'schemas/broken.schema.json'), '{', 'utf8');
      assert.throws(
        () => buildArchitectureReport(root),
        /malformed catalog-declared publicSurface\.schemas JSON schemas\/broken\.schema\.json/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test('duplicate profile identity', () => {
    const catalog = fixtureCatalog();
    catalog.packages[0].publicSurface.profiles = ['profiles'];
    catalog.packages[1].publicSurface.profiles = ['profiles'];
    const root = fixtureRepo({ catalog });
    try {
      for (const pkg of catalog.packages.slice(0, 2)) {
        mkdirSync(join(root, pkg.path, 'profiles'), { recursive: true });
        writeFileSync(
          join(root, pkg.path, 'profiles/profile.json'),
          '{"profile":"https://spec.jinn.network/facts/example/v1"}\n',
          'utf8',
        );
      }
      assert.throws(
        () => buildArchitectureReport(root),
        /duplicate public self-identifying claim https:\/\/spec\.jinn\.network\/facts\/example\/v1/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('generated JSON and Markdown are deterministic, portable, and expose every required section', async () => {
  const { generateArchitectureArtifacts } = await implementation;
  const first = generateArchitectureArtifacts(repoRoot);
  const second = generateArchitectureArtifacts(repoRoot);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), ['platform-topology.md', 'platform-topology.v1.json']);
  for (const bytes of Object.values(first)) {
    assert.equal(bytes.includes(repoRoot), false);
    assert.doesNotMatch(bytes, /generatedAt|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
  }
  const parsed = JSON.parse(first['platform-topology.v1.json']);
  assert.equal(`${JSON.stringify(parsed, null, 2)}\n`, first['platform-topology.v1.json']);
  assert.match(first['platform-topology.md'], /^<!-- GENERATED FILE — DO NOT EDIT/mu);
  for (const heading of [
    '## Inventory', '## Runtime dependency topology', '## Release and trusted publishers',
    '## Public surfaces and identity claims', '### Exact public assets',
    '## Architecture-control ownership',
    '## Transitional and deprecated entries',
  ]) assert.ok(first['platform-topology.md'].includes(heading), heading);
});

test('check mode regenerates separately, byte-compares the exact tracked set, and rejects unknown drift', async () => {
  const { checkGeneratedArchitecture, writeGeneratedArchitecture } = await implementation;
  assert.deepEqual(checkGeneratedArchitecture({ repoRoot }), {
    files: ['platform-topology.md', 'platform-topology.v1.json'],
  });
  const trackedDir = mkdtempSync(join(tmpdir(), 'jinn-architecture-tracked-'));
  try {
    writeGeneratedArchitecture({ repoRoot, outDir: trackedDir });
    assert.deepEqual(checkGeneratedArchitecture({ repoRoot, trackedDir }), {
      files: ['platform-topology.md', 'platform-topology.v1.json'],
    });
    writeFileSync(
      join(trackedDir, 'platform-topology.md'),
      `${readFileSync(join(trackedDir, 'platform-topology.md'), 'utf8')}drift\n`,
    );
    assert.throws(
      () => checkGeneratedArchitecture({ repoRoot, trackedDir }),
      /generated architecture drift: platform-topology\.md/u,
    );
    writeGeneratedArchitecture({ repoRoot, outDir: trackedDir });
    writeFileSync(join(trackedDir, 'unknown.json'), '{}\n');
    assert.throws(
      () => checkGeneratedArchitecture({ repoRoot, trackedDir }),
      /unexpected generated architecture file: unknown\.json/u,
    );
  } finally {
    rmSync(trackedDir, { recursive: true, force: true });
  }
});

test('check mode rejects missing, non-regular, and symlinked generated entries', async (t) => {
  const { checkGeneratedArchitecture, writeGeneratedArchitecture } = await implementation;
  const withTracked = async (callback) => {
    const parent = mkdtempSync(join(tmpdir(), 'jinn-architecture-types-'));
    const trackedDir = join(parent, 'generated');
    try {
      writeGeneratedArchitecture({ repoRoot, outDir: trackedDir });
      await callback({ parent, trackedDir });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  };

  await t.test('missing expected file', () => withTracked(({ trackedDir }) => {
    rmSync(join(trackedDir, 'platform-topology.md'));
    assert.throws(
      () => checkGeneratedArchitecture({ repoRoot, trackedDir }),
      /generated architecture entry platform-topology\.md is missing/u,
    );
  }));

  await t.test('directory in place of expected file', () => withTracked(({ trackedDir }) => {
    rmSync(join(trackedDir, 'platform-topology.md'));
    mkdirSync(join(trackedDir, 'platform-topology.md'));
    assert.throws(
      () => checkGeneratedArchitecture({ repoRoot, trackedDir }),
      /generated architecture entry platform-topology\.md must be a regular file/u,
    );
  }));

  await t.test('symlink in place of expected file', () => withTracked(({ parent, trackedDir }) => {
    const path = join(trackedDir, 'platform-topology.md');
    const target = join(parent, 'topology-target.md');
    writeFileSync(target, readFileSync(path));
    rmSync(path);
    symlinkSync(target, path);
    assert.throws(
      () => checkGeneratedArchitecture({ repoRoot, trackedDir }),
      /generated architecture entry platform-topology\.md must not be a symlink/u,
    );
  }));

  await t.test('symlinked generated directory', () => withTracked(({ parent, trackedDir }) => {
    const linked = join(parent, 'generated-link');
    symlinkSync(trackedDir, linked);
    assert.throws(
      () => checkGeneratedArchitecture({ repoRoot, trackedDir: linked }),
      /generated architecture directory must be a real directory/u,
    );
  }));

  await t.test('unexpected non-file entry', () => withTracked(({ trackedDir }) => {
    mkdirSync(join(trackedDir, 'unexpected'));
    assert.throws(
      () => checkGeneratedArchitecture({ repoRoot, trackedDir }),
      /unexpected generated architecture entry unexpected must be a regular file/u,
    );
  }));
});

test('live documentation converges on generated truth while dated records remain labeled snapshots', async () => {
  const { architectureDocumentationViolations } = await implementation;
  assert.deepEqual(architectureDocumentationViolations(repoRoot), []);
  const marketplace = readFileSync(
    join(repoRoot, 'docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md'),
    'utf8',
  );
  assert.match(marketplace, /Historical snapshot \(2026-07-30\)/u);
  assert.match(marketplace, /architecture\/generated\/platform-topology\.md/u);
});
