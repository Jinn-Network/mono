// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import * as pipeline from "./index.js";

describe("marketplace pipeline public surface", () => {
  test("exports the M6 operator pipeline contract", () => {
    expect(Object.keys(pipeline).sort()).toEqual([
      "CLAIM_NOTHING",
      "RECORD_KINDS_SUBMISSION",
      "buildEngagement",
      "checkCaps",
      "evaluateClaimPredicate",
      "mapAnnouncedSubmissionToFacts",
      "matchLegacyManifestDigest",
      "resolveWiringEntry",
      "runPinningConstraint",
      "runPipeline",
      "takeEveryRunnable",
      "validateRequirementsAgainstRunPinning",
      "verifyPreclaim",
      "wiringHonorsPinning",
    ]);
  });
});
