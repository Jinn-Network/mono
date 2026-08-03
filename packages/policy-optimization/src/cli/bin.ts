#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * The bin wrapper — the only place in this package that touches the process.
 *
 * Everything it does is adapt `process` to `runCli`'s injected environment and back. Keeping it
 * this short is what makes every verb testable without spawning anything.
 */

import { runCli } from "./main.js";

const result = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  now: () => new Date().toISOString(),
});

if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
