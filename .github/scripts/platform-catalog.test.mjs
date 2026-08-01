import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadCatalogPackages,
  loadPlatformCatalog,
  validatePlatformCatalog,
} from './platform-catalog.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const catalogSchema = JSON.parse(readFileSync(join(repoRoot, 'architecture/platform-packages.schema.json'), 'utf8'));

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packageEntry(name, path, overrides = {}) {
  return {
    name,
    path,
    domain: 'fixture',
    role: 'fixture package',
    tier: 1,
    classification: 'platform',
    stability: 'candidate',
    authority: {
      documents: [{ path: 'docs/fixture-authority.md', status: 'current' }],
      decisionRecord: null,
    },
    releaseGroup: 'platform-v1',
    publishPolicy: 'canary-only',
    ownerGroup: 'architecture-control',
    requiredGateIds: ['fixture-gate'],
    boundaryPolicy: {
      kind: 'source-boundary',
      path: '.github/scripts/fixture-boundary.mjs',
    },
    publicSurface: {
      schemas: [],
      profiles: [],
      fixtures: [],
      conformance: [],
    },
    supersedes: [],
    replacedBy: [],
    ...overrides,
  };
}

function fixtureCatalog() {
  const corePackages = [
    packageEntry('@jinn-network/fixture-protocol', 'packages/fixture/protocol'),
    packageEntry('@jinn-network/fixture-application', 'packages/fixture/application', {
      tier: 3,
      role: 'fixture application',
    }),
    ...Array.from({ length: 48 }, (_, index) => packageEntry(
      `@jinn-network/fixture-core-${String(index + 1).padStart(2, '0')}`,
      `packages/fixture/core-${String(index + 1).padStart(2, '0')}`,
    )),
  ];
  const experimentNames = [
    '@jinn-network/record-discovery-facts-environments',
    '@jinn-network/environment-record',
    '@jinn-network/environment-verification',
    '@jinn-network/task-admission',
    '@jinn-network/task-curation',
    '@jinn-network/task-derivation',
    '@jinn-network/task-posting',
  ];
  const experimentalPackages = experimentNames.map((name, index) => packageEntry(
    name,
    `packages/fixture/experiment-${index + 1}`,
    {
      tier: index === 1 ? 2 : 3,
      stability: 'experimental',
      releaseGroup: 'experimental-environment-supply',
      publishPolicy: 'disabled',
    },
  ));
  const legacyPackages = [
    ['@jinn-network/core', 'packages/core', null, 'legacy'],
    ['@jinn-network/jinn-layer', 'packages/layer', null, 'legacy'],
    ['@jinn-network/plugin', 'packages/plugin', null, 'legacy'],
    ['@jinn-network/sdk', 'packages/sdk', null, 'legacy'],
    ['@jinn-network/client', 'client', 4, 'product'],
  ].map(([name, path, tier, classification]) => packageEntry(name, path, {
    tier,
    ...(tier === null ? { tierReason: 'Fixture legacy package is outside the tier model.' } : {}),
    classification,
    stability: 'candidate',
    releaseGroup: 'legacy-product-lines',
    publishPolicy: 'independent',
  }));
  const otherPackages = [
    ['@jinn-network/autopilot', 'packages/autopilot', 4, 'product', 'private'],
    ['@jinn-network/indexer', 'packages/indexer', null, 'transitional', 'never'],
    ['@jinn-network/indexer-enrichment', 'packages/indexer-enrichment', null, 'product-support', 'never'],
    ['@jinn-network/explorer-spa', 'packages/indexer/explorer', 4, 'product', 'private'],
    ['@jinn-network/broadcast-bot', 'apps/broadcast-bot', null, 'repository-tooling', 'never'],
    ['@jinn-network/operator-spa', 'client/src/dashboard/spa', 4, 'product', 'private'],
    ['@jinn-network/plugin-runtime', 'plugin/runtime', null, 'product-support', 'never'],
  ].map(([name, path, tier, classification, publishPolicy]) => packageEntry(name, path, {
    tier,
    ...(tier === null ? { tierReason: 'Fixture package is outside the tier model.' } : {}),
    classification,
    stability: 'candidate',
    releaseGroup: 'transitional-or-private',
    publishPolicy,
  }));
  return {
    catalogVersion: 1,
    manifestRoots: [
      { path: 'packages', mode: 'recursive', excludedDirectories: ['node_modules'] },
      { path: 'apps/broadcast-bot', mode: 'package' },
      { path: 'client', mode: 'package' },
      { path: 'client/src/dashboard/spa', mode: 'package' },
      { path: 'plugin/runtime', mode: 'package' },
    ],
    ownerGroups: {
      'architecture-control': ['@oaksprout', '@ritsukai'],
    },
    gateDefinitions: {
      'fixture-gate': { kind: 'workflow', path: '.github/workflows/fixture.yml' },
    },
    releaseGroups: {
      'platform-v1': {
        expectedPackageCount: 50,
        publishPolicies: ['canary-only'],
        stackPublished: true,
        canary: true,
        stable: false,
      },
      'experimental-environment-supply': {
        expectedPackageCount: 7,
        publishPolicies: ['disabled'],
        stackPublished: false,
        canary: false,
        stable: false,
      },
      'legacy-product-lines': {
        expectedPackageCount: 5,
        publishPolicies: ['independent'],
        stackPublished: false,
        canary: false,
        stable: false,
      },
      'transitional-or-private': {
        expectedPackageCount: 7,
        publishPolicies: ['private', 'never'],
        stackPublished: false,
        canary: false,
        stable: false,
      },
    },
    tierRules: {
      allowedDependencies: {
        1: [1],
        2: [1, 2],
        3: [1, 2, 3],
        4: [1, 2, 3, 4, null],
        null: [1, 2, 3, 4, null],
      },
    },
    packages: [...corePackages, ...experimentalPackages, ...legacyPackages, ...otherPackages],
  };
}

function fixtureRepo({ catalog = fixtureCatalog(), manifests = {}, schema = catalogSchema } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jinn-platform-catalog-'));
  writeJson(join(root, 'architecture/platform-packages.v1.json'), catalog);
  writeJson(join(root, 'architecture/platform-packages.schema.json'), schema);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/fixture-authority.md'), '# Fixture authority\n', 'utf8');
  mkdirSync(join(root, '.github/scripts'), { recursive: true });
  writeFileSync(join(root, '.github/scripts/fixture-boundary.mjs'), 'export {};\n', 'utf8');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/fixture.yml'), 'name: fixture\n', 'utf8');
  const defaults = Object.fromEntries(catalog.packages.map((pkg) => [pkg.path, {
    name: pkg.name,
    version: '0.1.0',
    ...(pkg.name === '@jinn-network/fixture-application'
      ? { dependencies: { '@jinn-network/fixture-protocol': '0.1.0' } }
      : {}),
  }]));
  for (const [directory, manifest] of Object.entries({ ...defaults, ...manifests })) {
    writeJson(join(root, directory, 'package.json'), manifest);
  }
  return root;
}

test('loads a controlled catalog and hydrates package metadata only from manifests', () => {
  const root = fixtureRepo();
  try {
    const catalog = loadPlatformCatalog(root);
    assert.equal(catalog.packages.length, 69);
    const packages = loadCatalogPackages(root, { releaseGroup: 'platform-v1' });
    assert.equal(packages.length, 50);
    const application = packages.find((pkg) => pkg.name === '@jinn-network/fixture-application');
    assert.equal(application.manifest.version, '0.1.0');
    assert.equal('version' in application.catalog, false, 'npm metadata stays out of the catalog');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a scoped manifest that the catalog omits', () => {
  const root = fixtureRepo({
    manifests: {
      'packages/fixture/uncataloged': { name: '@jinn-network/uncataloged', version: '0.1.0' },
    },
  });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /catalog completeness.*packages\/fixture\/uncataloged/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects catalog path/name drift from the package manifest', () => {
  const root = fixtureRepo({
    manifests: {
      'packages/fixture/protocol': { name: '@jinn-network/renamed', version: '0.1.0' },
    },
  });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /packages\/fixture\/protocol: catalog names @jinn-network\/fixture-protocol, manifest names @jinn-network\/renamed/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applies the closed schema contract to top-level, package, and nested objects', async (t) => {
  const cases = [
    {
      name: 'unknown top-level field',
      mutate(catalog) { catalog.unexpected = true; },
      pattern: /schema validation failed at catalog: unknown field unexpected/u,
    },
    {
      name: 'unknown package field',
      mutate(catalog) { catalog.packages[0].unexpected = true; },
      pattern: /schema validation failed at catalog\.packages\[0\]: unknown field unexpected/u,
    },
    {
      name: 'unknown nested field',
      mutate(catalog) { catalog.packages[0].authority.unexpected = true; },
      pattern: /schema validation failed at catalog\.packages\[0\]\.authority: unknown field unexpected/u,
    },
    {
      name: 'multiple boundary policies',
      mutate(catalog) {
        catalog.packages[0].boundaryPolicy = [
          catalog.packages[0].boundaryPolicy,
          catalog.packages[0].boundaryPolicy,
        ];
      },
      pattern: /schema validation failed at catalog\.packages\[0\]\.boundaryPolicy: expected object/u,
    },
    {
      name: 'unknown boundary policy field',
      mutate(catalog) { catalog.packages[0].boundaryPolicy.secondPolicy = '.github/workflows/fixture.yml'; },
      pattern: /schema validation failed at catalog\.packages\[0\]\.boundaryPolicy: unknown field secondPolicy/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const catalog = fixtureCatalog();
      entry.mutate(catalog);
      const root = fixtureRepo({ catalog });
      try {
        assert.throws(() => loadPlatformCatalog(root), entry.pattern);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('fails closed when the catalog schema uses an unsupported keyword', () => {
  const schema = structuredClone(catalogSchema);
  schema.properties.packages.unenforcedKeyword = true;
  const root = fixtureRepo({ schema });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /unsupported catalog schema keyword unenforcedKeyword at schema\.properties\.packages/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing ownership, gate, authority, boundary, and transition references', async (t) => {
  const cases = [
    {
      name: 'owner group',
      mutate(catalog) { catalog.packages[0].ownerGroup = 'missing-owner'; },
      pattern: /unknown owner group missing-owner/u,
    },
    {
      name: 'gate',
      mutate(catalog) { catalog.packages[0].requiredGateIds = ['missing-gate']; },
      pattern: /unknown gate missing-gate/u,
    },
    {
      name: 'authority',
      mutate(catalog) {
        catalog.packages[0].authority.documents = [{ path: 'docs/missing.md', status: 'current' }];
      },
      pattern: /authority path does not exist: docs\/missing\.md/u,
    },
    {
      name: 'boundary policy',
      mutate(catalog) { catalog.packages[0].boundaryPolicy.path = '.github/scripts/missing.mjs'; },
      pattern: /boundary policy path does not exist/u,
    },
    {
      name: 'transition metadata',
      mutate(catalog) { catalog.packages[0].stability = 'deprecated'; },
      pattern: /schema validation failed.*missing required field transition/u,
    },
    {
      name: 'tier/classification agreement',
      mutate(catalog) { catalog.packages[0].classification = 'product'; },
      pattern: /product packages must be tier 4/u,
    },
    {
      name: 'release group/classification agreement',
      mutate(catalog) {
        catalog.packages[2].classification = 'product';
        catalog.packages[2].tier = 4;
      },
      pattern: /platform-v1 package @jinn-network\/fixture-core-01 cannot have classification product/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const catalog = fixtureCatalog();
      entry.mutate(catalog);
      const root = fixtureRepo({ catalog });
      try {
        assert.throws(() => loadPlatformCatalog(root), entry.pattern);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('rejects reference paths that name directories instead of files', async (t) => {
  const cases = [
    {
      name: 'gate directory',
      mutate(catalog) { catalog.gateDefinitions['fixture-gate'].path = 'docs'; },
      pattern: /gate fixture-gate path does not exist: docs/u,
    },
    {
      name: 'authority directory',
      mutate(catalog) { catalog.packages[0].authority.documents[0].path = 'docs'; },
      pattern: /authority path does not exist: docs/u,
    },
    {
      name: 'decision record directory',
      mutate(catalog) {
        catalog.packages[0].authority.decisionRecord = { path: 'docs', status: 'ratified' };
      },
      pattern: /decision record path does not exist: docs/u,
    },
    {
      name: 'boundary directory',
      mutate(catalog) { catalog.packages[0].boundaryPolicy.path = '.github\/scripts'; },
      pattern: /boundary policy path does not exist: \.github\/scripts/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const catalog = fixtureCatalog();
      entry.mutate(catalog);
      const root = fixtureRepo({ catalog });
      try {
        assert.throws(() => loadPlatformCatalog(root), entry.pattern);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('rejects renamed or weakened initial release groups', async (t) => {
  const cases = [
    {
      name: 'renamed platform group',
      mutate(catalog) {
        catalog.releaseGroups.renamed = catalog.releaseGroups['platform-v1'];
        delete catalog.releaseGroups['platform-v1'];
        for (const pkg of catalog.packages.filter((entry) => entry.releaseGroup === 'platform-v1')) {
          pkg.releaseGroup = 'renamed';
        }
      },
      pattern: /required release groups must be exactly/u,
    },
    {
      name: 'platform stack publication disabled',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].stackPublished = false; },
      pattern: /platform-v1\.stackPublished must be true/u,
    },
    {
      name: 'platform canary disabled',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].canary = false; },
      pattern: /platform-v1\.canary must be true/u,
    },
    {
      name: 'platform stable enabled',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].stable = true; },
      pattern: /platform-v1\.stable must be false/u,
    },
    {
      name: 'experimental stack publication enabled',
      mutate(catalog) { catalog.releaseGroups['experimental-environment-supply'].stackPublished = true; },
      pattern: /experimental-environment-supply\.stackPublished must be false/u,
    },
    {
      name: 'experimental canary enabled',
      mutate(catalog) { catalog.releaseGroups['experimental-environment-supply'].canary = true; },
      pattern: /experimental-environment-supply\.canary must be false/u,
    },
    {
      name: 'experimental stable enabled',
      mutate(catalog) { catalog.releaseGroups['experimental-environment-supply'].stable = true; },
      pattern: /experimental-environment-supply\.stable must be false/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const catalog = fixtureCatalog();
      entry.mutate(catalog);
      const root = fixtureRepo({ catalog });
      try {
        assert.throws(() => loadPlatformCatalog(root), entry.pattern);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('rejects stack-release runtime dependencies outside the selected release group', () => {
  const catalog = fixtureCatalog();
  const root = fixtureRepo({
    catalog,
    manifests: {
      'packages/fixture/application': {
        name: '@jinn-network/fixture-application',
        version: '0.1.0',
        dependencies: { '@jinn-network/environment-record': '0.1.0' },
      },
    },
  });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /platform-v1.*cannot depend on @jinn-network\/environment-record in experimental-environment-supply/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects runtime dependencies that violate the declared tier direction', () => {
  const catalog = fixtureCatalog();
  catalog.packages[0].tier = 1;
  catalog.packages[1].tier = 3;
  const root = fixtureRepo({
    catalog,
    manifests: {
      'packages/fixture/protocol': {
        name: '@jinn-network/fixture-protocol',
        version: '0.1.0',
        dependencies: { '@jinn-network/fixture-application': '0.1.0' },
      },
    },
  });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /tier 1 package @jinn-network\/fixture-protocol cannot depend on tier 3 package @jinn-network\/fixture-application/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enforces fixed dependency directions independently of publication flags', async (t) => {
  const cases = [
    {
      name: 'experimental to platform is allowed',
      sourcePath: 'packages/fixture/experiment-4',
      sourceName: '@jinn-network/task-admission',
      dependency: '@jinn-network/fixture-protocol',
      rejects: false,
    },
    {
      name: 'product to platform is allowed',
      sourcePath: 'packages/indexer/explorer',
      sourceName: '@jinn-network/explorer-spa',
      dependency: '@jinn-network/fixture-protocol',
      rejects: false,
    },
    {
      name: 'platform to legacy is forbidden',
      sourcePath: 'packages/fixture/application',
      sourceName: '@jinn-network/fixture-application',
      dependency: '@jinn-network/core',
      rejects: true,
      pattern: /platform-v1 package @jinn-network\/fixture-application cannot depend on @jinn-network\/core in legacy-product-lines/u,
    },
    {
      name: 'experimental to private product is forbidden',
      sourcePath: 'packages/fixture/experiment-4',
      sourceName: '@jinn-network/task-admission',
      dependency: '@jinn-network/explorer-spa',
      rejects: true,
      pattern: /experimental-environment-supply package @jinn-network\/task-admission cannot depend on @jinn-network\/explorer-spa in transitional-or-private/u,
    },
    {
      name: 'missing internal product dependency is forbidden',
      sourcePath: 'packages/indexer/explorer',
      sourceName: '@jinn-network/explorer-spa',
      dependency: '@jinn-network/missing',
      rejects: true,
      pattern: /@jinn-network\/explorer-spa depends on missing catalog package @jinn-network\/missing/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const catalog = fixtureCatalog();
      const root = fixtureRepo({
        catalog,
        manifests: {
          [entry.sourcePath]: {
            name: entry.sourceName,
            version: '0.1.0',
            dependencies: { [entry.dependency]: '0.1.0' },
          },
        },
      });
      try {
        if (entry.rejects) assert.throws(() => loadPlatformCatalog(root), entry.pattern);
        else assert.doesNotThrow(() => loadPlatformCatalog(root));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('validates every internal dependency specifier against the target manifest', async (t) => {
  const cases = [
    { name: 'exact version', specifier: '0.1.0', rejects: false },
    { name: 'mismatched version', specifier: '0.2.0', rejects: true },
    { name: 'ambiguous range', specifier: '^0.1.0', rejects: true },
    { name: 'unsupported workspace specifier', specifier: 'workspace:*', rejects: true },
    { name: 'unsupported link specifier', specifier: 'link:../protocol', rejects: true },
    { name: 'unsupported file specifier', specifier: 'file:../protocol', rejects: true },
    { name: 'wrong portal target', specifier: 'portal:../not-the-protocol', rejects: true },
    { name: 'verified portal target', specifier: 'portal:../protocol', rejects: false },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const catalog = fixtureCatalog();
      const root = fixtureRepo({
        catalog,
        manifests: {
          'packages/fixture/application': {
            name: '@jinn-network/fixture-application',
            version: '0.1.0',
            dependencies: { '@jinn-network/fixture-protocol': entry.specifier },
          },
        },
      });
      try {
        if (entry.rejects) {
          assert.throws(
            () => loadPlatformCatalog(root),
            /@jinn-network\/fixture-application depends on incompatible @jinn-network\/fixture-protocol specifier/u,
          );
        } else {
          assert.doesNotThrow(() => loadPlatformCatalog(root));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('ignores devDependencies when validating release closure and tier direction', () => {
  const catalog = fixtureCatalog();
  const root = fixtureRepo({
    catalog,
    manifests: {
      'packages/fixture/protocol': {
        name: '@jinn-network/fixture-protocol',
        version: '0.1.0',
        devDependencies: { '@jinn-network/environment-record': '0.1.0' },
      },
    },
  });
  try {
    assert.doesNotThrow(() => loadPlatformCatalog(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('records authority status per governing document', () => {
  const catalog = JSON.parse(readFileSync(join(repoRoot, 'architecture/platform-packages.v1.json'), 'utf8'));
  const benchmarking = catalog.packages.filter((pkg) => pkg.domain === 'benchmarking');
  assert.equal(benchmarking.length, 6);
  for (const pkg of benchmarking) {
    assert.deepEqual(pkg.authority.documents, [
      {
        path: 'docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md',
        status: 'ratified',
      },
      {
        path: 'docs/superpowers/specs/2026-07-28-benchmarking-application-design.md',
        status: 'proposed',
      },
    ]);
    assert.deepEqual(pkg.authority.decisionRecord, {
      path: 'log/decisions/2026-07-30-platform-boundary-and-topology.md',
      status: 'ratified',
    });
    assert.equal(pkg.stability, 'candidate');
    assert.equal(pkg.publishPolicy, 'canary-only');
    assert.equal(pkg.releaseGroup, 'platform-v1');
  }
  assert.equal(catalog.releaseGroups['platform-v1'].stable, false);
});

test('the canonical repository catalog validates the exact initial topology', () => {
  const catalog = loadPlatformCatalog(repoRoot);
  assert.equal(catalog.packages.length, 69);
  assert.equal(catalog.packages.filter((pkg) => pkg.releaseGroup === 'platform-v1').length, 50);
  assert.equal(catalog.packages.filter((pkg) => pkg.releaseGroup === 'experimental-environment-supply').length, 7);
  assert.equal(catalog.packages.filter((pkg) => pkg.path.startsWith('packages/')).length, 65);
  assert.equal(catalog.packages.filter((pkg) => !pkg.path.startsWith('packages/')).length, 4);
  assert.deepEqual(catalog.ownerGroups['architecture-control'], ['@oaksprout', '@ritsukai']);
  assert.deepEqual(
    catalog.packages
      .filter((pkg) => pkg.releaseGroup === 'experimental-environment-supply')
      .map((pkg) => pkg.name)
      .sort(),
    [
      '@jinn-network/environment-record',
      '@jinn-network/environment-verification',
      '@jinn-network/record-discovery-facts-environments',
      '@jinn-network/task-admission',
      '@jinn-network/task-curation',
      '@jinn-network/task-derivation',
      '@jinn-network/task-posting',
    ],
  );
  assert.deepEqual(
    catalog.packages
      .filter((pkg) => pkg.releaseGroup === 'legacy-product-lines')
      .map((pkg) => pkg.name)
      .sort(),
    [
      '@jinn-network/client',
      '@jinn-network/core',
      '@jinn-network/jinn-layer',
      '@jinn-network/plugin',
      '@jinn-network/sdk',
    ],
  );
  assert.ok(
    catalog.packages
      .filter((pkg) => pkg.releaseGroup === 'legacy-product-lines')
      .every((pkg) => pkg.publishPolicy === 'independent'),
  );
  const schema = JSON.parse(readFileSync(join(repoRoot, 'architecture/platform-packages.schema.json'), 'utf8'));
  assert.equal(schema.$id, 'https://jinn.network/architecture/platform-packages.schema.json');
  assert.deepEqual(schema.required, [
    'catalogVersion',
    'manifestRoots',
    'ownerGroups',
    'gateDefinitions',
    'releaseGroups',
    'tierRules',
    'packages',
  ]);
  assert.doesNotThrow(() => validatePlatformCatalog(catalog, { repoRoot }));
});
