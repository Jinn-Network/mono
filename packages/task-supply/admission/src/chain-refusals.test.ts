// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ADMISSION_REFUSAL_CODES } from "./refusals.js";
import {
  CHAIN_ADMISSION_REFUSAL_CODES,
  ChainAdmissionRefusalError,
  refuseChain,
} from "./chain-refusals.js";

describe("two families, two closed taxonomies, one package (F-CE5-5)", () => {
  it("leaves the SWE taxonomy at exactly its eight codes", () => {
    expect([...ADMISSION_REFUSAL_CODES]).toStrictEqual([
      "duplicate-assertion-id", "env-record-mismatch", "execution-failed", "invalid-candidate",
      "invalid-environment-record", "no-discrimination", "transitions-mismatch",
      "unstable-observations",
    ]);
  });

  it("keeps the chain taxonomy closed, sorted, and free of duplicates", () => {
    expect([...CHAIN_ADMISSION_REFUSAL_CODES].sort()).toStrictEqual([...CHAIN_ADMISSION_REFUSAL_CODES]);
    expect(new Set(CHAIN_ADMISSION_REFUSAL_CODES).size).toBe(CHAIN_ADMISSION_REFUSAL_CODES.length);
  });

  it("never lets a chain refusal escape as a SWE refusal, or the reverse", () => {
    const error = new ChainAdmissionRefusalError("do-nothing-satisfies", "d");
    expect(error.name).toBe("ChainAdmissionRefusalError");
    expect(ADMISSION_REFUSAL_CODES).not.toContain(error.refusal.code as never);
  });

  it("throws rather than returns, so a deep check can fail closed", () => {
    expect(() => refuseChain("slice-insufficient", "d")).toThrow(ChainAdmissionRefusalError);
  });
});
