#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * The process entry Claude Code's `hooks.json` names. It exists so `hook.mjs` stays importable
 * by the tests without running, and so the exit code is pinned in exactly one place: a hook
 * that exits non-zero is a hook the host reports as a failure to the user.
 */

import { doctor } from "./doctor.mjs";
import { run } from "./hook.mjs";

if (process.argv[2] === "doctor") {
  for (const line of doctor()) process.stdout.write(`${line}\n`);
} else {
  await run(process.argv.slice(2), { stdin: process.stdin });
}
process.exitCode = 0;
