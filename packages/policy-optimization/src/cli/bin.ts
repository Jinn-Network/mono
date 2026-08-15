#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * The bin wrapper — the only place in this package that touches the process.
 *
 * Everything it does is adapt `process` to `runCli`'s injected environment and back. Keeping it
 * this short is what makes every verb testable without spawning anything.
 */

import { createInterface } from "node:readline/promises";
import {
  JINN_OPTIMIZE_USAGE,
  runGuidedJourney,
  runLiveHostCommand,
} from "../host-local/guide.js";
import { ok, type CliResult } from "./result.js";
import { runCli } from "./main.js";

const argv = process.argv.slice(2);
let result: CliResult;
if (argv.length === 0) {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      result = await runGuidedJourney({
        cwd: process.cwd(),
        io: { question: (message) => prompt.question(message), write: (text) => process.stdout.write(text) },
      });
    } finally {
      prompt.close();
    }
  } else {
    result = ok(JINN_OPTIMIZE_USAGE);
  }
} else if (argv[0] === "help" || argv[0] === "--help") {
  result = ok(JINN_OPTIMIZE_USAGE);
} else {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    result = await runLiveHostCommand(argv, process.cwd(), controller.signal) ?? runCli(
        argv[0] === "optimize" ? argv : ["optimize", ...argv],
        { cwd: process.cwd(), now: () => new Date().toISOString() },
      );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (result.stdout !== "") process.stdout.write(result.stdout);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
