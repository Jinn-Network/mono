import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const COMPILER_DEV_DEPENDENCY_NAMES = Object.freeze([
  'typescript',
  '@types/node',
  '@types/semver',
  '@types/ws',
]);

const PINNED_INSTALL_ARGS = Object.freeze([
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

function isFirstPartyPackage(name) {
  return name.startsWith('@jinn-network/');
}

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
    if (isFirstPartyPackage(name)) continue;
    if (typeof specifier !== 'string') continue;
    entries[name] = specifier;
  }
  return entries;
}

export function noLocalSpec(value, context) {
  if (typeof value === 'string' && /^(?:file|portal|workspace):/iu.test(value)) {
    throw new Error(`${context} contains a forbidden local dependency specifier: ${value}`);
  }
}

export function sanitizedManifest(manifest, context, stripDevelopment = true) {
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

export function readPackageJson(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

export function requirePackageRoot(packageRoots, name) {
  const packageRoot = packageRoots.get(name);
  if (packageRoot === undefined) {
    throw new Error(`No local package root is available for ${name}.`);
  }
  return packageRoot;
}

export function discoverPackageRoots(root, found = new Map()) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const entryPath = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    const manifestPath = join(entryPath, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name === 'string' && isFirstPartyPackage(manifest.name)) {
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
    .filter(isFirstPartyPackage);
  const names = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || names.has(name)) continue;
    const packageRoot = requirePackageRoot(packageRoots, name);
    names.add(name);
    const manifest = readPackageJson(packageRoot);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (isFirstPartyPackage(dependency)) pending.push(dependency);
    }
  }
  return [...names].sort();
}

export function packedClosurePackageNames(operatorManifest, packageRoots) {
  return closurePackageNames(
    {
      ...operatorManifest,
      dependencies: {
        ...operatorManifest.dependencies,
        ...Object.fromEntries(
          Object.entries(operatorManifest.devDependencies ?? {})
            .filter(([name]) => isFirstPartyPackage(name)),
        ),
      },
    },
    packageRoots,
  );
}

export function pinnedInstallArgs() {
  return [...PINNED_INSTALL_ARGS];
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

/**
 * Records each packed first-party archive as a `file:` dependency of the
 * consumer, relative to it. The committed lockfile then holds the whole packed
 * closure, including a third-party version a first-party package pins apart
 * from the operator's own range (for example `better-sqlite3@13.0.1` beside the
 * operator's `^12.10.0`). npm nests that version under the first-party package;
 * a third-party-only union cannot express it, and resolving it later would
 * need the registry.
 */
export function firstPartyArchiveDependencies(consumerRoot, archives) {
  const dependencies = {};
  for (const [name, archive] of archives) {
    dependencies[name] = `file:${relative(consumerRoot, archive).split(sep).join('/')}`;
  }
  return sortRecord(dependencies);
}

/**
 * Drops `integrity` from lockfile entries resolved from a local `file:`
 * archive. Those archives are packed from the working tree on every run, so
 * their bytes change with any first-party edit; registry entries keep their
 * integrity and still pin every third-party byte.
 */
export function withoutLocalArchiveIntegrity(lock) {
  const packages = {};
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    packages[location] = { ...entry };
    if (typeof entry?.resolved === 'string' && entry.resolved.startsWith('file:')) {
      delete packages[location].integrity;
    }
  }
  return { ...lock, packages };
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

export function installPinnedGraph({ run, consumerRoot, lockfileSource }) {
  const lockfile = join(consumerRoot, 'package-lock.json');
  cpSync(lockfileSource, lockfile);
  run('npm', pinnedInstallArgs(), 'install pinned packed-closure graph', {
    cwd: consumerRoot,
  });
  // With `--package-lock=false`, npm still counts a package-lock.json on disk
  // as a loaded tree, so it neither reads that file nor loads node_modules: the
  // overlay starts from an empty tree and re-resolves every dependency from the
  // registry. Removing the file makes the overlay start from what `npm ci`
  // installed.
  rmSync(lockfile);
}
