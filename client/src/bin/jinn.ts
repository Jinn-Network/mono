#!/usr/bin/env node
/**
 * jinn CLI entry. Delegates to cli/index.ts.
 *
 * This file lives under src/bin/ so that `tsc` compiles it to dist/bin/jinn.js.
 * The package.json `bin` field points at the compiled output, making `jinn`
 * available on PATH when the package is installed globally.
 *
 * Contract: spec/2026-04-14-client-surface.md
 */

import { runCli } from '../cli/index.js';

runCli(process.argv.slice(2)).catch((err) => {
  // Top-level safety net. runCli is expected to catch its own errors
  // and emit an envelope, so reaching here is itself a defect.
  // Log to stderr; the envelope contract requires stdout.
  console.error('[jinn] internal error: runCli threw instead of emitting an envelope');
  console.error(err);
  process.exit(50);
});
