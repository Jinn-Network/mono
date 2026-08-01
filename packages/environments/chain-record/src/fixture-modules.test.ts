import { describe, expect, test } from "vitest";

import { ChainFixturesSchema } from "./fixture-modules.js";
import { WELL_KNOWN_DEV_ADDRESSES } from "./dev-addresses.js";

const module = (id: string, kind: string, hex: string) => ({
  id,
  kind,
  module: { name: id, digest: { sha256: hex.repeat(64) } },
});

const fixtures = () => ({
  modules: [
    module("accounts", "funded-accounts", "1"),
    module("addresses", "address-book", "2"),
    module("rates", "state-mutation", "3"),
  ],
  accounts: [
    { role: "agent", address: `0x${"a1".repeat(20)}`, nativeBalanceWei: "10000000000000000000" },
    { role: "counterparty", address: `0x${"b2".repeat(20)}`, nativeBalanceWei: "0" },
  ],
});

const parse = (document: unknown) => ChainFixturesSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("fixtures block (§4.3)", () => {
  test("accepts an ordered, digest-pinned module list with roled accounts", () => {
    expect(parse(fixtures()).success).toBe(true);
  });

  test("array order IS the application order and survives parsing", () => {
    expect(ChainFixturesSchema.parse(fixtures()).modules.map((m) => m.id))
      .toEqual(["accounts", "addresses", "rates"]);
  });

  test("refuses a module referenced by uri alone: fixtures are pinned by digest", () => {
    const document = fixtures();
    document.modules[0].module = { uri: "https://example.test/accounts.json" } as never;
    expect(parse(document).success).toBe(false);
  });

  test("refuses duplicate module ids: probe coverage is declared per module id", () => {
    const document = fixtures();
    document.modules[2].id = "accounts";
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("module id");
  });

  test("refuses duplicate account roles", () => {
    const document = fixtures();
    document.accounts[1].role = "agent";
    expect(parse(document).success).toBe(false);
  });

  test("refuses the same address under two roles: keys are fresh per record, never reused", () => {
    const document = fixtures();
    document.accounts[1].address = document.accounts[0].address;
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("reused");
  });

  test("carries balances and roles, never key material", () => {
    const document = { ...fixtures() } as Record<string, unknown>;
    (document.accounts as Record<string, unknown>[])[0].privateKey = `0x${"9".repeat(64)}`;
    expect(parse(document).success).toBe(false);
  });

  test("an empty module list is legal: a world may be fully described by its artifact", () => {
    expect(parse({ ...fixtures(), modules: [] }).success).toBe(true);
  });
});

// Program §4 contract 8: a fixture address someone might fund turns every published solution
// script into a replayable mainnet transaction from it.
describe("the well-known dev-address lint (§8)", () => {
  test("refuses a fixture account at a well-known dev-mnemonic address", () => {
    const document = fixtures();
    document.accounts[0].address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("well-known");
  });

  test("refuses every address in the set, not only the first account", () => {
    for (const address of WELL_KNOWN_DEV_ADDRESSES) {
      const document = fixtures();
      document.accounts[1].address = address;
      expect(parse(document).success, address).toBe(false);
    }
  });
});
