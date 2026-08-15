// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { checkCaps } from "./caps.js";

describe("operator caps", () => {
  test("blocks spend and AI units above the configured ceilings", () => {
    const caps = { spendCapWei: 100n, aiUnitCap: 3 };
    expect(checkCaps(50n, 2, caps)).toBe(true);
    expect(checkCaps(101n, 2, caps)).toBe(false);
    expect(checkCaps(50n, 4, caps)).toBe(false);
  });
});
