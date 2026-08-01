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
      documents: ['docs/fixture-authority.md'],
      status: 'current',
      decisionRecord: null,
    },
    releaseGroup: 'fixture-release',
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
  return {
    catalogVersion: 1,
    manifestRoots: [
      { path: 'packages', mode: 'recursive', excludedDirectories: ['node_modules'] },
    ],
    ownerGroups: {
      'architecture-control': ['@oaksprout', '@ritsukai'],
    },
    gateDefinitions: {
      'fixture-gate': { kind: 'workflow', path: '.github/workflows/fixture.yml' },
    },
    releaseGroups: {
      'fixture-release': {
        expectedPackageCount: 2,
        publishPolicies: ['canary-only'],
        stackPublished: true,
        canary: true,
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
    packages: [
      packageEntry('@jinn-network/fixture-protocol', 'packages/fixture/protocol'),
      packageEntry('@jinn-network/fixture-application', 'packages/fixture/application', {
        tier: 3,
        role: 'fixture application',
      }),
    ],
  };
}

function fixtureRepo({ catalog = fixtureCatalog(), manifests = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jinn-platform-catalog-'));
  writeJson(join(root, 'architecture/platform-packages.v1.json'), catalog);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/fixture-authority.md'), '# Fixture authority\n', 'utf8');
  mkdirSync(join(root, '.github/scripts'), { recursive: true });
  writeFileSync(join(root, '.github/scripts/fixture-boundary.mjs'), 'export {};\n', 'utf8');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/fixture.yml'), 'name: fixture\n', 'utf8');
  const defaults = {
    'packages/fixture/protocol': {
      name: '@jinn-network/fixture-protocol',
      version: '0.1.0',
      publishConfig: { access: 'public' },
    },
    'packages/fixture/application': {
      name: '@jinn-network/fixture-application',
      version: '0.1.0',
      publishConfig: { access: 'public' },
      dependencies: { '@jinn-network/fixture-protocol': '0.1.0' },
    },
  };
  for (const [directory, manifest] of Object.entries({ ...defaults, ...manifests })) {
    writeJson(join(root, directory, 'package.json'), manifest);
  }
  return root;
}

test('loads a controlled catalog and hydrates package metadata only from manifests', () => {
  const root = fixtureRepo();
  try {
    const catalog = loadPlatformCatalog(root);
    assert.equal(catalog.packages.length, 2);
    const packages = loadCatalogPackages(root, { releaseGroup: 'fixture-release' });
    assert.deepEqual(packages.map((pkg) => pkg.name), [
      '@jinn-network/fixture-application',
      '@jinn-network/fixture-protocol',
    ]);
    assert.equal(packages[0].manifest.version, '0.1.0');
    assert.equal('version' in packages[0].catalog, false, 'npm metadata stays out of the catalog');
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
      mutate(catalog) { catalog.packages[0].authority.documents = ['docs/missing.md']; },
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
      pattern: /deprecated packages require transition metadata/u,
    },
    {
      name: 'tier/classification agreement',
      mutate(catalog) { catalog.packages[0].classification = 'product'; },
      pattern: /product packages must be tier 4/u,
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
  catalog.releaseGroups['disabled-experiment'] = {
    expectedPackageCount: 1,
    publishPolicies: ['disabled'],
    stackPublished: false,
    canary: false,
    stable: false,
  };
  catalog.packages.push(packageEntry('@jinn-network/experiment', 'packages/fixture/experiment', {
    tier: 2,
    stability: 'experimental',
    releaseGroup: 'disabled-experiment',
    publishPolicy: 'disabled',
  }));
  catalog.releaseGroups['fixture-release'].expectedPackageCount = 2;
  const root = fixtureRepo({
    catalog,
    manifests: {
      'packages/fixture/application': {
        name: '@jinn-network/fixture-application',
        version: '0.1.0',
        dependencies: { '@jinn-network/experiment': '0.1.0' },
      },
      'packages/fixture/experiment': {
        name: '@jinn-network/experiment',
        version: '0.1.0',
      },
    },
  });
  try {
    assert.throws(
      () => loadPlatformCatalog(root),
      /fixture-release.*depends on @jinn-network\/experiment in disabled-experiment/u,
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

test('ignores devDependencies when validating release closure and tier direction', () => {
  const catalog = fixtureCatalog();
  catalog.releaseGroups['disabled-experiment'] = {
    expectedPackageCount: 1,
    publishPolicies: ['disabled'],
    stackPublished: false,
    canary: false,
    stable: false,
  };
  catalog.packages.push(packageEntry('@jinn-network/experiment', 'packages/fixture/experiment', {
    tier: 3,
    stability: 'experimental',
    releaseGroup: 'disabled-experiment',
    publishPolicy: 'disabled',
  }));
  const root = fixtureRepo({
    catalog,
    manifests: {
      'packages/fixture/protocol': {
        name: '@jinn-network/fixture-protocol',
        version: '0.1.0',
        devDependencies: { '@jinn-network/experiment': '0.1.0' },
      },
      'packages/fixture/experiment': {
        name: '@jinn-network/experiment',
        version: '0.1.0',
      },
    },
  });
  try {
    assert.doesNotThrow(() => loadPlatformCatalog(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
