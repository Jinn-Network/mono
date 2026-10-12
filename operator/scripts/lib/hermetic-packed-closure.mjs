import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const STALE_LOCKFILE_MESSAGE =
  'packed-closure lockfile is out of sync; from operator/ run `node scripts/refresh-hermetic-packed-closure-lockfile.mjs`';

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

// Release-age floor for the lockfile refresh (#4897). The refresh re-resolves every
// range against the registry, so without a floor it can bake in a version published
// minutes ago, inside the window in which a compromised or broken release is usually
// caught and yanked. The age and the exceptions are set here and nowhere else.
//
// npm's own `min-release-age` (days) and `min-release-age-exclude` do the work; they
// are documented in `npm help config` for the npm named below. `--before` is the
// older, absolute-date alternative and has no per-package exclusion list.
export const DEFAULT_MIN_RELEASE_AGE_DAYS = 7;
// Package names or minimatch globs exempt from the floor, for example a fix published
// yesterday that must land today. Empty on purpose: add a name here in the same pull
// request that needs it, so the exception is reviewed. First-party `@jinn-network/*`
// packages need no entry; they enter the lockfile as `file:` archives, not from the registry.
export const MIN_RELEASE_AGE_EXCLUDE = Object.freeze([]);
export const MIN_RELEASE_AGE_ENV = 'JINN_HERMETIC_REFRESH_MIN_RELEASE_AGE_DAYS';
// Older npm treats `--min-release-age` as an unknown config: a warning at most, and the
// floor is silently gone. `--min-release-age-exclude` is not known before 11.19.0 either.
export const MIN_REFRESH_NPM_VERSION = '11.19.0';

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

function assertPositiveDays(days) {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw new Error(
      `the release-age floor must be a positive number of days (got ${String(days)}); ` +
        'exempt a package through MIN_RELEASE_AGE_EXCLUDE instead of switching the floor off',
    );
  }
}

export function refreshLockfileArgs({
  minReleaseAgeDays = DEFAULT_MIN_RELEASE_AGE_DAYS,
  exclude = MIN_RELEASE_AGE_EXCLUDE,
} = {}) {
  assertPositiveDays(minReleaseAgeDays);
  return [
    ...REFRESH_LOCKFILE_ARGS,
    `--min-release-age=${minReleaseAgeDays}`,
    // The CLI value replaces any exclusion list from `.npmrc` or the environment, so
    // the exceptions above are the only ones. An empty value still replaces; with no
    // flag at all a developer's own `min-release-age-exclude[]=` would apply silently.
    ...(exclude.length === 0
      ? ['--min-release-age-exclude=']
      : exclude.map((pattern) => `--min-release-age-exclude=${pattern}`)),
  ];
}

/** The same resolve with the floor off, used only to report what the floor held back. */
export function unconstrainedRefreshLockfileArgs() {
  return [...REFRESH_LOCKFILE_ARGS, '--min-release-age=0'];
}

export function minReleaseAgeDaysFromEnv(env) {
  const raw = env?.[MIN_RELEASE_AGE_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_RELEASE_AGE_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(
      `${MIN_RELEASE_AGE_ENV} must be a positive number of days (got "${raw}"); ` +
        `unset it for the default of ${DEFAULT_MIN_RELEASE_AGE_DAYS}`,
    );
  }
  return days;
}

function npmVersionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(version).trim());
  return match ? match.slice(1).map(Number) : null;
}

export function assertNpmSupportsReleaseAge(version) {
  const have = npmVersionParts(version);
  if (have === null) {
    throw new Error(`could not read the npm version from "${String(version).trim()}"`);
  }
  const need = npmVersionParts(MIN_REFRESH_NPM_VERSION);
  const differing = need.findIndex((part, index) => have[index] !== part);
  if (differing !== -1 && have[differing] < need[differing]) {
    throw new Error(
      `the lockfile refresh needs npm ${MIN_REFRESH_NPM_VERSION} or newer (found ${have.join('.')}): ` +
        'an older npm ignores --min-release-age, so the release-age floor would not apply',
    );
  }
}

function registryVersionsByName(lock) {
  const byName = new Map();
  for (const [location, entry] of Object.entries(lock?.packages ?? {})) {
    const marker = location.lastIndexOf('node_modules/');
    if (marker === -1 || typeof entry?.version !== 'string') continue;
    const name = location.slice(marker + 'node_modules/'.length);
    byName.set(name, [...(byName.get(name) ?? []), entry.version]);
  }
  for (const versions of byName.values()) versions.sort();
  return byName;
}

/**
 * Packages whose resolved versions differ between a resolve without the floor and the
 * committed, floored one. npm does not report what the floor held back, so the refresh
 * resolves twice and compares.
 */
export function heldBackPackages(unconstrainedLock, constrainedLock) {
  const unconstrained = registryVersionsByName(unconstrainedLock);
  const constrained = registryVersionsByName(constrainedLock);
  return [...new Set([...unconstrained.keys(), ...constrained.keys()])]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      unconstrained: unconstrained.get(name) ?? [],
      constrained: constrained.get(name) ?? [],
    }))
    .filter(({ unconstrained: before, constrained: after }) => before.join() !== after.join());
}

export function formatHeldBack(held, minReleaseAgeDays) {
  const label = `release-age floor (${minReleaseAgeDays} days)`;
  if (held.length === 0) return `${label} held nothing back`;
  const side = (versions) => (versions.length === 0 ? '(absent)' : versions.join(', '));
  return [
    `${label} held back ${held.length} package${held.length === 1 ? '' : 's'}:`,
    ...held.map(({ name, unconstrained, constrained }) => `  ${name}: ${side(unconstrained)} -> ${side(constrained)}`),
  ].join('\n');
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
  try {
    run('npm', pinnedInstallArgs(), 'install pinned packed-closure graph', {
      cwd: consumerRoot,
    });
  } catch (error) {
    // npm's own advice is to run `npm install`, which is the wrong fix here.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\n${STALE_LOCKFILE_MESSAGE}`, { cause: error });
  }
  // With `--package-lock=false`, npm still counts a package-lock.json on disk
  // as a loaded tree, so it neither reads that file nor loads node_modules: the
  // overlay starts from an empty tree and re-resolves every dependency from the
  // registry. Removing the file makes the overlay start from what `npm ci`
  // installed.
  rmSync(lockfile);
}
