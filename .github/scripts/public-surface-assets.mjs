import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';

import { repositoryCandidateInventory } from './repository-candidates.mjs';

const PUBLIC_DOCUMENT_KIND_PRECEDENCE = ['fixtures', 'schemas', 'profiles'];
const JINN_NETWORK_ORIGIN = 'https://jinn.network/';

function toPosix(value) {
  return value.split(sep).join('/');
}

function isInside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function normalizePackageRelativePublicPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a normalized package-relative path`);
  }
  const segments = value.split('/');
  if (value.includes('\\')
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a normalized package-relative path`);
  }
  return value;
}

function normalizeManifestPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\\')) {
    throw new Error(`${label} must be a normalized package-relative manifest path`);
  }
  const clean = value.replace(/^\.\//u, '');
  const segments = clean.split('/');
  if (clean === ''
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a normalized package-relative manifest path`);
  }
  return clean;
}

function assertNoSymlinkPath(base, relativePath, label) {
  let current = base;
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error(`${label} path does not exist: ${relativePath}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} path ${relativePath} contains a symlink`);
  }
  return current;
}

function safePackageRoot(repoRoot, pkg) {
  const root = resolve(repoRoot);
  const rootReal = realpathSync(root);
  const packagePath = normalizePackageRelativePublicPath(pkg.directory, `${pkg.name}.path`);
  const absolute = assertNoSymlinkPath(root, packagePath, `${pkg.name} package`);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory()) throw new Error(`${pkg.name} package path must be a real directory: ${packagePath}`);
  const packageReal = realpathSync(absolute);
  if (!isInside(packageReal, rootReal)) {
    throw new Error(`${pkg.name} package path escapes the repository: ${packagePath}`);
  }
  return { absolute, packageReal, rootReal };
}

function walkRealFiles({
  directory,
  inventory,
  label,
  packageDirectory,
  packageReal,
  rootReal,
  relativePrefix,
}, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const relativeSource = `${relativePrefix}/${entry.name}`;
    const repositoryPath = `${packageDirectory}/${toPosix(relativeSource)}`;
    if (!inventory.fileSet.has(repositoryPath) && !inventory.directories.has(repositoryPath)) continue;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} path ${relativeSource} contains a symlink`);
    }
    const real = realpathSync(absolute);
    if (!isInside(real, packageReal) || !isInside(real, rootReal)) {
      throw new Error(`${label} path ${relativeSource} escapes its package or repository`);
    }
    if (stat.isDirectory()) {
      walkRealFiles({
        directory: absolute,
        inventory,
        label,
        packageDirectory,
        packageReal,
        rootReal,
        relativePrefix: relativeSource,
      }, found);
    } else if (stat.isFile()) {
      found.push({ absolutePath: absolute, relativeSource: toPosix(relativeSource) });
    } else {
      throw new Error(`${label} path ${relativeSource} must be a regular file or directory`);
    }
  }
  return found;
}

function declaredClaim(asset, bytes) {
  if (asset.kind === 'fixtures'
    || asset.relativeSource.split('/').includes('fixtures')
    || !asset.relativeSource.endsWith('.json')) return null;
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `${asset.package}: malformed catalog-declared publicSurface.${asset.kind} JSON ${asset.relativeSource}: ${error.message}`,
    );
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  const claims = [];
  for (const field of ['$id', 'profile']) {
    const identifier = document[field];
    if (typeof identifier === 'string' && identifier.startsWith(JINN_NETWORK_ORIGIN)) {
      claims.push({
        field,
        identifier,
        servedPath: identifier.slice(JINN_NETWORK_ORIGIN.length),
      });
    }
  }
  if (claims.length > 1) {
    throw new Error(
      `${asset.package}: ${asset.relativeSource} declares multiple public self-identifying claims: ${claims.map(({ field, identifier }) => `${field}=${identifier}`).join(', ')}`,
    );
  }
  return claims[0] ?? null;
}

function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  return [];
}

function sourceCandidates(target) {
  if (!target.startsWith('./dist/')) return [target];
  const stem = target.slice('./dist/'.length).replace(/\.(?:d\.ts|js)$/u, '');
  return [
    `./src/${stem}.ts`,
    `./src/${stem}.tsx`,
    `./src/${stem}/index.ts`,
    `./src/${stem}/index.tsx`,
  ];
}

function conformanceAssets(repoRoot, pkg, exportKey, inventory) {
  const definition = pkg.manifest.exports?.[exportKey];
  if (definition === undefined) {
    throw new Error(`${pkg.name}: conformance export ${exportKey} is not declared in package.json exports`);
  }
  const packedTargets = [...new Set(exportTargets(definition))].sort();
  if (packedTargets.length === 0) {
    throw new Error(`${pkg.name}: conformance export ${exportKey} has no packed targets`);
  }
  const { absolute: packageRoot, packageReal, rootReal } = safePackageRoot(repoRoot, pkg);
  const bySource = new Map();
  for (const target of packedTargets) {
    normalizeManifestPath(target, `${pkg.name}: conformance target ${target}`);
    const existing = sourceCandidates(target).find((candidate) => {
      const relativeSource = normalizeManifestPath(
        candidate,
        `${pkg.name}: conformance source for ${target}`,
      );
      if (!inventory.fileSet.has(`${pkg.directory}/${relativeSource}`)) return false;
      const absolute = resolve(packageRoot, ...relativeSource.split('/'));
      if (!existsSync(absolute)) return false;
      assertNoSymlinkPath(packageRoot, relativeSource, `${pkg.name}: conformance source`);
      const stat = lstatSync(absolute);
      return stat.isFile();
    });
    if (!existing) throw new Error(`${pkg.name}: conformance target ${target} has no first-party source`);
    const relativeSource = normalizeManifestPath(existing, `${pkg.name}: conformance source`);
    const absolute = resolve(packageRoot, ...relativeSource.split('/'));
    const real = realpathSync(absolute);
    if (!isInside(real, packageReal) || !isInside(real, rootReal)) {
      throw new Error(`${pkg.name}: conformance source ${relativeSource} escapes its package or repository`);
    }
    const targets = bySource.get(relativeSource) ?? [];
    targets.push(target);
    bySource.set(relativeSource, targets);
  }
  return [...bySource.entries()].map(([relativeSource, targets]) => ({
    claim: null,
    export: exportKey,
    kind: 'conformance',
    package: pkg.name,
    packedTargets: [...new Set(targets)].sort(),
    path: `${pkg.directory}/${relativeSource}`,
    relativeSource,
  }));
}

export function resolveConformanceSources(repoRoot, pkg, manifest, exportKey) {
  const inventory = repositoryCandidateInventory(repoRoot);
  const assets = conformanceAssets(repoRoot, {
    name: pkg.name,
    directory: pkg.directory ?? pkg.path,
    manifest,
  }, exportKey, inventory);
  return {
    packedTargets: [...new Set(assets.flatMap(({ packedTargets }) => packedTargets))].sort(),
    sources: assets.map(({ relativeSource }) => `./${relativeSource}`).sort(),
  };
}

function staticAssets(repoRoot, pkg, inventory) {
  const { absolute: packageRoot, packageReal, rootReal: repositoryReal } = safePackageRoot(repoRoot, pkg);
  const byPath = new Map();
  for (const kind of PUBLIC_DOCUMENT_KIND_PRECEDENCE) {
    for (const [index, declared] of pkg.catalog.publicSurface[kind].entries()) {
      const label = `${pkg.name}.publicSurface.${kind}[${index}]`;
      const root = normalizePackageRelativePublicPath(declared, label);
      const absoluteRoot = assertNoSymlinkPath(packageRoot, root, `${pkg.name} publicSurface.${kind}`);
      const stat = lstatSync(absoluteRoot);
      if (!stat.isDirectory()) {
        throw new Error(`${pkg.name} declares missing publicSurface.${kind} path ${root}`);
      }
      const publicRootReal = realpathSync(absoluteRoot);
      if (!isInside(publicRootReal, packageReal) || !isInside(publicRootReal, repositoryReal)) {
        throw new Error(`${pkg.name} publicSurface.${kind} path ${root} escapes its package or repository`);
      }
      for (const file of walkRealFiles({
        directory: absoluteRoot,
        inventory,
        label: `${pkg.name} publicSurface.${kind}`,
        packageDirectory: pkg.directory,
        packageReal,
        rootReal: repositoryReal,
        relativePrefix: root,
      }, [])) {
        if (byPath.has(file.relativeSource)) continue;
        const base = {
          claim: null,
          export: null,
          kind,
          package: pkg.name,
          packedTargets: [],
          path: `${pkg.directory}/${file.relativeSource}`,
          relativeSource: file.relativeSource,
        };
        base.claim = declaredClaim(base, readFileSync(file.absolutePath));
        byPath.set(file.relativeSource, base);
      }
    }
  }
  return [...byPath.values()];
}

export function enumeratePublicSurfaceAssets({
  repoRoot,
  packages,
  validateUniqueClaims = true,
  candidateFiles,
}) {
  const inventory = repositoryCandidateInventory(repoRoot, { candidateFiles });
  const assets = [];
  const claims = new Map();
  for (const pkg of packages) {
    for (const asset of staticAssets(repoRoot, pkg, inventory)) {
      if (validateUniqueClaims && asset.claim) {
        const existing = claims.get(asset.claim.identifier);
        if (existing) {
          throw new Error(
            `duplicate public self-identifying claim ${asset.claim.identifier}: ${existing} and ${asset.path}`,
          );
        }
        claims.set(asset.claim.identifier, asset.path);
      }
      assets.push(asset);
    }
    for (const exportKey of pkg.catalog.publicSurface.conformance) {
      assets.push(...conformanceAssets(repoRoot, pkg, exportKey, inventory));
    }
  }
  return assets.sort((left, right) => (
    left.path.localeCompare(right.path)
      || left.kind.localeCompare(right.kind)
      || String(left.export).localeCompare(String(right.export))
  ));
}
