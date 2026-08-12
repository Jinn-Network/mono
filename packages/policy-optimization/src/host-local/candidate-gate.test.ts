import { sealCandidateManifest } from "@jinn-network/policy-identity";
import { describe, expect, test } from "vitest";
import { manifestFor, PARENT_TUPLE } from "../testing/admission-fixtures.js";
import { assertLiveLocalCandidateBoundary } from "./candidate-gate.js";

const localOperator = "did:jinn:operator-ritsu";
const manifestBytes = sealCandidateManifest(manifestFor(PARENT_TUPLE, {
  proposer: localOperator,
})).bytes;

describe("live local candidate boundary", () => {
  test("hard-refuses imported and cross-operator candidates", () => {
    expect(() => assertLiveLocalCandidateBoundary({
      source: "imported",
      localOperatorId: localOperator,
      manifestBytes,
      approvedExecutableClasses: [],
    })).toThrow(/hard-refuses imported/u);
    expect(() => assertLiveLocalCandidateBoundary({
      source: "locally-proposed",
      localOperatorId: "did:jinn:someone-else",
      manifestBytes,
      approvedExecutableClasses: [],
    })).toThrow(/cross-operator/u);
  });

  test("forces executable-change consent for a local candidate", () => {
    expect(assertLiveLocalCandidateBoundary({
      source: "locally-proposed",
      localOperatorId: localOperator,
      manifestBytes,
      approvedExecutableClasses: ["hook-or-tool-config", "hook-or-tool-config"],
    })).toEqual({
      crossOperator: false,
      requireExecutableChangeConsent: true,
      approvedPayloadClasses: ["hook-or-tool-config"],
    });
  });
});
