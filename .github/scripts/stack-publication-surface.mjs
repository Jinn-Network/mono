import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import {
  loadCatalogPackages,
  loadPlatformCatalog,
  loadStackPublishedCatalogPackages,
  resolveRequestedReleaseGroup,
} from './platform-catalog.mjs';
import { enumeratePublicSurfaceAssets } from './public-surface-assets.mjs';

const PUBLICATION_KINDS = ['schemas', 'profiles', 'fixtures'];
const DIRECTORY_KIND = new Map([
  ['schemas', 'schemas'],
  ['profile', 'profiles'],
  ['profiles', 'profiles'],
  ['fixtures', 'fixtures'],
]);

function normalizePath(path) {
  return path.replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '');
}

function flattenedStrings(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flattenedStrings);
}

function pathIsCovered(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function exportReachesPath(path, targets) {
  return targets.some((target) => {
    const root = normalizePath(target).replace(/\/\*$/u, '');
    return root === path || root.startsWith(`${path}/`) || path.startsWith(`${root}/`);
  });
}

function packedPublicationDirectories(repoRoot, pkg, packedRoots) {
  const packageRoot = join(repoRoot, pkg.directory);
  const found = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const child = join(directory, entry.name);
      const kind = DIRECTORY_KIND.get(basename(child));
      if (kind) {
        found.push({
          kind,
          path: relative(packageRoot, child).split(sep).join('/'),
        });
      }
      walk(child);
    }
  }
  for (const root of packedRoots) {
    if (root === 'dist' || root.startsWith('dist/')) continue;
    const absolute = join(packageRoot, root);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      const kind = DIRECTORY_KIND.get(basename(absolute));
      if (kind) found.push({ kind, path: root });
      walk(absolute);
    }
  }
  return [...new Map(found.map((entry) => [`${entry.kind}:${entry.path}`, entry])).values()];
}

export function publicationSurfaceViolations(repoRoot, { releaseGroup } = {}) {
  const violations = [];
  const catalog = loadPlatformCatalog(repoRoot);
  const packages = releaseGroup === undefined
    ? loadStackPublishedCatalogPackages(repoRoot)
    : loadCatalogPackages(repoRoot, {
      releaseGroup: resolveRequestedReleaseGroup(catalog, releaseGroup),
    });
  const canEnumerate = packages.every((pkg) => (
    PUBLICATION_KINDS.every((kind) => pkg.catalog.publicSurface[kind].every((path) => {
      const absolute = join(repoRoot, pkg.directory, normalizePath(path));
      return existsSync(absolute) && statSync(absolute).isDirectory();
    }))
      && pkg.catalog.publicSurface.conformance.every((key) => Object.hasOwn(pkg.manifest.exports ?? {}, key))
  ));
  if (canEnumerate) {
    try {
      enumeratePublicSurfaceAssets({ repoRoot, packages });
    } catch (error) {
      violations.push(error.message);
    }
  }
  for (const pkg of packages) {
    const hasExplicitFiles = Array.isArray(pkg.manifest.files);
    if (!hasExplicitFiles) {
      violations.push(`${pkg.directory}: package.json must declare an explicit "files" allowlist`);
    }
    const packedRoots = (hasExplicitFiles ? pkg.manifest.files : []).map(normalizePath).filter(Boolean);
    const exportKeys = new Set(Object.keys(pkg.manifest.exports ?? {}));
    const exportTargets = flattenedStrings(pkg.manifest.exports ?? {});
    const surface = pkg.catalog.publicSurface;

    for (const kind of PUBLICATION_KINDS) {
      for (const declared of surface[kind]) {
        const path = normalizePath(declared);
        const absolute = join(repoRoot, pkg.directory, path);
        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
          violations.push(`${pkg.directory}: publicSurface.${kind} path ${path} does not exist`);
        }
        if (!pathIsCovered(path, packedRoots)) {
          violations.push(`${pkg.directory}: publicSurface.${kind} path ${path} is absent from "files"`);
        } else if (!exportReachesPath(path, exportTargets)) {
          violations.push(`${pkg.directory}: publicSurface.${kind} path ${path} has no reachable export target`);
        }
      }
    }

    for (const { kind, path } of packedPublicationDirectories(repoRoot, pkg, packedRoots)) {
      const declarations = surface[kind].map(normalizePath);
      if (!pathIsCovered(path, declarations)) {
        const label = kind === 'schemas' ? 'schema' : kind === 'profiles' ? 'profile' : 'fixture';
        violations.push(`${pkg.directory}: packed ${label} path ${path} is undeclared`);
      }
    }

    for (const conformance of surface.conformance) {
      if (!exportKeys.has(conformance)) {
        violations.push(`${pkg.directory}: conformance subpath ${conformance} is absent from "exports"`);
      }
    }
  }
  return violations.sort();
}
