#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { catalogSha256 } from './build-prepublication-bundle.mjs';
import {
  PLATFORM_CATALOG_PATH,
  loadCatalogPackages,
} from './platform-catalog.mjs';

const PUBLIC_DOCUMENT_KINDS = ['schemas', 'profiles', 'fixtures'];
const PUBLIC_DOCUMENT_KIND_PRECEDENCE = ['fixtures', 'schemas', 'profiles'];

const JINN_NETWORK_ORIGIN = 'https://jinn.network/';

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

function walkFiles(directory, prefix, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const child = join(directory, entry.name);
    const id = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(child, id, found);
    else if (entry.isFile()) found.push({ servedPath: id.split(sep).join('/'), absolutePath: child });
  }
  return found;
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

// A document under fixtures/ is test data, not self-identity: fixture bodies legitimately
// reuse `$id`/`profile`-shaped string values as inputs under test (e.g. a fixture that
// exercises task-profile resolution literally contains `"profile": "https://jinn.network/..."`
// as its payload), so fixtures are never eligible for declared-identifier remapping — they
// are always served at their directory-derived path.
function isFixturePath(servedPath) {
  return servedPath.split('/').includes('fixtures');
}

// A JSON Schema document self-identifies with `$id`; a record-discovery facts-projection
// profile document (packages/discovery/facts/*) self-identifies with a top-level `profile`
// field naming itself (design §8.4's "published profile URIs resolve" gate covers both). A
// document that declares neither has no claimed identity to violate, and is served at its
// directory-derived path unchanged.
function declaredIdentifier(servedPath, bytes, fixture) {
  if (fixture || isFixturePath(servedPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  for (const field of ['$id', 'profile']) {
    const value = parsed[field];
    if (typeof value === 'string' && value.startsWith(JINN_NETWORK_ORIGIN)) {
      return value.slice(JINN_NETWORK_ORIGIN.length);
    }
  }
  return null;
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
  const claims = new Map();
  const documents = [];
  for (const pkg of packages) {
    const visitedSources = new Set();
    const declaredRoots = new Map(PUBLIC_DOCUMENT_KINDS.map((kind) => [
      kind,
      pkg.catalog.publicSurface[kind].map((source) => join(repoRoot, pkg.directory, source)),
    ]));
    const effectiveKindFor = (absolutePath) => PUBLIC_DOCUMENT_KIND_PRECEDENCE.find(
      (kind) => declaredRoots.get(kind).some((root) => inside(absolutePath, root)),
    );
    for (const kind of PUBLIC_DOCUMENT_KINDS) {
      for (const source of pkg.catalog.publicSurface[kind]) {
        const absolute = join(repoRoot, pkg.directory, source);
        if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
          throw new Error(`${pkg.name} declares missing publicSurface.${kind} path ${source}`);
        }
        for (const file of walkFiles(absolute, source, [])) {
          if (visitedSources.has(file.absolutePath)) continue;
          visitedSources.add(file.absolutePath);
          // A `.sha256` sidecar (e.g. profile.sha256 next to profile.json) is not itself
          // a self-identifying document -- it names no $id/profile of its own. Its sibling
          // document can be served at a declared-identifier path that differs from its
          // on-disk directory (see declaredIdentifier below), which would otherwise strand
          // the sidecar under the old directory-derived path while the document it digests
          // moves elsewhere -- a verifier resolving the document and reaching for the
          // conventional adjacent .sha256 would 404. manifest.json's per-document sha256
          // field is the digest surface for every served document, sidecar or not, so the
          // sidecar file itself is simply not part of the served profile root.
          if (file.servedPath.endsWith('.sha256')) continue;
          const bytes = readFileSync(file.absolutePath);
          const effectiveKind = effectiveKindFor(file.absolutePath) ?? kind;
          const fixture = effectiveKind === 'fixtures';
          const fallbackPath = fixture
            ? `${pkg.name}/${file.servedPath}`
            : file.servedPath;
          const servedPath = declaredIdentifier(file.servedPath, bytes, fixture) ?? fallbackPath;
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
            mediaType: mediaTypeFor(file.servedPath),
            sourcePackage: pkg.name,
          });
          const target = join(outDir, ...servedPath.split('/'));
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(file.absolutePath, target);
        }
      }
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
