import { describe, expect, test } from "vitest";
import type { AttemptUri, TwoPartyEngagement } from "./types.js";

describe("TwoPartyEngagement (TEP Addendum 2026-07-28-b, program §7.2/§7.22)", () => {
  test("carries exactly { attemptUri, dispatchContext }, dispatchContext typed as the protocol DispatchContext shape", () => {
    const attemptUri: AttemptUri = "urn:uuid:33333333-3333-5333-8333-333333333333";
    const engagement: TwoPartyEngagement = {
      attemptUri,
      dispatchContext: {
        taskDigest: `sha256:${"a".repeat(64)}`,
        submission: "urn:uuid:11111111-1111-5111-8111-111111111111",
        nonce: "nonce-1",
        attempt: attemptUri,
      },
    };

    expect(engagement.attemptUri).toBe(attemptUri);
    expect(engagement.dispatchContext.attempt).toBe(attemptUri);
    expect(Object.keys(engagement).sort()).toEqual(["attemptUri", "dispatchContext"]);
  });
});
