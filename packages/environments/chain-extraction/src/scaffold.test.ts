// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BASELINE_RUN_COUNT,
  CHAIN_EXTRACTION_PROTOCOL_URI,
  DEFAULT_MAX_WIDENINGS,
  MAX_WIDENINGS_CEILING,
} from "./identifiers.js";

describe("chain-state-extraction scaffold", () => {
  it("exports pinned identifiers", () => {
    expect(BASELINE_RUN_COUNT).toBe(2);
    expect(DEFAULT_MAX_WIDENINGS).toBe(3);
    expect(MAX_WIDENINGS_CEILING).toBe(8);
    expect(CHAIN_EXTRACTION_PROTOCOL_URI).toBe(
      "https://jinn.network/protocols/chain-state-extraction/v1",
    );
  });
});
