#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalJsonBytes,
  catalogSha256,
} from './build-prepublication-bundle.mjs';
import {
  PLATFORM_CATALOG_PATH,
  loadCatalogPackages,
  loadPlatformCatalog,
  resolveRequestedReleaseGroup,
} from './platform-catalog.mjs';
import { publicationSurfaceViolations } from './stack-publication-surface.mjs';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;

export function buildPlatformPublicSurface({
  repoRoot,
  outputPath,
  sourceSha,
  catalogDigest,
  releaseGroup,
  lane,
}) {
  const root = resolve(repoRoot);
  if (!COMMIT_SHA.test(String(sourceSha))) {
    throw new Error('sourceSha must be a 40-character lowercase commit SHA');
  }
  const actualDigest = catalogSha256(root);
  if (catalogDigest !== actualDigest) {
    throw new Error(`catalog digest mismatch: expected ${catalogDigest}, checked out catalog is ${actualDigest}`);
  }
  releaseGroup = resolveRequestedReleaseGroup(loadPlatformCatalog(root), releaseGroup);
  if (lane !== 'canary' && lane !== 'stable') {
    throw new Error(`lane must be canary or stable, got ${lane ?? '<missing>'}`);
  }
  const violations = publicationSurfaceViolations(root, { releaseGroup });
  if (violations.length > 0) {
    throw new Error(`public surface validation failed: ${violations.join('; ')}`);
  }
  const packages = loadCatalogPackages(root, { releaseGroup }).map(({ name, directory, catalog }) => ({
    name,
    path: directory,
    publicSurface: catalog.publicSurface,
  }));
  const manifest = {
    schemaVersion: 1,
    sourceSha,
    catalog: { path: PLATFORM_CATALOG_PATH, sha256: catalogDigest },
    releaseGroup,
    lane,
    packages,
  };
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), canonicalJsonBytes(manifest), 'utf8');
  return manifest;
}

function parseArgs(argv) {
  const parsed = { repoRoot: process.cwd() };
  const fields = new Map([
    ['--root', 'repoRoot'],
    ['--out', 'outputPath'],
    ['--source-sha', 'sourceSha'],
    ['--catalog-digest', 'catalogDigest'],
    ['--release-group', 'releaseGroup'],
    ['--lane', 'lane'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const field = fields.get(flag);
    if (!field) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    parsed[field] = value;
    index += 1;
  }
  for (const [field, flag] of [
    ['outputPath', '--out'],
    ['sourceSha', '--source-sha'],
    ['catalogDigest', '--catalog-digest'],
    ['lane', '--lane'],
  ]) {
    if (!parsed[field]) throw new Error(`${flag} is required`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = buildPlatformPublicSurface(parseArgs(process.argv.slice(2)));
    console.log(`wrote public surface manifest for ${manifest.packages.length} packages`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
