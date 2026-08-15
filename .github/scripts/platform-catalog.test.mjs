import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadCatalogPackages,
  loadPublishableCatalogPackages,
  loadPlatformCatalog,
  validatePlatformCatalog,
} from './platform-catalog.mjs';
import {
  catalogSchema,
  disableReleaseGroup,
  fixtureCatalog,
  fixtureRepo,
  packageEntry,
} from './platform-catalog-test-fixture.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function manifestExclusion(path, overrides = {}) {
  return {
    path,
    reason: 'Upstream vendored package is governed outside the platform architecture.',
    ownerGroup: 'architecture-control',
    classification: 'vendored',
    reviewCondition: 'Review when the upstream snapshot is replaced or removed.',
    ...overrides,
  };
}

test('loads a controlled catalog and hydrates package metadata only from manifests', () => {
  const root = fixtureRepo();
  try {
    const catalog = loadPlatformCatalog(root);
    const packages = loadCatalogPackages(root, { releaseGroup: 'platform-v1' });
    assert.equal(packages.length, catalog.releaseGroups['platform-v1'].expectedPackageCount);
    const application = packages.find((pkg) => pkg.name === '@jinn-network/fixture-application');
    assert.equal(application.manifest.version, '0.1.0');
    assert.equal('version' in application.catalog, false, 'npm metadata stays out of the catalog');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release groups declare a required unique gate set in the closed schema', () => {
  const releaseGroup = catalogSchema.properties.releaseGroups.additionalProperties;
  for (const field of [
    'requiredGateIds',
    'allowedClassifications',
    'allowedDependencyReleaseGroups',
  ]) assert.ok(releaseGroup.required.includes(field));
  assert.deepEqual(releaseGroup.properties.requiredGateIds, {
    $ref: '#/$defs/nonEmptyStringList',
  });
});

test('accepts an atomic platform membership change using only catalog data', () => {
  const catalog = fixtureCatalog();
  catalog.packages.push(packageEntry(
    '@jinn-network/fixture-new-platform-package',
    'packages/fixture/new-platform-package',
  ));
  catalog.releaseGroups['platform-v1'].expectedPackageCount += 1;
  const root = fixtureRepo({ catalog });
  try {
    assert.doesNotThrow(() => loadPlatformCatalog(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release publication flags cannot remain enabled for a mixed-policy member set', () => {
  const catalog = fixtureCatalog();
  catalog.releaseGroups['platform-v1'].publishPolicies.push('disabled');
  catalog.packages.find(({ releaseGroup }) => releaseGroup === 'platform-v1').publishPolicy = 'disabled';
  const root = fixtureRepo({ catalog });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /releaseGroups\.platform-v1 publication flags must agree with every member publish policy/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a release group can be atomically disabled in catalog data', () => {
  const catalog = disableReleaseGroup(fixtureCatalog());
  const root = fixtureRepo({ catalog });
  try {
    assert.doesNotThrow(() => loadPlatformCatalog(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stable publication eligibility requires every group member to permit stable publication', () => {
  const catalog = fixtureCatalog();
  const definition = catalog.releaseGroups['platform-v1'];
  definition.publishPolicies = ['canary-and-stable'];
  definition.stable = true;
  for (const pkg of catalog.packages.filter(({ releaseGroup }) => releaseGroup === 'platform-v1')) {
    pkg.publishPolicy = 'canary-and-stable';
  }
  const root = fixtureRepo({ catalog });
  try {
    assert.equal(
      loadPublishableCatalogPackages(root, { releaseGroup: 'platform-v1', lane: 'stable' }).length,
      definition.expectedPackageCount,
    );
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

test('rejects an uncataloged first-party manifest beneath an undeclared top-level root', () => {
  const root = fixtureRepo({
    manifests: {
      'services/new-service': { name: '@jinn-network/new-service', version: '0.1.0' },
    },
  });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /catalog completeness.*services\/new-service/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts a repository-wide first-party manifest only through an explicit governed exclusion', () => {
  const catalog = fixtureCatalog();
  catalog.manifestExclusions = [manifestExclusion('vendor/upstream')];
  const root = fixtureRepo({
    catalog,
    manifests: {
      'vendor/upstream': { name: '@jinn-network/upstream-vendored', version: '1.0.0' },
    },
  });
  try {
    assert.doesNotThrow(() => loadPlatformCatalog(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects manifest exclusions without a reason or owner', async (t) => {
  for (const field of ['reason', 'ownerGroup']) {
    await t.test(field, () => {
      const catalog = fixtureCatalog();
      const exclusion = manifestExclusion('vendor/upstream');
      delete exclusion[field];
      catalog.manifestExclusions = [exclusion];
      const root = fixtureRepo({
        catalog,
        manifests: {
          'vendor/upstream': { name: '@jinn-network/upstream-vendored', version: '1.0.0' },
        },
      });
      try {
        assert.throws(
          () => loadPlatformCatalog(root),
          new RegExp(`manifestExclusions\\[0\\].*missing required field ${field}`, 'u'),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('rejects a first-party manifest that is both cataloged and excluded', () => {
  const catalog = fixtureCatalog();
  catalog.manifestExclusions = [manifestExclusion('packages/fixture/protocol')];
  const root = fixtureRepo({ catalog });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /packages\/fixture\/protocol.*both cataloged and excluded/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects duplicate first-party package names in different repository paths', () => {
  const root = fixtureRepo({
    manifests: {
      'tools/duplicate-protocol': {
        name: '@jinn-network/fixture-protocol',
        version: '0.1.0',
      },
    },
  });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /duplicate first-party package name @jinn-network\/fixture-protocol.*packages\/fixture\/protocol.*tools\/duplicate-protocol/u,
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

test('public surface roots must be normalized package-relative paths', async (t) => {
  for (const [name, value] of [
    ['traversal', '../schemas'],
    ['absolute', '/tmp/schemas'],
    ['backslash', 'schemas\\nested'],
  ]) {
    await t.test(name, () => {
      const catalog = fixtureCatalog();
      catalog.packages[0].publicSurface.schemas = [value];
      const root = fixtureRepo({ catalog });
      try {
        assert.throws(
          () => loadPlatformCatalog(root),
          /@jinn-network\/fixture-protocol\.publicSurface\.schemas\[0\].*normalized package-relative path/u,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
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

test('release-group gates are known and exactly equal the member-package gate union', async (t) => {
  const cases = [
    {
      name: 'package gate swapped to another valid gate',
      mutate(catalog) {
        catalog.gateDefinitions['environments-ci'] = catalog.gateDefinitions['fixture-ci'];
        catalog.packages[0].requiredGateIds = ['environments-ci'];
      },
      pattern: /releaseGroups\.platform-v1\.requiredGateIds must exactly equal member package gate union/u,
    },
    {
      name: 'group gate swapped to another valid gate',
      mutate(catalog) {
        catalog.gateDefinitions['environments-ci'] = catalog.gateDefinitions['fixture-ci'];
        catalog.releaseGroups['platform-v1'].requiredGateIds = ['environments-ci'];
      },
      pattern: /releaseGroups\.platform-v1\.requiredGateIds must exactly equal member package gate union/u,
    },
    {
      name: 'valid gate added only to group',
      mutate(catalog) {
        catalog.gateDefinitions['environments-ci'] = catalog.gateDefinitions['fixture-ci'];
        catalog.releaseGroups['platform-v1'].requiredGateIds.push('environments-ci');
      },
      pattern: /releaseGroups\.platform-v1\.requiredGateIds must exactly equal member package gate union/u,
    },
    {
      name: 'valid gate removed only from group',
      mutate(catalog) {
        catalog.gateDefinitions['environments-ci'] = catalog.gateDefinitions['fixture-ci'];
        catalog.packages[0].requiredGateIds.push('environments-ci');
        catalog.releaseGroups['platform-v1'].requiredGateIds.push('environments-ci');
        catalog.releaseGroups['platform-v1'].requiredGateIds = ['environments-ci'];
      },
      pattern: /releaseGroups\.platform-v1\.requiredGateIds must exactly equal member package gate union/u,
    },
    {
      name: 'prototype-inherited group gate',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].requiredGateIds = ['toString']; },
      pattern: /releaseGroups\.platform-v1: unknown gate toString/u,
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

test('a valid gate move is accepted only when group and member declarations change atomically', () => {
  const catalog = fixtureCatalog();
  catalog.gateDefinitions['environments-ci'] = catalog.gateDefinitions['fixture-ci'];
  catalog.packages[0].requiredGateIds.push('environments-ci');
  catalog.releaseGroups['platform-v1'].requiredGateIds.push('environments-ci');
  const root = fixtureRepo({ catalog });
  try {
    assert.doesNotThrow(() => loadPlatformCatalog(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects reference paths that name directories instead of files', async (t) => {
  const cases = [
    {
      name: 'gate directory',
      mutate(catalog) { catalog.gateDefinitions['fixture-ci'].path = 'docs'; },
      pattern: /gate fixture-ci path does not exist: docs/u,
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

test('release-group policy is catalog-authored and internally consistent', async (t) => {
  const cases = [
    {
      name: 'unknown dependency release group',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].allowedDependencyReleaseGroups = ['missing']; },
      pattern: /allows unknown dependency release group missing/u,
    },
    {
      name: 'group policy list exceeds member policy union',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].publishPolicies.push('disabled'); },
      pattern: /platform-v1\.publishPolicies must exactly equal member package policy union/u,
    },
    {
      name: 'stack publication flag disagrees with policy',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].stackPublished = false; },
      pattern: /platform-v1 publication flags must agree with every member publish policy/u,
    },
    {
      name: 'canary flag disagrees with policy',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].canary = false; },
      pattern: /platform-v1 publication flags must agree with every member publish policy/u,
    },
    {
      name: 'stable flag disagrees with policy',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].stable = true; },
      pattern: /platform-v1 publication flags must agree with every member publish policy/u,
    },
    {
      name: 'member classification outside group policy',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].allowedClassifications = ['platform-support']; },
      pattern: /platform-v1 package .* cannot have classification platform/u,
    },
    {
      name: 'declared count outside membership',
      mutate(catalog) { catalog.releaseGroups['platform-v1'].expectedPackageCount += 1; },
      pattern: /release group platform-v1 expects .* packages, found/u,
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

test('an atomic release-group rename is accepted without JavaScript membership edits', () => {
  const catalog = fixtureCatalog();
  catalog.releaseGroups['platform-candidate'] = catalog.releaseGroups['platform-v1'];
  delete catalog.releaseGroups['platform-v1'];
  for (const group of Object.values(catalog.releaseGroups)) {
    group.allowedDependencyReleaseGroups = group.allowedDependencyReleaseGroups.map((groupId) => (
      groupId === 'platform-v1' ? 'platform-candidate' : groupId
    ));
  }
  for (const pkg of catalog.packages.filter(({ releaseGroup }) => releaseGroup === 'platform-v1')) {
    pkg.releaseGroup = 'platform-candidate';
  }
  const root = fixtureRepo({ catalog });
  try {
    assert.doesNotThrow(() => loadPlatformCatalog(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
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
  assert.ok(benchmarking.length > 0);
  for (const pkg of benchmarking) {
    const governingDesign = pkg.name === '@jinn-network/benchmarking-publication'
      ? {
          path: 'docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md',
          status: 'draft',
        }
      : {
          path: 'docs/superpowers/specs/2026-07-28-benchmarking-application-design.md',
          status: 'proposed',
        };
    assert.deepEqual(pkg.authority.documents, [
      {
        path: 'docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md',
        status: 'ratified',
      },
      governingDesign,
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

test('the canonical repository catalog validates its topology without a second membership authority', () => {
  const catalog = loadPlatformCatalog(repoRoot);
  assert.deepEqual(catalog.ownerGroups['architecture-control'], ['@oaksprout', '@ritsukai']);
  for (const [releaseGroup, definition] of Object.entries(catalog.releaseGroups)) {
    const members = catalog.packages.filter((pkg) => pkg.releaseGroup === releaseGroup);
    assert.equal(members.length, definition.expectedPackageCount, releaseGroup);
    assert.ok(members.every((pkg) => definition.publishPolicies.includes(pkg.publishPolicy)));
    assert.ok(members.every((pkg) => definition.allowedClassifications.includes(pkg.classification)));
    assert.ok(definition.requiredGateIds.every((gateId) => gateId in catalog.gateDefinitions));
  }
  assert.ok(catalog.packages.some((pkg) => pkg.path.startsWith('packages/')));
  assert.ok(catalog.packages.some((pkg) => !pkg.path.startsWith('packages/')));
  assert.ok(
    catalog.packages
      .filter((pkg) => pkg.releaseGroup === 'experimental-environment-supply')
      .every((pkg) => pkg.publishPolicy === 'disabled'),
  );
  assert.ok(
    catalog.packages
      .filter((pkg) => pkg.releaseGroup === 'legacy-product-lines')
      .every((pkg) => pkg.publishPolicy === 'independent'),
  );
  const schema = JSON.parse(readFileSync(join(repoRoot, 'architecture/platform-packages.schema.json'), 'utf8'));
  assert.equal(schema.$id, 'https://spec.jinn.network/architecture/platform-packages.schema.json');
  assert.deepEqual(schema.required, [
    'catalogVersion',
    'manifestRoots',
    'manifestExclusions',
    'ownerGroups',
    'gateDefinitions',
    'releaseGroups',
    'tierRules',
    'packages',
  ]);
  assert.doesNotThrow(() => validatePlatformCatalog(catalog, { repoRoot }));
});

test('task-supply and environment packages remain disabled and provisionally classified', () => {
  const catalog = loadPlatformCatalog(repoRoot);
  const promoted = catalog.packages
    .filter(({ releaseGroup }) => releaseGroup === 'experimental-task-supply')
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(promoted, [
    '@jinn-network/chain-scenarios',
    '@jinn-network/task-admission',
    '@jinn-network/task-curation',
    '@jinn-network/task-derivation',
    '@jinn-network/task-posting',
  ]);
  for (const pkg of catalog.packages.filter(({ name }) => promoted.includes(name))) {
    assert.equal(pkg.publishPolicy, 'disabled');
  }
  assert.equal(catalog.packages.find(({ name }) => name === '@jinn-network/task-admission')?.stability, 'candidate');
  const environmentRecord = catalog.packages.find(({ name }) => name === '@jinn-network/environment-record');
  assert.equal(environmentRecord?.releaseGroup, 'experimental-environment-supply');
  assert.equal(environmentRecord?.publishPolicy, 'disabled');
  assert.deepEqual(
    catalog.releaseGroups['experimental-task-supply'].allowedDependencyReleaseGroups,
    ['experimental-environment-supply', 'experimental-task-supply', 'platform-v1'],
  );
});
