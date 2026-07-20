#!/usr/bin/env node
/**
 * jinn-layer CLI entry. Delegates to cli.ts.
 *
 * Run from the client workspace: `yarn jinn-layer corpus search "<query>"`.
 */

import { runJinnLayerCli } from '../cli.js';

runJinnLayerCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`[jinn-layer] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
