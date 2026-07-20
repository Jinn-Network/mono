#!/usr/bin/env node
/**
 * Bundle shipped entry points that reach private workspace packages.
 *
 * The harness-layer workspace package imports client code across the package
 * boundary (`../../../src/...`), while the compiled mineable-store facade
 * imports private @jinn-network/core. Ship those entry points as esbuild
 * bundles: repo-relative and private workspace imports are inlined, while npm
 * dependencies remain external (they ship in the published package's
 * node_modules).
 */
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';

// @jinn-network/plugin is intentionally private in Stage 1 and therefore is
// not an installable runtime dependency of @jinn-network/client. Inline it
// into the shipped jinn-layer binaries while leaving ordinary npm packages
// external for the package manager to provide.
const inlinePrivatePlugin = {
  name: 'inline-private-jinn-plugin',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@jinn-network\/plugin$/ }, () => ({
      path: resolve('../packages/plugin/src/index.ts'),
    }));
  },
};

// @jinn-network/core is the same class of private workspace package as the
// plugin: the bins now transitively reach the moved stores (cli.ts →
// plugin-wiring.ts → contribution-store; adapters barrel → evidence-adapter),
// which resolve to @jinn-network/core. Inline it into the shipped binaries.
const inlinePrivateCore = {
  name: 'inline-private-jinn-core',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@jinn-network\/core(?:\/.+)?$/ }, (args) => ({
      path: resolve(
        '../packages/core/src',
        args.path === '@jinn-network/core'
          ? 'index.ts'
          : `${args.path.slice('@jinn-network/core/'.length)}/index.ts`,
      ),
    }));
  },
};

for (const entry of [
  { in: 'scripts/jinn-layer-entry.ts', out: 'dist/bin/jinn-layer.js', executable: true },
  { in: 'packages/harness-layer/src/bin/jinn-distill-mcp.ts', out: 'dist/bin/jinn-distill-mcp.js', executable: true },
  {
    in: 'src/solver-types/_swe-rebench-v2-mineable-store.ts',
    out: 'dist/solver-types/_swe-rebench-v2-mineable-store.js',
    executable: false,
  },
]) {
  await build({
    entryPoints: [entry.in],
    outfile: entry.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    plugins: [inlinePrivatePlugin, inlinePrivateCore],
    logLevel: 'warning',
  });
  if (entry.executable) chmodSync(entry.out, 0o755);
  console.log(`[bundle-jinn-layer] ${entry.out} written`);
}
