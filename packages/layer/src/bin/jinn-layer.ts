#!/usr/bin/env node

import { runJinnLayerCli } from '../cli.js';

runJinnLayerCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(
      `[jinn-layer] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
