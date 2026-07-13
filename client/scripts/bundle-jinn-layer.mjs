#!/usr/bin/env node
/**
 * Bundle harness-layer binaries into dist/bin (#1356).
 *
 * The harness-layer workspace package imports client code across the
 * package boundary (`../../../src/...`), which a second tsc pass cannot
 * emit with sane paths — so the shipped bin is an esbuild bundle instead:
 * all repo-relative imports inlined, npm dependencies left external (they
 * ship in the published package's node_modules).
 */
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

for (const entry of [
  { in: 'packages/harness-layer/src/bin/jinn-layer.ts', out: 'dist/bin/jinn-layer.js' },
  { in: 'packages/harness-layer/src/bin/jinn-distill-mcp.ts', out: 'dist/bin/jinn-distill-mcp.js' },
]) {
  await build({
    entryPoints: [entry.in],
    outfile: entry.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'warning',
  });
  chmodSync(entry.out, 0o755);
  console.log(`[bundle-jinn-layer] ${entry.out} written`);
}
