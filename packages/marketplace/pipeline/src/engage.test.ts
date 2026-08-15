// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { buildEngagement } from "./engage.js";

const ATTEMPT_URI = "urn:uuid:11111111-1111-4111-8111-111111111111";
const DISPATCH_CONTEXT = {
  taskDigest: `sha256:${"a".repeat(64)}`,
  submission: "urn:uuid:22222222-2222-4222-8222-222222222222",
  nonce: "nonce-1",
  attempt: ATTEMPT_URI,
} as const;

describe("buildEngagement", () => {
  test("returns the caller-minted Attempt URI and dispatch context verbatim", () => {
    expect(buildEngagement({
      attemptUri: ATTEMPT_URI,
      dispatchContext: DISPATCH_CONTEXT,
    })).toEqual({
      attemptUri: ATTEMPT_URI,
      dispatchContext: DISPATCH_CONTEXT,
    });
  });
});
