import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { fixtureCatalog, fixtureRepo } from './platform-catalog-test-fixture.mjs';

const implementation = import('./architecture-control.mjs');
const repoRoot = resolve(import.meta.dirname, '../..');
const REQUIRED = ['@oaksprout', '@ritsukai'];

function write(path, value = '') {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function completeFixture() {
  const root = fixtureRepo();
  for (const path of [
    'contracts/.keep',
    'docs/superpowers/specs/.keep',
    'packages/marketplace/binding/.keep',
    'packages/marketplace/testing/.keep',
    '.github/workflows/jinn-plugin-split.yml',
    '.github/CODEOWNERS',
  ]) write(join(root, path));
  const catalog = fixtureCatalog();
  const rules = [
    '/architecture/',
    '/docs/superpowers/specs/',
    '/contracts/',
    '/.github/scripts/',
    '/.github/workflows/',
    '/packages/marketplace/binding/',
    '/packages/marketplace/testing/',
    '/.github/CODEOWNERS',
    ...catalog.packages.map((pkg) => `/${pkg.path}/`),
    '/docs/fixture-authority.md',
  ];
  write(join(root, '.github/CODEOWNERS'), `${rules.map((rule) => `${rule} ${REQUIRED.join(' ')}`).join('\n')}\n`);
  return root;
}

test('parser implements root anchoring, directories, *, **, and last match', async () => {
  const { effectiveOwners, parseCodeowners } = await implementation;
  const rules = parseCodeowners([
    '/packages/*/schemas/ @wrong',
    '/packages/**/schemas/ @oaksprout @ritsukai',
    '/exact/file.json @oaksprout @ritsukai',
  ].join('\n'));
  assert.deepEqual(effectiveOwners(rules, 'packages/a/nested/schemas/item.json'), REQUIRED);
  assert.deepEqual(effectiveOwners(rules, 'exact/file.json'), REQUIRED);
  assert.deepEqual(effectiveOwners(rules, 'nested/exact/file.json'), []);
});

test('parser rejects malformed and unsupported patterns fail closed', async (t) => {
  const { parseCodeowners } = await implementation;
  for (const [name, source] of [
    ['unanchored', 'packages/** @oaksprout @ritsukai'],
    ['negation', '!/packages/** @oaksprout @ritsukai'],
    ['character class', '/packages/[ab]/** @oaksprout @ritsukai'],
    ['triple star', '/packages/***/x @oaksprout @ritsukai'],
    ['missing owner', '/packages/**'],
  ]) {
    await t.test(name, () => assert.throws(() => parseCodeowners(source), /CODEOWNERS/u));
  }
});

test('conformance export keys resolve to actual first-party sources and declared packed targets', async () => {
  const { resolveConformanceSources } = await implementation;
  const root = completeFixture();
  try {
    write(join(root, 'packages/fixture/protocol/src/testing.ts'), 'export {};\n');
    const resolved = resolveConformanceSources(
      root,
      { name: '@jinn-network/fixture-protocol', path: 'packages/fixture/protocol' },
      { exports: { './testing': { import: './dist/testing.js', types: './dist/testing.d.ts' } } },
      './testing',
    );
    assert.deepEqual(resolved.sources, ['./src/testing.ts']);
    assert.deepEqual(resolved.packedTargets, ['./dist/testing.d.ts', './dist/testing.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('later CODEOWNERS override and missing required owner are rejected', async (t) => {
  const { validateArchitectureControl } = await implementation;
  for (const [name, mutate, pattern] of [
    ['later override', (source) => `${source}/packages/fixture/protocol/** @attacker\n`, /effective owners/u],
    ['missing owner', (source) => source.replace('/architecture/ @oaksprout @ritsukai', '/architecture/ @oaksprout'), /effective owners/u],
  ]) {
    await t.test(name, () => {
      const root = completeFixture();
      try {
        const path = join(root, '.github/CODEOWNERS');
        write(path, mutate(readFileSync(path, 'utf8')));
        assert.throws(() => validateArchitectureControl({ repoRoot: root }), pattern);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('effective ownership compares as a set and reports canonical owner order', async () => {
  const { validateArchitectureControl } = await implementation;
  const root = completeFixture();
  try {
    const path = join(root, '.github/CODEOWNERS');
    write(path, readFileSync(path, 'utf8').replaceAll('@oaksprout @ritsukai', '@ritsukai @oaksprout'));
    const report = validateArchitectureControl({ repoRoot: root });
    assert.deepEqual(report.requiredOwners, REQUIRED);
    assert.ok(report.paths.every((entry) => JSON.stringify(entry.owners) === JSON.stringify(REQUIRED)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new scoped manifest and new public/testing surface cannot arrive uncovered', async (t) => {
  const { validateArchitectureControl } = await implementation;
  await t.test('new manifest', () => {
    const root = completeFixture();
    try {
      write(join(root, 'packages/fixture/new/package.json'), '{"name":"@jinn-network/new","version":"0.1.0"}\n');
      assert.throws(() => validateArchitectureControl({ repoRoot: root }), /uncataloged manifests.*packages\/fixture\/new/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test('new public surface directory', () => {
    const root = completeFixture();
    try {
      const codeownersPath = join(root, '.github/CODEOWNERS');
      write(codeownersPath, readFileSync(codeownersPath, 'utf8').replace('/packages/fixture/protocol/', '/packages/fixture/protocol/package.json'));
      write(join(root, 'packages/fixture/protocol/testing/new-case.json'), '{}\n');
      assert.throws(() => validateArchitectureControl({ repoRoot: root }), /packages\/fixture\/protocol\/testing/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('catalog owner groups require exact local GitHub usernames and exact architecture owners', async (t) => {
  const { validateArchitectureControl } = await implementation;
  for (const [name, owners, pattern] of [
    ['malformed handle', ['@bad!', '@ritsukai'], /invalid GitHub username/u],
    ['wrong architecture group', ['@oaksprout', '@extra'], /architecture-control.*exactly/u],
  ]) {
    await t.test(name, () => {
      const catalog = fixtureCatalog();
      catalog.ownerGroups['architecture-control'] = owners;
      const root = fixtureRepo({ catalog });
      try {
        for (const path of ['contracts/.keep', 'docs/superpowers/specs/.keep', 'packages/marketplace/binding/.keep', 'packages/marketplace/testing/.keep']) write(join(root, path));
        write(join(root, '.github/CODEOWNERS'), '/** @oaksprout @ritsukai\n');
        assert.throws(() => validateArchitectureControl({ repoRoot: root }), pattern);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('repository coverage enumerates every manifest and all control-path categories deterministically', async () => {
  const { resolveConformanceSources, validateArchitectureControl } = await implementation;
  const first = validateArchitectureControl({ repoRoot });
  const second = validateArchitectureControl({ repoRoot });
  assert.deepEqual(first, second);
  assert.equal(first.counts.catalogManifests, 69);
  for (const category of [
    'authorityDocuments', 'decisionRecords', 'boundaryPolicies', 'requiredGates',
    'catalogPublicSurfaces', 'discoveredFirstPartySurfaces', 'generatorSources',
    'generatedOutputSources', 'marketplaceControl', 'staticControl',
  ]) assert.ok(first.counts[category] > 0, `${category} is exhaustively represented`);
  assert.equal(first.paths.some((entry) => entry.path.startsWith('/Users/')), false);
  assert.equal('generatedAt' in first, false);
  const catalog = JSON.parse(readFileSync(join(repoRoot, 'architecture/platform-packages.v1.json'), 'utf8'));
  const entries = new Map(first.paths.map((entry) => [entry.path, new Set(entry.categories)]));
  for (const pkg of catalog.packages) {
    assert.ok(entries.get(`${pkg.path}/package.json`)?.has('catalogManifests'), pkg.path);
    for (const document of pkg.authority.documents) {
      assert.ok(entries.get(document.path)?.has('authorityDocuments'), document.path);
    }
    if (pkg.authority.decisionRecord) {
      assert.ok(entries.get(pkg.authority.decisionRecord.path)?.has('decisionRecords'), pkg.authority.decisionRecord.path);
    }
    assert.ok(entries.get(pkg.boundaryPolicy.path)?.has('boundaryPolicies'), pkg.boundaryPolicy.path);
    for (const gate of pkg.requiredGateIds) {
      const path = catalog.gateDefinitions[gate].path;
      assert.ok(entries.get(path)?.has('requiredGates'), path);
    }
    const manifest = JSON.parse(readFileSync(join(repoRoot, pkg.path, 'package.json'), 'utf8'));
    for (const exportKey of pkg.publicSurface.conformance) {
      for (const source of resolveConformanceSources(repoRoot, pkg, manifest, exportKey).sources) {
        const path = `${pkg.path}/${source.replace(/^\.\//u, '')}`;
        assert.ok(entries.get(path)?.has('conformanceSources'), path);
      }
    }
  }
});
