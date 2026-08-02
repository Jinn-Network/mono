#!/usr/bin/env node
/**
 * Proves the source-level hermetic suite has a separately installable runtime
 * closure. The suite still needs its checked-in fixtures, but package imports
 * used by the daemon must resolve from a clean npm consumer rather than from
 * Yarn portal links in this checkout.
 */
import { spawnSync } from 'node:child_process';
import {
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

function run(command, args, context, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${context} failed\n${result.error?.message ?? result.stderr ?? result.stdout}`,
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

function pack(root, destination, context, ignoreScripts = true) {
  const args = ['pack', '--json', '--pack-destination', destination];
  if (ignoreScripts) args.push('--ignore-scripts');
  const output = run('npm', args, context, { cwd: root }).stdout;
  const entries = JSON.parse(output);
  if (entries.length !== 1 || typeof entries[0]?.filename !== 'string') {
    throw new Error(`${context} did not produce exactly one tarball.`);
  }
  return join(destination, entries[0].filename);
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
  const names = closurePackageNames(clientManifest, packageRoots);

  mkdirSync(archivesRoot, { recursive: true });
  const archives = new Map();
  for (const name of names) {
    archives.set(name, pack(packageRoots.get(name), archivesRoot, `pack ${name}`));
  }
  const clientArchive = pack(clientRoot, archivesRoot, 'pack client', false);
  assertArchiveContains(clientArchive, 'package/dist/bin/jinn.js', 'packed client');
  assertArchiveContains(
    clientArchive,
    'package/dist/daemon/bridge-legacy-delivery.js',
    'packed client',
  );

  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@jinn-network/client': `file:${clientArchive}`,
      ...Object.fromEntries(names.map((name) => [name, `file:${archives.get(name)}`])),
    },
  }, null, 2)}\n`);
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    'install complete packed client closure',
    { cwd: consumerRoot },
  );

  for (const name of ['@jinn-network/client', ...names]) {
    assertInstalledUnderConsumer(name);
  }
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
    'client',
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
    ['ls', '--all', '@jinn-network/client', '@jinn-network/marketplace-pipeline'],
    'inspect packed client dependency graph',
    { cwd: consumerRoot },
  );
  console.log(`smoke-test-hermetic-packed-closure: packed ${names.length} Jinn packages with no source-tree resolution.`);
} finally {
  rmSync(closureRoot, { recursive: true, force: true });
}
