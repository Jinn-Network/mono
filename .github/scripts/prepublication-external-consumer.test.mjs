import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { canonicalJsonBytes } from './build-prepublication-bundle.mjs';
import { fixtureCatalog, fixtureRepo } from './platform-catalog-test-fixture.mjs';
import { loadCatalogPackages } from './platform-catalog.mjs';
import {
  deriveNativeVerticalRoleClosures,
  nativeVerticalRuntimePackageNames,
} from './native-vertical-role-packages.mjs';
import {
  sourceWildcardExportViolations,
  runConsumerProbe,
  runTarballConsumer,
  writeConsumerProbe,
} from './prepublication-external-consumer.mjs';

const SHA = 'b'.repeat(40);
const repoRoot = resolve(import.meta.dirname, '../..');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function bundleFixture(root) {
  const bundle = mkdtempSync(join(tmpdir(), 'jinn-consumer-bundle-'));
  mkdirSync(join(bundle, 'tarballs'));
  const catalog = fixtureCatalog();
  const packages = catalog.packages
    .filter(({ releaseGroup }) => releaseGroup === 'platform-v1')
    .sort((left, right) => left.path.localeCompare(right.path));
  const tarballs = packages.map(({ name }, index) => {
    const filename = `tarballs/package-${String(index + 1).padStart(2, '0')}.tgz`;
    const bytes = Buffer.from(`tarball:${name}`);
    writeFileSync(join(bundle, filename), bytes);
    return { name, filename, integrity: sri(bytes) };
  });
  const catalogBytes = readFileSync(join(root, 'architecture/platform-packages.v1.json'));
  const manifest = {
    schemaVersion: 1,
    sourceSha: SHA,
    catalog: {
      path: 'architecture/platform-packages.v1.json',
      sha256: sha256(catalogBytes),
    },
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packageVersion: `0.1.0-canary.sha.${SHA}`,
    distTag: 'canary',
    waves: [packages.map(({ name }) => name)],
    packageOrder: packages.map(({ name }) => name),
    tarballs,
  };
  const manifestPath = join(bundle, 'manifest.json');
  writeFileSync(manifestPath, canonicalJsonBytes(manifest), 'utf8');
  return { bundle, manifest, manifestPath };
}

test('installs every catalog tarball transiently behind exact version roots with no retained local provenance', async () => {
  const root = fixtureRepo();
  const { bundle, manifest, manifestPath } = bundleFixture(root);
  const calls = [];
  let installedManifest;
  let npmrc;
  let npmOptions;
  try {
    const result = await runTarballConsumer({
      repoRoot: root,
      manifestPath,
      exec(command, args, cwd, options) {
        calls.push({ command, args: [...args], cwd });
        if (command === 'npm') {
          installedManifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
          npmrc = readFileSync(join(cwd, '.npmrc'), 'utf8');
          npmOptions = options;
          if (args[0] === 'install') {
            mkdirSync(join(cwd, 'node_modules/.bin'), { recursive: true });
            symlinkSync('../package/bin.mjs', join(cwd, 'node_modules/.bin/package'));
          }
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    assert.equal(result.packageCount, manifest.packageOrder.length);
    assert.equal(result.results.length, 1);
    assert.equal(Object.keys(installedManifest.dependencies).length, manifest.packageOrder.length);
    for (const specifier of Object.values(installedManifest.dependencies)) {
      assert.equal(specifier, manifest.packageVersion);
    }
    assert.match(npmrc, /^@jinn-network:registry=http:\/\/127\.0\.0\.1:9\/$/mu);
    assert.match(npmrc, /^fetch-retries=0$/mu);
    assert.match(npmOptions.env.HOME, /jinn-platform-prepublication-consumer-/u);
    assert.match(npmOptions.env.npm_config_cache, /jinn-platform-prepublication-consumer-.+\/\.npm-cache$/u);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].args.slice(0, 7), [
      'install',
      '--no-save',
      '--no-package-lock',
      '--ignore-scripts',
      '--registry',
      'https://registry.npmjs.org',
      join(bundle, manifest.tarballs[0].filename),
    ]);
    assert.equal(calls[0].args.slice(6).length, manifest.packageOrder.length);
    assert.deepEqual([calls[1].command, ...calls[1].args], [process.execPath, 'consumer-probe.mjs']);
    assert.deepEqual([calls[2].command, ...calls[2].args], ['npm', 'ls', '--all', '--json']);
    assert.equal(calls.some(({ args }) => args.includes('publish')), false);
    assert.equal(existsSync(join(calls[0].cwd, 'node_modules/.bin')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('a missing tarball fails before npm or the probe can run', async () => {
  const root = fixtureRepo();
  const { bundle, manifest, manifestPath } = bundleFixture(root);
  const calls = [];
  try {
    const missingName = manifest.tarballs[17].name;
    unlinkSync(join(bundle, manifest.tarballs[17].filename));
    await assert.rejects(
      runTarballConsumer({ repoRoot: root, manifestPath, exec: (...args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      } }),
      new RegExp(`missing tarball for ${missingName.replace('/', '\\/')}`, 'u'),
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('rejects local provenance reported by the installed dependency graph', async () => {
  const root = fixtureRepo();
  const { bundle, manifestPath } = bundleFixture(root);
  try {
    await assert.rejects(runTarballConsumer({
      repoRoot: root,
      manifestPath,
      exec(command, args) {
        if (command === 'npm' && args[0] === 'ls') {
          return {
            status: 0,
            stdout: JSON.stringify({ dependencies: { bad: { resolved: 'file:/source/package.tgz' } } }),
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    }), /retains forbidden local provenance file:\/source\/package\.tgz/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('package-set drift fails before npm or the probe can run', async () => {
  const root = fixtureRepo();
  const { bundle, manifest, manifestPath } = bundleFixture(root);
  const calls = [];
  try {
    manifest.packageOrder.pop();
    manifest.waves[0].pop();
    manifest.tarballs.pop();
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await assert.rejects(
      runTarballConsumer({ repoRoot: root, manifestPath, exec: (...args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      } }),
      /bundle package set does not match its catalog-derived package selection/u,
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bundle, { recursive: true, force: true });
  }
});

function installedProbeFixture() {
  const consumer = mkdtempSync(join(tmpdir(), 'jinn-installed-consumer-'));
  const packageRoot = join(consumer, 'node_modules/@jinn-network/demo');
  for (const path of ['dist', 'assets/schemas', 'profiles/v1', 'fixtures']) {
    mkdirSync(join(packageRoot, path), { recursive: true });
  }
  const manifest = {
    name: '@jinn-network/demo',
    version: `0.1.0-canary.sha.${SHA}`,
    gitHead: SHA,
    type: 'module',
    exports: {
      '.': { import: './dist/index.js', default: './dist/default.js' },
      './testing': './dist/testing.js',
      './schemas/*': './assets/schemas/*',
      './profiles/*': './profiles/*',
      './fixtures/*': './fixtures/*',
    },
  };
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'jinn-installed-consumer-fixture',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { [manifest.name]: manifest.version },
  })}\n`, 'utf8');
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  writeFileSync(join(packageRoot, 'dist/index.js'), 'export const installed = true;\n', 'utf8');
  writeFileSync(join(packageRoot, 'dist/default.js'), 'export const wrongCondition = true;\n', 'utf8');
  writeFileSync(join(packageRoot, 'dist/testing.js'), 'export const conformance = true;\n', 'utf8');
  writeFileSync(join(packageRoot, 'assets/schemas/task.schema.json'), '{}\n', 'utf8');
  writeFileSync(join(packageRoot, 'assets/schemas/result.schema.json'), '{}\n', 'utf8');
  writeFileSync(join(packageRoot, 'profiles/v1/profile.json'), '{}\n', 'utf8');
  writeFileSync(join(packageRoot, 'fixtures/example.json'), '{}\n', 'utf8');
  const expectations = {
    sourceSha: SHA,
    packageVersion: manifest.version,
    packages: [{
      name: manifest.name,
      exports: manifest.exports,
      publicFiles: [
        'assets/schemas/result.schema.json',
        'assets/schemas/task.schema.json',
        'fixtures/example.json',
        'profiles/v1/profile.json',
      ],
      publicSurface: {
        schemas: ['assets/schemas'],
        profiles: ['profiles'],
        fixtures: ['fixtures'],
        conformance: ['./testing'],
      },
    }],
  };
  writeConsumerProbe({ consumerRoot: consumer, expectations });
  return { consumer, packageRoot };
}

test('the external probe resolves installed roots, conformance exports, schemas, profiles, and fixtures', () => {
  const { consumer } = installedProbeFixture();
  try {
    const result = runConsumerProbe({ consumerRoot: consumer });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /resolved 6 installed targets across 1 packages/u);
    const provenance = JSON.parse(readFileSync(
      join(consumer, 'module-resolution-provenance.json'),
      'utf8',
    ));
    assert.equal(provenance.schemaVersion, 1);
    assert.ok(provenance.resolutions.every(({ path }) => path.startsWith('node_modules/')));
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test('the external probe rejects one missing public file even when its declared directory remains nonempty', () => {
  const { consumer, packageRoot } = installedProbeFixture();
  try {
    unlinkSync(join(packageRoot, 'assets/schemas/task.schema.json'));
    const result = runConsumerProbe({ consumerRoot: consumer });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing expected public file assets\/schemas\/task\.schema\.json/u);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test('the external probe rejects export-map drift and preserves conditional export order', () => {
  const { consumer, packageRoot } = installedProbeFixture();
  try {
    const manifestPath = join(packageRoot, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete manifest.exports['./testing'];
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    const result = runConsumerProbe({ consumerRoot: consumer });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /installed export map does not match the source manifest/u);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test('the external probe requires every conditional wildcard target for each concrete capture', () => {
  const { consumer, packageRoot } = installedProbeFixture();
  try {
    mkdirSync(join(packageRoot, 'dist/features'), { recursive: true });
    writeFileSync(join(packageRoot, 'dist/features/alpha.js'), 'export const alpha = true;\n', 'utf8');
    const manifestPath = join(packageRoot, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.exports['./features/*'] = {
      import: './dist/features/*.js',
      types: './dist/features/*.d.ts',
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    const expectationsPath = join(consumer, 'consumer-expectations.json');
    const expectations = JSON.parse(readFileSync(expectationsPath, 'utf8'));
    expectations.packages[0].exports = manifest.exports;
    writeFileSync(expectationsPath, `${JSON.stringify(expectations)}\n`, 'utf8');

    const result = runConsumerProbe({ consumerRoot: consumer });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /export \.\/features\/\* capture alpha is missing target dist\/features\/alpha\.d\.ts/u);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test('the external probe rejects a declared public target missing from the installed tarball', () => {
  const { consumer, packageRoot } = installedProbeFixture();
  try {
    unlinkSync(join(packageRoot, 'profiles/v1/profile.json'));
    const result = runConsumerProbe({ consumerRoot: consumer });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /export \.\/profiles\/\* has no installed tarball targets/u);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test('the external probe rejects an installed package export with no concrete tarball target', () => {
  const { consumer, packageRoot } = installedProbeFixture();
  try {
    const manifestPath = join(packageRoot, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.exports['./dead/*'] = './dead/*';
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    const expectationsPath = join(consumer, 'consumer-expectations.json');
    const expectations = JSON.parse(readFileSync(expectationsPath, 'utf8'));
    expectations.packages[0].exports['./dead/*'] = './dead/*';
    writeFileSync(expectationsPath, `${JSON.stringify(expectations)}\n`, 'utf8');
    const result = runConsumerProbe({ consumerRoot: consumer });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /export \.\/dead\/\* has no installed tarball targets/u);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test('every platform wildcard export has at least one concrete source target to pack', () => {
  assert.deepEqual(sourceWildcardExportViolations(repoRoot), []);
});

test('native role closures come from executable fixture manifests and include only transitive catalog dependencies', () => {
  const packages = loadCatalogPackages(repoRoot);
  const roles = deriveNativeVerticalRoleClosures(repoRoot, packages);
  assert.deepEqual(Object.keys(roles), ['requester', 'operator', 'evaluator', 'consumer']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(roles).map(([role, value]) => [role, value.closure.length])),
    { requester: 15, operator: 26, evaluator: 29, consumer: 10 },
  );
  assert.equal(
    new Set(Object.values(roles).flatMap(({ closure }) => closure)).size,
    32,
    'native role union must exclude the legacy marketplace pipeline',
  );
  assert.equal(roles.operator.closure.includes('@jinn-network/marketplace-pipeline'), false);
  assert.equal(roles.requester.roots.includes('@jinn-network/task-derivation'), false);
  assert.equal(roles.requester.roots.includes('@jinn-network/task-posting'), false);
  assert.ok(roles.requester.closure.includes('@jinn-network/environment-record'));
  const promoted = [];
  const packed = nativeVerticalRuntimePackageNames(repoRoot, packages, promoted);
  for (const name of promoted) assert.ok(packed.includes(name), name);
  assert.equal(packed.includes('@jinn-network/task-curation'), false);
  assert.equal(packed.includes('@jinn-network/chain-scenarios'), false);
});
