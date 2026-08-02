import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadCatalogPackages,
  loadPlatformCatalog,
  validatePlatformCatalog,
} from './platform-catalog.mjs';
import {
  catalogSchema,
  fixtureCatalog,
  fixtureRepo,
} from './platform-catalog-test-fixture.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

test('rejects structurally equal unique items with different object key order', () => {
  const catalog = fixtureCatalog();
  catalog.packages[0].authority.documents = [
    { path: 'docs/fixture-authority.md', status: 'current' },
    { status: 'current', path: 'docs/fixture-authority.md' },
  ];
  const root = fixtureRepo({ catalog });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /schema validation failed at catalog\.packages\[0\]\.authority\.documents: items must be unique/u,
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
      name: 'prototype-inherited owner group',
      mutate(catalog) { catalog.packages[0].ownerGroup = 'toString'; },
      pattern: /unknown owner group toString/u,
    },
    {
      name: 'gate',
      mutate(catalog) { catalog.packages[0].requiredGateIds = ['missing-gate']; },
      pattern: /unknown gate missing-gate/u,
    },
    {
      name: 'prototype-inherited gate',
      mutate(catalog) { catalog.packages[0].requiredGateIds = ['toString']; },
      pattern: /unknown gate toString/u,
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
