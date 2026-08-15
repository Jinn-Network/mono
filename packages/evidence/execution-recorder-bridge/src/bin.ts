#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runExecutionRecorderBridgeCli } from "./cli.js";

process.exitCode = await runExecutionRecorderBridgeCli({
  args: process.argv.slice(2),
  input: process.stdin,
  output: process.stdout,
  error: process.stderr,
});
