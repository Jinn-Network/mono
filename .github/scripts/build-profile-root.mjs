#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';

// Deliberately excludes a bare top-level 'schemas': the two packages that pack one
// (task-execution-protocol, benchmarking-records) declare no $id on any document inside
// it, so there is no https://jinn.network/... identity to serve it at. Nesting a
// `schemas/` directory under `profiles/` or `profile/` (as evidence-protocol and
// evidence-repository-oci do) is still walked, because that recursion happens through
// PROFILE_SOURCE_DIRECTORIES' 'profiles'/'profile' entries below.
export const PROFILE_SOURCE_DIRECTORIES = ['profiles', 'profile'];

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
function declaredIdentifier(servedPath, bytes) {
  if (isFixturePath(servedPath)) return null;
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

export function buildProfileRoot({ repoRoot, outDir, commit }) {
  const claims = new Map();
  const documents = [];
  for (const pkg of discoverStackPackages(repoRoot)) {
    const packed = new Set((pkg.manifest.files ?? []).map((entry) => entry.replace(/\/$/, '')));
    for (const source of PROFILE_SOURCE_DIRECTORIES) {
      if (!packed.has(source)) continue;
      const absolute = join(repoRoot, pkg.directory, source);
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue;
      for (const file of walkFiles(absolute, source, [])) {
        const bytes = readFileSync(file.absolutePath);
        const servedPath = declaredIdentifier(file.servedPath, bytes) ?? file.servedPath;
        const claimed = claims.get(servedPath);
        if (claimed && claimed !== pkg.name) {
          throw new Error(`${servedPath} is claimed by both ${claimed} and ${pkg.name}`);
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
  documents.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest = {
    version: 1,
    generatedFrom: { repository: 'Jinn-Network/mono', commit },
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
    if (!args.includes('--out') || !outDir) throw new Error('--out <directory> is required');
    if (!args.includes('--commit') || !/^[0-9a-f]{40}$/u.test(String(commit))) {
      throw new Error('--commit <40-character sha> is required');
    }
    const manifest = buildProfileRoot({ repoRoot, outDir, commit });
    console.log(`wrote ${manifest.documents.length} profile documents and manifest.json to ${outDir}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
