// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CHAIN_VERIFICATION_DISPOSITIONS,
  CHAIN_VERIFICATION_FAILURE_REASONS,
  CHAIN_VERIFICATION_OUTCOMES,
  CHAIN_VERIFICATION_STAGES,
  RUN_BEARING_OUTCOMES,
  classifyChainVerificationFailure,
  isRunBearingOutcome,
  outcomeForFailureReason,
  stageForFailureReason,
} from "./outcomes.js";

describe("outcome vocabulary", () => {
  it("is exactly design §5.3's closed partition", () => {
    expect([...CHAIN_VERIFICATION_OUTCOMES]).toEqual([
      "closed-reproducible",
      "archive-observed",
      "artifact-unavailable",
      "runtime-identity-mismatch",
      "source-anchor-mismatch",
      "source-proof-invalid",
      "initial-state-mismatch",
      "offline-dependency-detected",
      "capability-mismatch",
      "probe-divergence",
      "reset-divergence",
      "provider-disagreement",
      "source-coverage-incomplete",
      "verification-infrastructure-failure",
    ]);
    expect(new Set(CHAIN_VERIFICATION_OUTCOMES).size).toBe(14);
  });

  it("splits run-bearing outcomes from the rest, and the split is total", () => {
    expect([...RUN_BEARING_OUTCOMES]).toEqual([
      "closed-reproducible",
      "archive-observed",
      "probe-divergence",
      "reset-divergence",
      "provider-disagreement",
    ]);
    for (const outcome of CHAIN_VERIFICATION_OUTCOMES) {
      expect(isRunBearingOutcome(outcome))
        .toBe((RUN_BEARING_OUTCOMES as readonly string[]).includes(outcome));
    }
  });

  it("maps every reason to exactly one outcome and one stage", () => {
    for (const reason of CHAIN_VERIFICATION_FAILURE_REASONS) {
      expect(CHAIN_VERIFICATION_OUTCOMES).toContain(outcomeForFailureReason(reason));
      expect(CHAIN_VERIFICATION_STAGES).toContain(stageForFailureReason(reason));
      expect(CHAIN_VERIFICATION_DISPOSITIONS)
        .toContain(classifyChainVerificationFailure(reason));
    }
  });

  it("never routes a failure reason to a success outcome", () => {
    for (const reason of CHAIN_VERIFICATION_FAILURE_REASONS) {
      expect(outcomeForFailureReason(reason)).not.toBe("closed-reproducible");
      expect(outcomeForFailureReason(reason)).not.toBe("archive-observed");
    }
  });

  it("reaches every non-success outcome from at least one reason", () => {
    const reachable = new Set(
      CHAIN_VERIFICATION_FAILURE_REASONS.map((reason) => outcomeForFailureReason(reason)),
    );
    for (const outcome of CHAIN_VERIFICATION_OUTCOMES) {
      if (outcome === "closed-reproducible" || outcome === "archive-observed") continue;
      expect(reachable.has(outcome), `${outcome} is unreachable`).toBe(true);
    }
  });

  it("keeps divergence quarantined and infrastructure retryable", () => {
    expect(classifyChainVerificationFailure("probe-observation-divergence")).toBe("quarantined");
    expect(classifyChainVerificationFailure("egress-succeeded")).toBe("quarantined");
    expect(classifyChainVerificationFailure("materializer-failed"))
      .toBe("failed_infrastructure");
    // A record whose claims do not hold needs a corrected record, not another attempt.
    expect(classifyChainVerificationFailure("anchor-root-mismatch")).toBe("awaiting_input");
    expect(classifyChainVerificationFailure("resource-digest-mismatch")).toBe("terminal_policy");
  });
});
