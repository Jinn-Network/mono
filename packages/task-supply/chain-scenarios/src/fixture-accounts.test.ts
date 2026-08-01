// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  WELL_KNOWN_DEV_ADDRESSES,
  assertFreshFixtureAddress,
  createFixtureAddressLedger,
  normalizeAddress,
} from "./fixture-accounts.js";

const RECORD_A = "sha256:" + "a".repeat(64);
const RECORD_B = "sha256:" + "b".repeat(64);
const FRESH = "0x1111111111111111111111111111111111111111";
const FRESH_2 = "0x2222222222222222222222222222222222222222";

describe("well-known dev addresses can never be a scenario fixture account", () => {
  it("bans every address on the list, in any case spelling", () => {
    for (const address of WELL_KNOWN_DEV_ADDRESSES) {
      expect(() => assertFreshFixtureAddress(address, "collateral-holder"))
        .toThrow(/well-known development address/);
      expect(() => assertFreshFixtureAddress(address.toUpperCase().replace("0X", "0x"), "x"))
        .toThrow(/well-known development address/);
    }
  });

  it("bans the zero address and the burn address", () => {
    expect(() => assertFreshFixtureAddress(`0x${"0".repeat(40)}`, "x")).toThrow();
    expect(() => assertFreshFixtureAddress(`0x${"0".repeat(39)}1`, "x")).toThrow();
  });

  it("names ten standard dev accounts, so a shortened list is a test failure", () => {
    expect(WELL_KNOWN_DEV_ADDRESSES.length).toBeGreaterThanOrEqual(12);
    expect(WELL_KNOWN_DEV_ADDRESSES).toContain("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(new Set(WELL_KNOWN_DEV_ADDRESSES).size).toBe(WELL_KNOWN_DEV_ADDRESSES.length);
    expect([...WELL_KNOWN_DEV_ADDRESSES].sort()).toStrictEqual([...WELL_KNOWN_DEV_ADDRESSES]);
  });

  it("refuses a malformed address rather than normalizing it into something plausible", () => {
    expect(() => assertFreshFixtureAddress("0x123", "x")).toThrow(/20-byte/);
    expect(() => assertFreshFixtureAddress(FRESH.slice(2), "x")).toThrow(/0x/);
  });

  it("accepts a fresh address", () => {
    expect(() => assertFreshFixtureAddress(FRESH, "collateral-holder")).not.toThrow();
  });
});

describe("a fixture address is never reused across records", () => {
  it("refuses the same address for a second record", () => {
    const ledger = createFixtureAddressLedger();
    ledger.claim(RECORD_A, FRESH, "borrower");
    expect(() => ledger.claim(RECORD_B, FRESH, "borrower"))
      .toThrow(/already claimed for another environment record/);
  });

  it("refuses the same address twice for two roles inside one record", () => {
    const ledger = createFixtureAddressLedger();
    ledger.claim(RECORD_A, FRESH, "borrower");
    expect(() => ledger.claim(RECORD_A, FRESH, "liquidator")).toThrow(/already claimed/);
  });

  it("admits distinct addresses within one record", () => {
    const ledger = createFixtureAddressLedger();
    ledger.claim(RECORD_A, FRESH, "borrower");
    expect(() => ledger.claim(RECORD_A, FRESH_2, "liquidator")).not.toThrow();
  });

  it("applies the banned list through the ledger too", () => {
    const ledger = createFixtureAddressLedger();
    expect(() => ledger.claim(RECORD_A, WELL_KNOWN_DEV_ADDRESSES[0] as string, "borrower"))
      .toThrow(/well-known development address/);
  });
});

describe("normalizeAddress is case-folding only", () => {
  it("lowercases and preserves the bytes", () => {
    expect(normalizeAddress("0xAbCd" + "0".repeat(36))).toBe("0xabcd" + "0".repeat(36));
  });
});
