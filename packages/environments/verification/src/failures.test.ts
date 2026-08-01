// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  FAILURE_DISPOSITIONS,
  VERIFICATION_FAILURE_REASONS,
  classifyVerificationFailure,
  stageForFailureReason,
} from "./failures.js";

describe("failure taxonomy", () => {
  it("classifies every reason in the closed vocabulary", () => {
    for (const reason of VERIFICATION_FAILURE_REASONS) {
      expect(FAILURE_DISPOSITIONS).toContain(classifyVerificationFailure(reason));
    }
  });

  it("uses all four legacy dispositions", () => {
    const used = new Set(VERIFICATION_FAILURE_REASONS.map(classifyVerificationFailure));
    expect([...FAILURE_DISPOSITIONS].every((disposition) => used.has(disposition))).toBe(true);
  });

  it("maps divergence to quarantined and a wrong digest to terminal policy", () => {
    expect(classifyVerificationFailure("outcome-set-divergence")).toBe("quarantined");
    expect(classifyVerificationFailure("image-digest-mismatch")).toBe("terminal_policy");
    expect(classifyVerificationFailure("image-unresolvable")).toBe("failed_infrastructure");
    expect(classifyVerificationFailure("parser-produced-no-outcomes")).toBe("awaiting_input");
  });

  it("pins each reason to exactly one protocol stage", () => {
    expect(stageForFailureReason("image-unresolvable")).toBe("acquire");
    expect(stageForFailureReason("image-digest-mismatch")).toBe("acquire");
    expect(stageForFailureReason("install-command-failed")).toBe("install");
    expect(stageForFailureReason("run-command-failed")).toBe("run");
    expect(stageForFailureReason("runtime-timeout")).toBe("run");
    expect(stageForFailureReason("parser-produced-no-outcomes")).toBe("run");
    expect(stageForFailureReason("outcome-set-divergence")).toBe("compare");
  });
});
