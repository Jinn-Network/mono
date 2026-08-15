#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';

export const FIXTURE_MANIFEST_NAME = 'manifest.sha256.json';

function walk(directory, prefix, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === 'node_modules') continue;
    const child = join(directory, entry.name);
    const id = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(child, id, found);
    else if (entry.isFile() && id !== FIXTURE_MANIFEST_NAME) found.push({ id, path: child });
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

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    const write = args.includes('--write');
    if (!write && !args.includes('--check')) throw new Error('pass --write or --check');
    const drift = [];
    for (const pkg of discoverStackPackages(root)) {
      const packageRoot = join(root, pkg.directory);
      const built = buildFixtureManifest(packageRoot);
      if (built === null) continue;
      const stored = readFixtureManifest(packageRoot);
      const next = { ...built, errata: stored?.errata ?? [] };
      if (write) {
        writeFixtureManifest(packageRoot, next);
      } else if (stored === null || JSON.stringify(stored.entries) !== JSON.stringify(next.entries)) {
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
