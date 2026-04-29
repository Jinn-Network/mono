#!/usr/bin/env node
/**
 * Writes dist/build-meta.json and dist/build-info.json after tsc so shipped
 * artifacts carry commit metadata.
 *
 * build-meta.json  — legacy shape ({ commit }), kept for backwards compat.
 * build-info.json  — full shape consumed by src/build-info.ts at runtime:
 *   { clientGitSha, codeDigest, builtAt, implVersion }
 *
 * CI should set JINN_BUILD_COMMIT or rely on GITHUB_SHA (set by GitHub Actions).
 * codeDigest is sha256 of dist/main.js (the production entry point).
 * If dist/main.js is absent (unusual), falls back to 'sha256:unavailable'.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');

const commit =
  process.env.JINN_BUILD_COMMIT?.trim() ||
  process.env.GITHUB_SHA?.trim() ||
  'unknown';

// Read implVersion from package.json
const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const implVersion = pkg.version ?? '0.0.0';

// Compute sha256 of dist/main.js (the compiled production entry point).
const mainJsPath = join(distDir, 'main.js');
let codeDigest = 'sha256:unavailable';
if (existsSync(mainJsPath)) {
  const hash = createHash('sha256').update(readFileSync(mainJsPath)).digest('hex');
  codeDigest = `sha256:${hash}`;
}

mkdirSync(distDir, { recursive: true });

// Legacy artifact — kept for backwards compat.
writeFileSync(
  join(distDir, 'build-meta.json'),
  `${JSON.stringify({ commit }, null, 2)}\n`,
  'utf8',
);

// Full build-info consumed by src/build-info.ts.
writeFileSync(
  join(distDir, 'build-info.json'),
  `${JSON.stringify({ clientGitSha: commit, codeDigest, builtAt: new Date().toISOString(), implVersion }, null, 2)}\n`,
  'utf8',
);
