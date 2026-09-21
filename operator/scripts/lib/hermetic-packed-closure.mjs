import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COMPILER_DEV_DEPENDENCY_NAMES = Object.freeze([
  'typescript',
  '@types/node',
  '@types/semver',
  '@types/ws',
]);

const THIRD_PARTY_INSTALL_ARGS = Object.freeze([
  'ci',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]);

const PACKED_OVERLAY_ARGS = Object.freeze([
  'install',
  '--offline',
  '--package-lock=false',
  '--no-save',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]);

const REFRESH_LOCKFILE_ARGS = Object.freeze([
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]);

function sortRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function thirdPartyFromField(manifest, field) {
  const entries = {};
  const source = manifest?.[field];
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return entries;
  for (const [name, specifier] of Object.entries(source)) {
    if (name.startsWith('@jinn-network/')) continue;
    if (typeof specifier !== 'string') continue;
    entries[name] = specifier;
  }
  return entries;
}

export function readPackageJson(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

export function discoverPackageRoots(root, found = new Map()) {
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

export function closurePackageNames(clientManifest, packageRoots) {
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

export function thirdPartyInstallArgs() {
  return [...THIRD_PARTY_INSTALL_ARGS];
}

export function packedOverlayInstallArgs(archives) {
  return [...PACKED_OVERLAY_ARGS, ...archives];
}

export function refreshLockfileArgs() {
  return [...REFRESH_LOCKFILE_ARGS];
}

export function buildConsumerThirdPartyDependencies({ operatorManifest, closureManifests }) {
  const dependencies = {};
  for (const manifest of closureManifests ?? []) {
    Object.assign(dependencies, thirdPartyFromField(manifest, 'dependencies'));
  }
  Object.assign(dependencies, thirdPartyFromField(operatorManifest, 'dependencies'));
  Object.assign(dependencies, thirdPartyFromField(operatorManifest, 'optionalDependencies'));

  const devDependencies = {};
  const operatorDev = operatorManifest?.devDependencies ?? {};
  for (const name of COMPILER_DEV_DEPENDENCY_NAMES) {
    const specifier = operatorDev[name];
    if (typeof specifier === 'string') devDependencies[name] = specifier;
  }

  return {
    dependencies: sortRecord(dependencies),
    devDependencies: sortRecord(devDependencies),
  };
}

export function consumerManifest({ dependencies, devDependencies }) {
  return {
    name: 'jinn-hermetic-packed-closure',
    private: true,
    type: 'module',
    dependencies: sortRecord(dependencies ?? {}),
    devDependencies: sortRecord(devDependencies ?? {}),
  };
}

export function writeConsumerPackageJson(consumerRoot, fields) {
  writeFileSync(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(consumerManifest(fields), null, 2)}\n`,
  );
}

export function fixtureDir(scriptsRoot) {
  return join(scriptsRoot, 'fixtures', 'hermetic-packed-closure');
}

export function fixtureLockfilePath(scriptsRoot) {
  return join(fixtureDir(scriptsRoot), 'package-lock.json');
}

export function assertFixtureLockfilePresent(scriptsRoot) {
  const lockPath = fixtureLockfilePath(scriptsRoot);
  if (!existsSync(lockPath)) {
    throw new Error(
      `Missing packed-closure lockfile at ${lockPath}. Run: node scripts/refresh-hermetic-packed-closure-lockfile.mjs`,
    );
  }
  return lockPath;
}

export function installThirdPartyGraph({ run, consumerRoot, lockfileSource }) {
  cpSync(lockfileSource, join(consumerRoot, 'package-lock.json'));
  run('npm', thirdPartyInstallArgs(), 'install pinned third-party packed-closure graph', {
    cwd: consumerRoot,
  });
}
