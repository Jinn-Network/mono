#!/usr/bin/env node
/**
 * Bundle the worker into a single dist/index.js with esbuild (#779, FIX 2).
 *
 * Why bundle: the worker imports the indexer's SHARED TS SOURCE through the
 * indexer's `exports` map (`@jinn-network/indexer/ipfs`, `.../enrichment-parse`).
 * With a plain `tsc` build those imports emit VERBATIM into dist/*.js and resolve
 * to `.ts` files — which `node dist/index.js` only loads because Node 22.18+
 * strips types by default. That is an experimental runtime dependency: a future
 * base-image minor that doesn't default type-stripping, or a TS construct the
 * stripper can't handle, would break the boot at runtime — and CI only `docker
 * build`s, it never ran the image, so it would ship undetected.
 *
 * esbuild INLINES those `.ts` modules into the bundle, so the runtime depends on
 * neither type-stripping nor the indexer source tree being present. Real
 * node_modules deps (`pg`, `drizzle-orm`, node builtins) stay external — they are
 * installed normally and not part of the drift surface.
 *
 * Dev/test ergonomics are unchanged: vitest still imports the `.ts` modules
 * through the portal directly (this script is only the production build).
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Everything in node_modules stays external; only first-party `@jinn-network/*`
// source (resolved through the portal) is inlined.
const pkg = require('../package.json');
const external = [
  ...Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@jinn-network/')),
  ...Object.keys(pkg.devDependencies ?? {}),
];

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // src/index.ts already carries a `#!/usr/bin/env node` shebang; esbuild
  // preserves the entry file's leading shebang, so we must NOT add a banner
  // (that would duplicate it).
  external,
  logLevel: 'info',
});
