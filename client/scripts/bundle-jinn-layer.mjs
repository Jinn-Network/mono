#!/usr/bin/env node
/**
 * Bundle the jinn-layer CLI into dist/bin/jinn-layer.js (#1356).
 *
 * The harness-layer workspace package imports client code across the
 * package boundary (`../../../src/...`), which a second tsc pass cannot
 * emit with sane paths — so the shipped bin is an esbuild bundle instead:
 * all repo-relative imports inlined, npm dependencies left external (they
 * ship in the published package's node_modules).
 */
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

await build({
  entryPoints: ['packages/harness-layer/src/bin/jinn-layer.ts'],
  outfile: 'dist/bin/jinn-layer.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
});
chmodSync('dist/bin/jinn-layer.js', 0o755);
console.log('[bundle-jinn-layer] dist/bin/jinn-layer.js written');
