import type { AttemptUri } from "@jinn-network/task-execution-backend";
import type { DispatchContext } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import type { TwoPartyEngagement } from "./two-party-engagement.js";
import { deriveMarketplaceAttemptUri } from "./attempt-uri.js";

describe("TwoPartyEngagement", () => {
  test("carries exactly { attemptUri, dispatchContext }", () => {
    const attemptUri: AttemptUri = deriveMarketplaceAttemptUri({
      chainId: 84532,
      coordinator: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
      taskId: 1n,
      attemptIndex: 0,
    });
    const dispatchContext: DispatchContext = {
      taskDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      submission: "urn:uuid:00000000-0000-0000-0000-000000000000",
      nonce: "n-1",
      attempt: attemptUri,
    };

    // Type-level check: this object must typecheck as TwoPartyEngagement using the backend's
    // own AttemptUri type and the protocol's own DispatchContext type -- no local re-declaration
    // of either.
    const engagement: TwoPartyEngagement = { attemptUri, dispatchContext };

    expect(Object.keys(engagement).sort()).toEqual(["attemptUri", "dispatchContext"]);
    expect(engagement.attemptUri).toBe(attemptUri);
    expect(engagement.dispatchContext).toBe(dispatchContext);
  });
});
