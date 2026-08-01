// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

describe("@jinn-network/chain-scenarios scaffold", () => {
  it("exports an empty module surface", async () => {
    const mod = await import("./index.js");
    expect(mod).toBeDefined();
  });
});
