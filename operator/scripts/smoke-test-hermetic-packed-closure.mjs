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
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(clientRoot, '..');
const packagesRoot = join(repoRoot, 'packages');
const closureRoot = mkdtempSync(join(tmpdir(), 'jinn-hermetic-packed-closure-'));
const archivesRoot = join(closureRoot, 'archives');
const consumerRoot = join(closureRoot, 'consumer');
const stagingRoot = join(closureRoot, 'staging');
const productRoot = join(consumerRoot, 'product');

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

function readPackageJson(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

function discoverPackageRoots(root, found = new Map()) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const entryPath = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    const manifestPath = join(entryPath, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@jinn-network/')) {
        found.set(manifest.name, entryPath);
      }
    } catch {
      discoverPackageRoots(entryPath, found);
    }
  }
  return found;
}

function closurePackageNames(clientManifest, packageRoots) {
  const pending = Object.keys(clientManifest.dependencies ?? {})
    .filter((name) => name.startsWith('@jinn-network/'));
  const names = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || names.has(name)) continue;
    const packageRoot = packageRoots.get(name);
    if (packageRoot === undefined) {
      throw new Error(`No local package root is available for ${name}.`);
    }
    names.add(name);
    const manifest = readPackageJson(packageRoot);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@jinn-network/')) pending.push(dependency);
    }
  }
  return [...names].sort();
}

function noLocalSpec(value, context) {
  if (typeof value === 'string' && /^(?:file|portal|workspace):/iu.test(value)) {
    throw new Error(`${context} contains a forbidden local dependency specifier: ${value}`);
  }
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

function sanitizedManifest(manifest, context, stripDevelopment = true) {
  const sanitized = { ...manifest };
  if (stripDevelopment) delete sanitized.devDependencies;
  delete sanitized.resolutions;
  delete sanitized.workspaces;
  for (const [field, value] of Object.entries(sanitized)) {
    if (/dependencies$/iu.test(field) && value !== null && typeof value === 'object') {
      for (const specifier of Object.values(value)) noLocalSpec(specifier, context);
    }
  }
  return sanitized;
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
  const args = ['pack', '--json', '--pack-destination', destination];
  args.push('--ignore-scripts');
  const output = run('npm', args, context, { cwd: root }).stdout;
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

function installPackedArchives(archives, context, offline = false) {
  run(
    'npm',
    [
      'install',
      '--no-save',
      '--ignore-scripts',
      '--package-lock=false',
      '--no-audit',
      '--no-fund',
      ...(offline ? ['--offline'] : []),
      ...archives,
    ],
    context,
    { cwd: consumerRoot },
  );
}

function writeConsumerManifest(dependencies, devDependencies = {}) {
  const manifest = sanitizedManifest({
    private: true,
    type: 'module',
    dependencies,
    devDependencies,
  }, 'clean consumer manifest', false);
  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
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
  const compileManifest = {
    ...clientManifest,
    dependencies: {
      ...clientManifest.dependencies,
      ...Object.fromEntries(
        Object.entries(clientManifest.devDependencies ?? {})
          .filter(([name]) => name.startsWith('@jinn-network/')),
      ),
    },
  };
  const names = closurePackageNames(compileManifest, packageRoots);

  mkdirSync(archivesRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  const archives = new Map();
  for (const name of names) {
    const archive = stageAndPack(packageRoots.get(name), name);
    archives.set(name, archive);
  }

  mkdirSync(consumerRoot, { recursive: true });
  const closureDependencies = Object.fromEntries(names.map((name) => [
    name,
    readPackageJson(packageRoots.get(name)).version,
  ]));
  const runtimeExternalDependencies = Object.fromEntries(
    Object.entries({
      ...clientManifest.dependencies,
      ...clientManifest.optionalDependencies,
    }).filter(([name]) => !name.startsWith('@jinn-network/')),
  );
  const compilerDependencies = Object.fromEntries(
    ['typescript', '@types/node', '@types/semver', '@types/ws']
      .map((name) => [name, clientManifest.devDependencies?.[name]])
      .filter(([, version]) => typeof version === 'string'),
  );
  writeConsumerManifest(runtimeExternalDependencies, compilerDependencies);
  run(
    'npm',
    ['install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'],
    'install dependency-only packed closure',
    { cwd: consumerRoot },
  );
  installPackedArchives([...archives.values()], 'install dependency-only packed closure');
  writeConsumerManifest({ ...runtimeExternalDependencies, ...closureDependencies }, compilerDependencies);

  for (const name of names) {
    assertInstalledUnderConsumer(name);
  }
  assertNoPersistedLocalSpecs(consumerRoot);

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
  writeConsumerManifest({
    ...runtimeExternalDependencies,
    ...closureDependencies,
    '@jinn-network/operator': clientManifest.version,
  }, compilerDependencies);
  installPackedArchives([clientArchive], 'install packed client into clean closure', true);
  assertInstalledUnderConsumer('@jinn-network/operator');
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
