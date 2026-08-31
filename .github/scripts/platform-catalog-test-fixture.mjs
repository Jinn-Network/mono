import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

export const catalogSchema = JSON.parse(
  readFileSync(join(repoRoot, 'architecture/platform-packages.schema.json'), 'utf8'),
);

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function packageEntry(name, path, overrides = {}) {
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
    requiredGateIds: ['fixture-ci'],
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

export function fixtureCatalog() {
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
    ['@jinn-network/client', 'operator', 4, 'product'],
  ].map(([name, path, tier, classification]) => packageEntry(name, path, {
    tier,
    ...(tier === null ? { tierReason: 'Fixture legacy package is outside the tier model.' } : {}),
    classification,
    stability: 'candidate',
    releaseGroup: 'legacy-product-lines',
    publishPolicy: 'independent',
  }));
  const otherPackages = [
    ['@jinn-network/indexer', 'packages/indexer', null, 'transitional', 'never'],
    ['@jinn-network/indexer-enrichment', 'packages/indexer-enrichment', null, 'product-support', 'never'],
    ['@jinn-network/explorer-spa', 'packages/indexer/explorer', 4, 'product', 'private'],
    ['@jinn-network/broadcast-bot', 'apps/broadcast-bot', null, 'repository-tooling', 'never'],
    ['@jinn-network/operator-console', 'apps/operator-console', 4, 'product', 'private'],
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
      { path: 'operator', mode: 'package' },
      { path: 'apps/operator-console', mode: 'package' },
      { path: 'plugin/runtime', mode: 'package' },
    ],
    manifestExclusions: [],
    ownerGroups: {
      'architecture-control': ['@oaksprout', '@ritsukai', '@ritsuKai2000'],
    },
    gateDefinitions: {
      'fixture-ci': { kind: 'workflow', path: '.github/workflows/fixture.yml' },
    },
    releaseGroups: {
      'platform-v1': {
        expectedPackageCount: 50,
        publishPolicies: ['canary-only'],
        requiredGateIds: ['fixture-ci'],
        allowedClassifications: ['platform', 'platform-support'],
        allowedDependencyReleaseGroups: ['platform-v1'],
        stackPublished: true,
        canary: true,
        stable: false,
      },
      'experimental-environment-supply': {
        expectedPackageCount: 7,
        publishPolicies: ['disabled'],
        requiredGateIds: ['fixture-ci'],
        allowedClassifications: ['platform'],
        allowedDependencyReleaseGroups: ['experimental-environment-supply', 'platform-v1'],
        stackPublished: false,
        canary: false,
        stable: false,
      },
      'legacy-product-lines': {
        expectedPackageCount: 5,
        publishPolicies: ['independent'],
        requiredGateIds: ['fixture-ci'],
        allowedClassifications: ['legacy', 'product'],
        allowedDependencyReleaseGroups: ['legacy-product-lines', 'platform-v1'],
        stackPublished: false,
        canary: false,
        stable: false,
      },
      'transitional-or-private': {
        expectedPackageCount: 6,
        publishPolicies: ['private', 'never'],
        requiredGateIds: ['fixture-ci'],
        allowedClassifications: ['product', 'product-support', 'repository-tooling', 'transitional'],
        allowedDependencyReleaseGroups: [
          'experimental-environment-supply',
          'legacy-product-lines',
          'platform-v1',
          'transitional-or-private',
        ],
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

export function disableReleaseGroup(catalog, releaseGroup = 'platform-v1') {
  const definition = catalog.releaseGroups[releaseGroup];
  definition.publishPolicies = ['disabled'];
  definition.stackPublished = false;
  definition.canary = false;
  definition.stable = false;
  for (const pkg of catalog.packages.filter((entry) => entry.releaseGroup === releaseGroup)) {
    pkg.publishPolicy = 'disabled';
  }
  return catalog;
}

export function fixtureRepo({ catalog = fixtureCatalog(), manifests = {}, schema = catalogSchema } = {}) {
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
