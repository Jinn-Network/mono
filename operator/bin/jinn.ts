#!/usr/bin/env tsx
/**
 * jinn CLI entry. Delegates to operator/src/cli/index.ts.
 *
 * Contract: spec/2026-04-14-client-surface.md
 */

import { runCli } from '../src/cli/index.js';

runCli(process.argv.slice(2)).catch((err) => {
  // Top-level safety net. runCli is expected to catch its own errors
  // and emit an envelope, so reaching here is itself a defect.
  // Log to stderr; the envelope contract requires stdout.
  console.error('[jinn] internal error: runCli threw instead of emitting an envelope');
  console.error(err);
  process.exit(50);
});
