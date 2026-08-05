#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { catalogSha256 } from './build-prepublication-bundle.mjs';
import {
  PLATFORM_CATALOG_PATH,
  loadCatalogPackages,
  loadPlatformCatalog,
} from './platform-catalog.mjs';
import { enumeratePublicSurfaceAssets, jinnIdentifierServedPath } from './public-surface-assets.mjs';

const MEDIA_TYPES = new Map([
  ['.schema.json', 'application/schema+json'],
  ['.jsonld', 'application/ld+json'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.txt', 'text/plain'],
]);

function mediaTypeFor(path) {
  for (const [suffix, mediaType] of MEDIA_TYPES) {
    if (path.endsWith(suffix)) return mediaType;
  }
  return 'application/octet-stream';
}

// A served path can be a document or a directory prefix, never both: no host can
// serve bytes at a URL that is also a directory. Without this the build fails later
// at copyFileSync with an opaque ENOTDIR, and only because the output tree happens to
// be empty when the collision is reached.
function assertNoPrefixCollision(documents) {
  const paths = new Set(documents.map(({ path }) => path));
  for (const path of paths) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join('/');
      if (paths.has(ancestor)) {
        throw new Error(`${ancestor} is both a document and a directory prefix of ${path}`);
      }
    }
  }
}

// Most https://spec.jinn.network/ URIs in the tree are names, not locators -- discriminator
// values that no one fetches. The register declares the ones that must dereference, so
// "does this URI resolve" is a checked claim rather than an argument. Entries owned by
// packages outside the release group under build are another group's concern.
function assertRegisteredIdentifiersResolve(catalog, documents, packageNames) {
  const paths = new Set(documents.map(({ path }) => path));
  for (const entry of catalog.resolvableIdentifiers ?? []) {
    if (!packageNames.has(entry.owner)) continue;
    const servedPath = jinnIdentifierServedPath(
      entry.identifier,
      `resolvableIdentifiers ${entry.identifier}`,
    );
    if (servedPath !== entry.entryPoint && entry.resolution === 'document') {
      throw new Error(
        `${entry.identifier} is registered as a document but its entry point ${entry.entryPoint} is not its served path ${servedPath}`,
      );
    }
    if (!paths.has(entry.entryPoint)) {
      throw new Error(`${entry.identifier} resolves to no served document at ${entry.entryPoint}`);
    }
    if (entry.resolution === 'prefix' && paths.has(servedPath)) {
      throw new Error(`${entry.identifier} is registered as a prefix but a document is served at it`);
    }
  }
}

function isStrictlyInside(child, parent) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function prepareOutputRoot(outDir) {
  const outputRoot = resolve(outDir);
  let stat = lstatIfPresent(outputRoot);
  if (!stat) {
    mkdirSync(outputRoot, { recursive: true });
    stat = lstatSync(outputRoot);
  }
  if (stat.isSymbolicLink()) throw new Error(`output root must not be a symbolic link: ${outDir}`);
  if (!stat.isDirectory()) throw new Error(`output root must be a real directory: ${outDir}`);
  return realpathSync(outputRoot);
}

function preflightOutputTarget(outputRoot, servedPath) {
  const target = resolve(outputRoot, ...servedPath.split('/'));
  if (!isStrictlyInside(target, outputRoot)) {
    throw new Error(`output target must remain strictly inside the output root: ${servedPath}`);
  }

  const segments = servedPath.split('/');
  let current = outputRoot;
  for (const [index, segment] of segments.slice(0, -1).entries()) {
    current = join(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    const partial = segments.slice(0, index + 1).join('/');
    if (stat.isSymbolicLink()) {
      throw new Error(`output path ${partial} contains a symbolic link`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`output path ${partial} must be a real directory`);
    }
    if (!isStrictlyInside(realpathSync(current), outputRoot)) {
      throw new Error(`output path ${partial} escapes the output root`);
    }
  }

  const targetStat = lstatIfPresent(target);
  if (targetStat) {
    if (targetStat.isSymbolicLink()) throw new Error(`output target ${servedPath} is a symbolic link`);
    if (!targetStat.isFile()) throw new Error(`output target ${servedPath} must be a regular file`);
  }
  return target;
}

export function buildProfileRoot({
  repoRoot,
  outDir,
  commit,
  catalogDigest,
  releaseGroup = 'platform-v1',
  lane = 'canary',
}) {
  if (!/^[0-9a-f]{40}$/u.test(String(commit))) {
    throw new Error('commit must be a 40-character lowercase commit SHA');
  }
  if (lane !== 'canary' && lane !== 'stable') {
    throw new Error(`lane must be canary or stable, got ${lane ?? '<missing>'}`);
  }
  const actualCatalogDigest = catalogSha256(repoRoot);
  const boundCatalogDigest = catalogDigest ?? actualCatalogDigest;
  if (boundCatalogDigest !== actualCatalogDigest) {
    throw new Error(
      `catalog digest mismatch: expected ${boundCatalogDigest}, checked out catalog is ${actualCatalogDigest}`,
    );
  }
  const packages = loadCatalogPackages(repoRoot, { releaseGroup });
  if (packages.length === 0) throw new Error(`release group ${releaseGroup} contains no catalog packages`);
  const publicAssets = enumeratePublicSurfaceAssets({
    repoRoot,
    packages,
    validateUniqueClaims: false,
  });
  const outputRoot = prepareOutputRoot(outDir);
  const claims = new Map();
  const documents = [];
  const copies = [];
  for (const pkg of packages) {
    for (const asset of publicAssets.filter((entry) => (
      entry.package === pkg.name && entry.kind !== 'conformance'
    ))) {
      const absolutePath = join(repoRoot, pkg.directory, asset.relativeSource);
      // A `.sha256` sidecar (e.g. profile.sha256 next to profile.json) is not itself
      // a self-identifying document -- it names no $id/profile of its own. Its sibling
      // document can be served at a declared-identifier path that differs from its
      // on-disk directory, which would otherwise strand
      // the sidecar under the old directory-derived path while the document it digests
      // moves elsewhere -- a verifier resolving the document and reaching for the
      // conventional adjacent .sha256 would 404. manifest.json's per-document sha256
      // field is the digest surface for every served document, sidecar or not, so the
      // sidecar file itself is simply not part of the served profile root.
      if (asset.relativeSource.endsWith('.sha256')) continue;
      const bytes = readFileSync(absolutePath);
      const fixture = asset.kind === 'fixtures';
      const fallbackPath = fixture
        ? `${pkg.name}/${asset.relativeSource}`
        : asset.relativeSource;
      const servedPath = asset.claim?.servedPath ?? fallbackPath;
      const claimed = claims.get(servedPath);
      if (claimed) {
        if (claimed !== pkg.name) {
          throw new Error(`${servedPath} is claimed by both ${claimed} and ${pkg.name}`);
        }
        throw new Error(`${servedPath} is claimed more than once by ${pkg.name}`);
      }
      claims.set(servedPath, pkg.name);
      documents.push({
        path: servedPath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: mediaTypeFor(asset.relativeSource),
        sourcePackage: pkg.name,
      });
      copies.push({ absolutePath, servedPath });
    }
  }
  documents.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  assertNoPrefixCollision(documents);
  assertRegisteredIdentifiersResolve(
    loadPlatformCatalog(repoRoot),
    documents,
    new Set(packages.map(({ name }) => name)),
  );
  const manifest = {
    version: 1,
    generatedFrom: { repository: 'Jinn-Network/mono', commit },
    catalog: { path: PLATFORM_CATALOG_PATH, sha256: boundCatalogDigest },
    releaseGroup,
    lane,
    packages: packages.map(({ name }) => name),
    documents,
  };
  const preparedCopies = copies.map(({ absolutePath, servedPath }) => ({
    absolutePath,
    target: preflightOutputTarget(outputRoot, servedPath),
  }));
  const manifestTarget = preflightOutputTarget(outputRoot, 'manifest.json');
  for (const { absolutePath, target } of preparedCopies) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(absolutePath, target);
  }
  writeFileSync(manifestTarget, manifestBytes(manifest), 'utf8');
  return manifest;
}

export function manifestBytes(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const outDir = args[args.indexOf('--out') + 1];
    const commit = args[args.indexOf('--commit') + 1];
    const repoRoot = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    const releaseGroup = args.includes('--release-group')
      ? args[args.indexOf('--release-group') + 1]
      : 'platform-v1';
    const catalogDigest = args.includes('--catalog-digest')
      ? args[args.indexOf('--catalog-digest') + 1]
      : undefined;
    const lane = args.includes('--lane') ? args[args.indexOf('--lane') + 1] : 'canary';
    if (!args.includes('--out') || !outDir) throw new Error('--out <directory> is required');
    if (!args.includes('--commit') || !/^[0-9a-f]{40}$/u.test(String(commit))) {
      throw new Error('--commit <40-character sha> is required');
    }
    if (!releaseGroup) throw new Error('--release-group <catalog release group> requires a value');
    if (args.includes('--catalog-digest') && !catalogDigest) {
      throw new Error('--catalog-digest <sha256> requires a value');
    }
    if (!lane) throw new Error('--lane <canary|stable> requires a value');
    const manifest = buildProfileRoot({
      repoRoot,
      outDir,
      commit,
      catalogDigest,
      releaseGroup,
      lane,
    });
    console.log(`wrote ${manifest.documents.length} profile documents and manifest.json to ${outDir}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
