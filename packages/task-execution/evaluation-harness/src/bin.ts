#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import {
  EVALUATION_HARNESS_EXIT_CONFIGURATION,
  pathsFromEnv,
  runEvaluationHarness,
} from "./runtime.js";

try {
  process.exitCode = await runEvaluationHarness(pathsFromEnv());
} catch {
  // The spawned process reports only a stable exit. Exact inputs, provider diagnostics, and
  // secrets never become terminal or log output.
  process.exitCode = EVALUATION_HARNESS_EXIT_CONFIGURATION;
}
