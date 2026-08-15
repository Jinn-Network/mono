// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  normalizeAddress,
  WELL_KNOWN_DEV_ADDRESSES,
} from "../fixture-accounts.js";
import {
  buildApprovalFixtureSource,
  buildLendingFixtureSource,
  fixtureFiles,
} from "../testing.js";

describe("fixture address hygiene", () => {
  it("no address anywhere in this package's fixtures is a well-known dev address", () => {
    const offenders = fixtureFiles()
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/0x[0-9a-fA-F]{40}/g)]
        .map((match) => normalizeAddress(match[0]))
        .filter((address) => WELL_KNOWN_DEV_ADDRESSES.includes(address))
        .map((address) => `${file} -> ${address}`));
    expect(offenders).toStrictEqual([]);
  });

  it("no address is shared between the two family fixtures", () => {
    const lending = buildLendingFixtureSource().chain.fixtures.accounts.map((account) =>
      normalizeAddress(account.address),
    );
    const approval = buildApprovalFixtureSource().chain.fixtures.accounts.map((account) =>
      normalizeAddress(account.address),
    );
    const shared = lending.filter((address) => approval.includes(address));
    expect(shared).toStrictEqual([]);
  });
});
