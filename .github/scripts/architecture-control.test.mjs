import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { fixtureCatalog, fixtureRepo } from './platform-catalog-test-fixture.mjs';
import { loadPlatformCatalog } from './platform-catalog.mjs';

const implementation = import('./architecture-control.mjs');
const repoRoot = resolve(import.meta.dirname, '../..');
const REQUIRED = ['@oaksprout', '@ritsukai'];

function write(path, value = '') {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function walkFirstPartyFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && ['node_modules', 'dist', 'build', '.yarn'].includes(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...walkFirstPartyFiles(root, path));
    else if (entry.isFile()) files.push(path.slice(root.length + 1).split('\\').join('/'));
  }
  return files;
}

function completeFixture(catalog = fixtureCatalog()) {
  const root = fixtureRepo({ catalog });
  for (const path of [
    'contracts/.keep',
    'docs/superpowers/specs/.keep',
    'packages/marketplace/binding/.keep',
    'packages/marketplace/testing/.keep',
    '.github/workflows/jinn-plugin-split.yml',
    '.github/CODEOWNERS',
  ]) write(join(root, path));
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

test('enumerates newly named and indirectly declared generator sources without build/dependency trees', async () => {
  const { validateArchitectureControl } = await implementation;
  const root = completeFixture();
  try {
    const manifestPath = join(root, 'packages/fixture/protocol/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.scripts = { refresh: 'node tools/refresh-assets.mjs' };
    write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    write(join(root, 'packages/fixture/protocol/tools/refresh-assets.mjs'), "import './helpers/write-assets.mjs';\n");
    write(join(root, 'packages/fixture/protocol/tools/helpers/write-assets.mjs'), 'export {};\n');
    write(join(root, 'packages/fixture/protocol/tools/node_modules/ignored.mjs'), 'export {};\n');
    write(join(root, 'packages/fixture/protocol/tools/dist/ignored.mjs'), 'export {};\n');
    write(join(root, 'packages/fixture/protocol/tools/build/ignored.mjs'), 'export {};\n');
    const report = validateArchitectureControl({ repoRoot: root });
    const generators = new Set(report.paths
      .filter((entry) => entry.categories.includes('generatorSources'))
      .map((entry) => entry.path));
    assert.ok(generators.has('packages/fixture/protocol/tools/refresh-assets.mjs'));
    assert.ok(generators.has('packages/fixture/protocol/tools/helpers/write-assets.mjs'));
    assert.equal([...generators].some((path) => /\/(?:node_modules|dist|build)\//u.test(path)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enumerates an unreferenced catalog gate definition independently', async () => {
  const { validateArchitectureControl } = await implementation;
  const catalog = fixtureCatalog();
  catalog.gateDefinitions['unreferenced-gate'] = {
    kind: 'workflow',
    path: '.github/workflows/unreferenced.yml',
  };
  const root = completeFixture(catalog);
  try {
    write(join(root, '.github/workflows/unreferenced.yml'), 'name: unreferenced\n');
    const report = validateArchitectureControl({ repoRoot: root });
    const entry = report.paths.find((candidate) => candidate.path === '.github/workflows/unreferenced.yml');
    assert.ok(entry?.categories.includes('requiredGates'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git candidate inventory excludes ignored machine files and includes intended untracked controls', async () => {
  const { repositoryCandidateFiles, validateArchitectureControl } = await implementation;
  const catalog = fixtureCatalog();
  catalog.packages[0].publicSurface.schemas = ['schemas'];
  const root = completeFixture(catalog);
  try {
    write(join(root, 'packages/fixture/protocol/schemas/tracked.schema.json'), '{"type":"object"}\n');
    write(join(root, '.gitignore'), '**/.DS_Store\n');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });

    const baseline = validateArchitectureControl({ repoRoot: root });
    write(join(root, '.github/scripts/.DS_Store'), 'machine-local\n');
    write(join(root, 'packages/fixture/protocol/schemas/.DS_Store'), 'machine-local\n');
    write(join(root, '.github/scripts/review-fixture-tool.mjs'), 'export {};\n');
    write(join(root, 'packages/fixture/protocol/schemas/untracked.schema.json'), '{"type":"string"}\n');

    const candidates = repositoryCandidateFiles(root);
    assert.equal(candidates.includes('.github/scripts/.DS_Store'), false);
    assert.equal(candidates.includes('packages/fixture/protocol/schemas/.DS_Store'), false);
    assert.equal(candidates.includes('.github/scripts/review-fixture-tool.mjs'), true);
    assert.equal(candidates.includes('packages/fixture/protocol/schemas/untracked.schema.json'), true);

    rmSync(join(root, '.github/scripts/review-fixture-tool.mjs'));
    rmSync(join(root, 'packages/fixture/protocol/schemas/untracked.schema.json'));
    assert.deepEqual(validateArchitectureControl({ repoRoot: root }), baseline);

    write(join(root, '.github/scripts/review-fixture-tool.mjs'), 'export {};\n');
    write(join(root, 'packages/fixture/protocol/schemas/untracked.schema.json'), '{"type":"string"}\n');
    const withUntracked = validateArchitectureControl({ repoRoot: root });
    assert.ok(withUntracked.paths.some(({ path }) => (
      path === '.github/scripts/review-fixture-tool.mjs'
    )));
    assert.ok(withUntracked.paths.some(({ path }) => (
      path === 'packages/fixture/protocol/schemas/untracked.schema.json'
    )));
    const codeownersPath = join(root, '.github/CODEOWNERS');
    write(
      codeownersPath,
      `${readFileSync(codeownersPath, 'utf8')}/.github/scripts/review-fixture-tool.mjs @attacker\n`,
    );
    assert.throws(
      () => validateArchitectureControl({ repoRoot: root }),
      /review-fixture-tool\.mjs: effective owners must be exactly/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate inventory fails closed in Git checkouts and falls back only for non-Git fixtures', async () => {
  const { repositoryCandidateFiles } = await implementation;
  const root = completeFixture();
  const gitFailure = () => {
    throw new Error('simulated Git failure');
  };
  try {
    const fallback = repositoryCandidateFiles(root, { runGit: gitFailure });
    assert.deepEqual(fallback, [...fallback].sort());
    assert.ok(fallback.includes('architecture/platform-packages.v1.json'));
    assert.equal(fallback.some((path) => path.startsWith('.git/')), false);

    execFileSync('git', ['init', '--quiet'], { cwd: root });
    assert.throws(
      () => repositoryCandidateFiles(root, { runGit: gitFailure }),
      /cannot enumerate repository candidates with git: simulated Git failure/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects prototype-inherited owner group names', async () => {
  const { validateArchitectureControl } = await implementation;
  const catalog = fixtureCatalog();
  catalog.packages[0].ownerGroup = 'toString';
  const root = completeFixture(catalog);
  try {
    assert.throws(
      () => validateArchitectureControl({ repoRoot: root }),
      /owner group toString/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      assert.throws(() => validateArchitectureControl({ repoRoot: root }), /uncataloged first-party manifests.*packages\/fixture\/new/u);
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
  assert.equal(first.counts.catalogManifests, loadPlatformCatalog(repoRoot).packages.length);
  for (const category of [
    'authorityDocuments', 'decisionRecords', 'boundaryPolicies', 'requiredGates',
    'catalogPublicSurfaces', 'discoveredFirstPartySurfaces', 'generatorSources',
    'generatedOutputSources', 'marketplaceControl', 'staticControl',
  ]) assert.ok(first.counts[category] > 0, `${category} is exhaustively represented`);
  assert.equal(first.paths.some((entry) => entry.path.startsWith('/Users/')), false);
  assert.equal('generatedAt' in first, false);
  assert.equal(first.paths.some((entry) => (
    entry.categories.includes('generatorSources')
      && /\/(?:node_modules|dist|build)\//u.test(`/${entry.path}/`)
  )), false);
  for (const entry of first.paths) {
    if (entry.categories.includes('catalogPublicSurfaces')
      || entry.categories.includes('conformancePackedTargets')) {
      assert.ok(entry.categories.includes('generatedOutputSources'), `generated output category ${entry.path}`);
    }
  }
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
    for (const [surface, values] of Object.entries(pkg.publicSurface)) {
      if (surface === 'conformance') continue;
      for (const value of values) {
        const path = value === '.' ? pkg.path : `${pkg.path}/${value.replace(/^\.\//u, '')}`;
        assert.ok(entries.get(path)?.has('generatedOutputSources'), `generated output ${path}`);
      }
    }
    for (const exportKey of pkg.publicSurface.conformance) {
      const resolved = resolveConformanceSources(repoRoot, pkg, manifest, exportKey);
      for (const source of resolved.sources) {
        const path = `${pkg.path}/${source.replace(/^\.\//u, '')}`;
        assert.ok(entries.get(path)?.has('conformanceSources'), path);
        assert.ok(entries.get(path)?.has('generatedOutputSources'), `generated conformance source ${path}`);
      }
      for (const target of resolved.packedTargets) {
        const path = `${pkg.path}/${target.replace(/^\.\//u, '')}`;
        assert.ok(entries.get(path)?.has('generatedOutputSources'), `generated packed target ${path}`);
      }
    }
    const scriptsRoot = join(repoRoot, pkg.path, 'scripts');
    if (existsSync(scriptsRoot) && statSync(scriptsRoot).isDirectory()) {
      for (const file of walkFirstPartyFiles(scriptsRoot)) {
        const path = `${pkg.path}/scripts/${file}`;
        assert.ok(entries.get(path)?.has('generatorSources'), `package generator ${path}`);
      }
    }
  }
  for (const root of ['.github/scripts', '.github/workflows']) {
    const absolute = join(repoRoot, root);
    for (const file of walkFirstPartyFiles(absolute)) {
      const path = `${root}/${file}`;
      assert.ok(entries.get(path)?.has('generatorSources'), `repository generator ${path}`);
    }
  }
});
