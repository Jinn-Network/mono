#!/usr/bin/env node

/**
 * Disposable contributor proof over the canonical sample lifecycle. The
 * lifecycle owns the built CLI path ("dist", "cli", "bin.js"), the two
 * bundled arms ("prediction-v1-baseline" and "sample-uniform"), and the
 * detached "bundle", "verify" step; this wrapper only preserves the historic
 * no-argument contributor command and its concise stderr progress.
 */

import { runSampleLifecycle, SAMPLE_LIFECYCLE_MODES } from "./sample-lifecycle.mjs";

export function run() {
  return runSampleLifecycle({
    mode: SAMPLE_LIFECYCLE_MODES.CONTRIBUTOR_PROOF,
    onProgress: (event) => {
      if (event.type !== "progress") return;
      if (event.stage === "build") console.error(`public-quickstart: ${event.message} ...`);
      else if (event.stage === "command" && event.message?.endsWith("completed")) {
        console.error(`public-quickstart: ${event.label} -> ok`);
      }
    },
  });
}

if (process.argv.length > 2) {
  console.error("public-quickstart takes no arguments; caller-selected paths are refused.");
  process.exitCode = 2;
} else {
  try {
    const evidence = run();
    process.stdout.write(`${JSON.stringify({ ok: true, result: evidence })}\n`);
  } catch (cause) {
    console.error(`public-quickstart: FATAL: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = typeof cause?.exitCode === "number" ? cause.exitCode : 1;
  }
}
