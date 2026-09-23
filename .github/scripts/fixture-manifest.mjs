#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { loadStackPublishedCatalogPackages } from './platform-catalog.mjs';

export const FIXTURE_MANIFEST_NAME = 'manifest.sha256.json';

export class FixtureEntryTypeError extends Error {
  constructor(id) {
    super(`fixture ${id} is neither a regular file nor a directory; refusing to pin it`);
    this.name = 'FixtureEntryTypeError';
  }
}

// The one walk of a fixture tree: this checker and the golden-fixture writers all call
// it, so what gets pinned and what gets checked cannot diverge (#3920).
function walk(directory, prefix, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // Installed dependencies are never fixtures.
    if (entry.name === 'node_modules') continue;
    // Machine-local Finder junk: its bytes vary per machine, so pinning it would freeze
    // bytes nobody can reproduce and report drift on every other macOS checkout.
    if (entry.name === '.DS_Store') continue;
    // Only the root manifest is this file; one nested deeper is an ordinary fixture.
    if (prefix === '' && entry.name === FIXTURE_MANIFEST_NAME) continue;
    const child = join(directory, entry.name);
    const id = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(child, id, found);
    else if (entry.isFile()) found.push({ id, path: child });
    // A symlink or other special entry is refused rather than skipped: a silent skip
    // lets a fixture escape the pinned set, the failure this guard exists to prevent.
    else throw new FixtureEntryTypeError(id);
  }
  return found;
}

export function buildFixtureManifest(packageRoot) {
  const fixturesRoot = join(packageRoot, 'fixtures');
  if (!existsSync(fixturesRoot) || !statSync(fixturesRoot).isDirectory()) return null;
  const entries = walk(fixturesRoot, '', [])
    .map(({ id, path }) => ({ id: id.split(sep).join('/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { version: 1, entries, errata: [] };
}

export function readFixtureManifest(packageRoot) {
  const path = join(packageRoot, 'fixtures', FIXTURE_MANIFEST_NAME);
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return { version: manifest.version ?? 1, entries: manifest.entries ?? [], errata: manifest.errata ?? [] };
}

export function writeFixtureManifest(packageRoot, manifest) {
  writeFileSync(
    join(packageRoot, 'fixtures', FIXTURE_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

// Rebuilds the manifest from the tree, keeping the stored hand-authored errata. Returns
// the written manifest, or null when the package has no fixtures directory.
export function rewriteFixtureManifest(packageRoot) {
  const built = buildFixtureManifest(packageRoot);
  if (built === null) return null;
  const manifest = { ...built, errata: readFixtureManifest(packageRoot)?.errata ?? [] };
  writeFixtureManifest(packageRoot, manifest);
  return manifest;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    const write = args.includes('--write');
    if (!write && !args.includes('--check')) throw new Error('pass --write or --check');
    const drift = [];
    for (const pkg of loadStackPublishedCatalogPackages(root)) {
      const packageRoot = join(root, pkg.directory);
      if (write) {
        rewriteFixtureManifest(packageRoot);
        continue;
      }
      const built = buildFixtureManifest(packageRoot);
      if (built === null) continue;
      const stored = readFixtureManifest(packageRoot);
      if (stored === null || JSON.stringify(stored.entries) !== JSON.stringify(built.entries)) {
        drift.push(`${pkg.directory}/fixtures/${FIXTURE_MANIFEST_NAME}`);
      }
    }
    if (drift.length > 0) {
      throw new Error(`stale or missing fixture manifests; run --write:\n  ${drift.join('\n  ')}`);
    }
    console.log(write ? 'fixture manifests written' : 'fixture manifests are current');
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
