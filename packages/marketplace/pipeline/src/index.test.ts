// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import * as pipeline from "./index.js";

describe("marketplace pipeline public surface", () => {
  test("exports the M6 operator pipeline contract", () => {
    expect(Object.keys(pipeline).sort()).toEqual([
      "CLAIM_NOTHING",
      "TASK_ENGINE_CARVE",
      "TASK_ENGINE_FAILED_CARVE",
      "buildEngagement",
      "carveOwnerForFailed",
      "checkCaps",
      "evaluateClaimPredicate",
      "matchLegacyManifestDigest",
      "resolveWiringEntry",
      "runPinningConstraint",
      "runPipeline",
      "takeEveryRunnable",
      "wiringHonorsPinning",
    ]);
  });
});
