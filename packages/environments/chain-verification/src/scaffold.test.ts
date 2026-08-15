// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";

describe("chain-environment-verification scaffold", () => {
  it("exports pinned identifiers", () => {
    expect(MINIMUM_RUN_COUNT).toBe(5);
    expect(CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE).toBe(
      "https://spec.jinn.network/attestations/chain-environment-verification/v1",
    );
  });
});
