import { describe, expect, test } from "vitest";

import { isWellKnownDevAddress, WELL_KNOWN_DEV_ADDRESSES } from "./dev-addresses.js";

describe("well-known dev addresses (§8, program §4 contract 8)", () => {
  test("carries the standard ten-account dev set", () => {
    expect(WELL_KNOWN_DEV_ADDRESSES.length).toBeGreaterThanOrEqual(10);
    expect(WELL_KNOWN_DEV_ADDRESSES).toContain("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  test("every entry is stored in the record's own lowercase spelling", () => {
    for (const address of WELL_KNOWN_DEV_ADDRESSES) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test("the set has no duplicates", () => {
    expect(new Set(WELL_KNOWN_DEV_ADDRESSES).size).toBe(WELL_KNOWN_DEV_ADDRESSES.length);
  });

  test("recognises a dev address whatever case the caller hands over", () => {
    expect(isWellKnownDevAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(true);
    expect(isWellKnownDevAddress("0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe(true);
  });

  test("a freshly generated address is not in the set", () => {
    expect(isWellKnownDevAddress(`0x${"7".repeat(40)}`)).toBe(false);
  });
});
