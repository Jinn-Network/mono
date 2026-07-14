#!/usr/bin/env tsx
import { runMergeBatchCli } from '../src/merge-batch/cli.js';

const code = await runMergeBatchCli({
  argv: process.argv.slice(2),
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
});

process.exitCode = code;
