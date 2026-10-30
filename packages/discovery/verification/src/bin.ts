#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runCommand } from "./command.js";

// A reader closing the pipe early, as `head` does, is not an error in the command.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

try {
  process.exitCode = await runCommand(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 2;
}
