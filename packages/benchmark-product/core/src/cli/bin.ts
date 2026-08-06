#!/usr/bin/env node

/**
 * The bin wrapper — the only file in this package that touches the process.
 *
 * Everything it does is adapt `process` to `runCli`'s injected environment
 * and back. Keeping it this short is what makes every verb testable without
 * spawning anything (mirrors `packages/policy-optimization/src/cli/bin.ts`).
 */

import { runCli } from "./main.js";

const result = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  clock: () => new Date().toISOString(),
  // stderr, never stdout: --json mode's stdout must stay a single machine-parseable envelope,
  // and even in human mode stdout is reserved for the verb's final rendered result.
  progress: (line) => process.stderr.write(`${line}\n`),
});

if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
