#!/usr/bin/env node
/**
 * Proves the source-level hermetic suite has a separately installable runtime
 * closure. The suite still needs its checked-in fixtures, but package imports
 * used by the daemon must resolve from a clean npm consumer rather than from
 * Yarn portal links in this checkout.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFixtureLockfilePresent,
  buildConsumerThirdPartyDependencies,
  discoverPackageRoots,
  firstPartyArchiveDependencies,
  installPinnedGraph,
  noLocalSpec,
  packedClosurePackageNames,
  packedOverlayInstallArgs,
  readPackageJson,
  requirePackageRoot,
  sanitizedManifest,
  writeConsumerPackageJson,
} from './lib/hermetic-packed-closure.mjs';

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(scriptsRoot, '..');
const repoRoot = resolve(clientRoot, '..');
const packagesRoot = join(repoRoot, 'packages');
const closureRoot = mkdtempSync(join(tmpdir(), 'jinn-hermetic-packed-closure-'));
const archivesRoot = join(closureRoot, 'archives');
const consumerRoot = join(closureRoot, 'consumer');
const stagingRoot = join(closureRoot, 'staging');
const productRoot = join(consumerRoot, 'product');
// Every npm child uses a cache that starts empty for this run, so `--offline`
// reaches only the tarballs `npm ci` fetched by lockfile integrity. A warm user
// cache would otherwise let an offline install resolve a range from whatever
// registry metadata it happens to hold.
process.env.npm_config_cache = join(closureRoot, 'npm-cache');

function run(command, args, context, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    const output = [result.error?.message, result.stderr, result.stdout]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .join('\n');
    throw new Error(
      `${context} failed\n${output}`,
    );
  }
  return result;
}

function assertNoForbiddenLocalSpecs(value, context) {
  if (typeof value === 'string') {
    noLocalSpec(value, context);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenLocalSpecs(item, context);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertNoForbiddenLocalSpecs(item, context);
  }
}

function copyPackage(sourceRoot, targetRoot, context) {
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const name = source.split('/').at(-1);
      return name !== 'node_modules' && name !== '.git' && !name?.startsWith('.jinn-pack-');
    },
  });
  writeFileSync(
    join(targetRoot, 'package.json'),
    `${JSON.stringify(sanitizedManifest(readPackageJson(sourceRoot), context), null, 2)}\n`,
  );
}

function pack(root, destination, context) {
  const output = run(
    'npm',
    ['pack', '--json', '--pack-destination', destination, '--ignore-scripts'],
    context,
    { cwd: root },
  ).stdout;
  const entries = JSON.parse(output);
  if (entries.length !== 1 || typeof entries[0]?.filename !== 'string') {
    throw new Error(`${context} did not produce exactly one tarball.`);
  }
  return join(destination, entries[0].filename);
}

function stageAndPack(sourceRoot, packageName) {
  const stagedRoot = join(stagingRoot, packageName.replaceAll('/', '__'));
  copyPackage(sourceRoot, stagedRoot, packageName);
  return pack(stagedRoot, archivesRoot, `pack ${packageName}`);
}

function installPackedArchives(archives, context) {
  run('npm', packedOverlayInstallArgs(archives), context, { cwd: consumerRoot });
}

function assertNoPersistedLocalSpecs(root) {
  const manifest = readPackageJson(root);
  assertNoForbiddenLocalSpecs(manifest, `${root}/package.json`);
  for (const packageName of readdirSync(join(root, 'node_modules', '@jinn-network'))) {
    const packageRoot = join(root, 'node_modules', '@jinn-network', packageName);
    assertNoForbiddenLocalSpecs(readPackageJson(packageRoot), `${packageName}/package.json`);
  }
}

function assertArchiveContains(archive, entry, context) {
  const entries = run('tar', ['-tzf', archive], context).stdout.split(/\r?\n/u);
  if (!entries.includes(entry)) {
    throw new Error(`${context} is missing ${entry}. Build the product before packing it.`);
  }
}

function assertInstalledUnderConsumer(packageName) {
  const installed = join(consumerRoot, 'node_modules', ...packageName.split('/'));
  const relativeInstalled = relative(consumerRoot, installed);
  if (relativeInstalled.startsWith('..')) {
    throw new Error(`${packageName} resolved outside the clean consumer.`);
  }
  if (lstatSync(installed).isSymbolicLink()) {
    throw new Error(`${packageName} is a symbolic link rather than packed content.`);
  }
}

try {
  const packageRoots = discoverPackageRoots(packagesRoot);
  const clientManifest = readPackageJson(clientRoot);
  const names = packedClosurePackageNames(clientManifest, packageRoots);

  mkdirSync(archivesRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  const archives = new Map();
  const closureManifests = [];
  for (const name of names) {
    const packageRoot = requirePackageRoot(packageRoots, name);
    archives.set(name, stageAndPack(packageRoot, name));
    closureManifests.push(readPackageJson(packageRoot));
  }

  mkdirSync(consumerRoot, { recursive: true });
  const thirdParty = buildConsumerThirdPartyDependencies({
    operatorManifest: clientManifest,
    closureManifests,
  });
  writeConsumerPackageJson(consumerRoot, {
    dependencies: {
      ...thirdParty.dependencies,
      ...firstPartyArchiveDependencies(consumerRoot, archives),
    },
    devDependencies: thirdParty.devDependencies,
  });
  installPinnedGraph({
    run,
    consumerRoot,
    lockfileSource: assertFixtureLockfilePresent(scriptsRoot),
  });
  const closureDependencies = Object.fromEntries(
    names.map((name, index) => [name, closureManifests[index].version]),
  );

  for (const name of names) {
    assertInstalledUnderConsumer(name);
  }

  copyPackage(clientRoot, productRoot, '@jinn-network/operator');
  const tsc = join(consumerRoot, 'node_modules', '.bin', 'tsc');
  // Type-checking the whole client against the packed closure sits close to
  // Node's default old-space ceiling and has run out of heap on a CI runner,
  // failing the gate for reasons unrelated to the change under test. Give this
  // one child explicit headroom; a caller-supplied NODE_OPTIONS is appended
  // last so it still wins.
  const compilerNodeOptions = ['--max-old-space-size=8192', process.env.NODE_OPTIONS]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(' ');
  run(tsc, ['--project', 'tsconfig.json'], 'compile client against clean packed closure', {
    cwd: productRoot,
    env: { ...process.env, NODE_OPTIONS: compilerNodeOptions },
  });
  const clientArchive = stageAndPack(productRoot, '@jinn-network/operator');
  assertArchiveContains(clientArchive, 'package/dist/bin/jinn.js', 'packed client');
  assertArchiveContains(
    clientArchive,
    'package/dist/daemon/bridge-legacy-delivery.js',
    'packed client',
  );
  rmSync(productRoot, { recursive: true, force: true });
  // package.json still names the first-party archives, so the pinned closure
  // satisfies the client's `@jinn-network/*` and third-party ranges offline.
  installPackedArchives([clientArchive], 'install packed client into clean closure');
  assertInstalledUnderConsumer('@jinn-network/operator');
  writeConsumerPackageJson(consumerRoot, {
    dependencies: {
      ...thirdParty.dependencies,
      ...closureDependencies,
      '@jinn-network/operator': clientManifest.version,
    },
    devDependencies: thirdParty.devDependencies,
  });
  assertNoPersistedLocalSpecs(consumerRoot);
  const resolved = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'process.stdout.write(import.meta.resolve("@jinn-network/marketplace-pipeline"));',
    ],
    'resolve marketplace pipeline from packed client consumer',
    { cwd: consumerRoot },
  ).stdout.trim();
  const resolvedPath = fileURLToPath(resolved);
  const relativeResolved = relative(realpathSync(consumerRoot), resolvedPath);
  if (relativeResolved.startsWith('..')) {
    throw new Error(`marketplace pipeline resolved outside the packed consumer: ${resolved}`);
  }
  const installedBridge = join(
    consumerRoot,
    'node_modules',
    '@jinn-network',
    'operator',
    'dist',
    'daemon',
    'bridge-legacy-delivery.js',
  );
  run(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(`file://${installedBridge}`)});`],
    'load packed client daemon import path',
    { cwd: consumerRoot },
  );
  run(
    'npm',
    ['ls', '--all', '@jinn-network/operator', '@jinn-network/marketplace-pipeline'],
    'inspect packed client dependency graph',
    { cwd: consumerRoot },
  );
  console.log(`smoke-test-hermetic-packed-closure: compiled and loaded the client against ${names.length} packed Jinn packages with no local dependency specifiers.`);
} finally {
  rmSync(closureRoot, { recursive: true, force: true });
}
