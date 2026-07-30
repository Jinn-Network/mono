#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';

export const PROFILE_SOURCE_DIRECTORIES = ['profiles', 'profile', 'schemas'];

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
        const claimed = claims.get(file.servedPath);
        if (claimed && claimed !== pkg.name) {
          throw new Error(`${file.servedPath} is claimed by both ${claimed} and ${pkg.name}`);
        }
        claims.set(file.servedPath, pkg.name);
        const bytes = readFileSync(file.absolutePath);
        documents.push({
          path: file.servedPath,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mediaType: mediaTypeFor(file.servedPath),
          sourcePackage: pkg.name,
        });
        const target = join(outDir, ...file.servedPath.split('/'));
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
