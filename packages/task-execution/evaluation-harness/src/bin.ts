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
  // Only a configuration fault reaches here -- `runEvaluationHarness` classifies everything from
  // its own body, and reports the reason itself (#39b). Exact inputs, provider diagnostics, and
  // secrets still never become terminal or log output, so this reports its CLASSIFICATION only:
  // the throw here comes from env/deployment-module resolution, whose message can name host paths
  // and specifiers. The class alone is what distinguishes a mis-wired host from a refused subject,
  // which is the distinction 78-vs-65 exists to draw.
  process.stderr.write(
    `evaluation-harness: refused (evaluation-harness-configuration)\n`,
  );
  process.exitCode = EVALUATION_HARNESS_EXIT_CONFIGURATION;
}
