#!/usr/bin/env node
/**
 * Writes dist/build-meta.json after tsc so shipped artifacts carry commit metadata.
 * CI should set JINN_BUILD_COMMIT or rely on GITHUB_SHA (set by GitHub Actions).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');
const commit =
  process.env.JINN_BUILD_COMMIT?.trim() ||
  process.env.GITHUB_SHA?.trim() ||
  'unknown';

mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, 'build-meta.json'),
  `${JSON.stringify({ commit }, null, 2)}\n`,
  'utf8',
);
