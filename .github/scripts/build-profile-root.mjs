#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { catalogSha256 } from './build-prepublication-bundle.mjs';
import {
  PLATFORM_CATALOG_PATH,
  loadCatalogPackages,
} from './platform-catalog.mjs';
import { enumeratePublicSurfaceAssets } from './public-surface-assets.mjs';

const MEDIA_TYPES = new Map([
  ['.schema.json', 'application/schema+json'],
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
  const claims = new Map();
  const documents = [];
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
      const target = join(outDir, ...servedPath.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(absolutePath, target);
    }
  }
  documents.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest = {
    version: 1,
    generatedFrom: { repository: 'Jinn-Network/mono', commit },
    catalog: { path: PLATFORM_CATALOG_PATH, sha256: boundCatalogDigest },
    releaseGroup,
    lane,
    packages: packages.map(({ name }) => name),
    documents,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), manifestBytes(manifest), 'utf8');
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
