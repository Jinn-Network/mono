import { describe, expect, it } from "vitest";
import {
  ADMISSION_REFUSAL_CODES,
  AdmissionRefusalError,
  AdmissionRefusalCodeSchema,
  refuse,
} from "./refusals.js";

describe("the refusal taxonomy", () => {
  it("is closed and exactly these eight codes", () => {
    expect([...ADMISSION_REFUSAL_CODES]).toStrictEqual([
      "duplicate-assertion-id",
      "env-record-mismatch",
      "execution-failed",
      "invalid-candidate",
      "invalid-environment-record",
      "no-discrimination",
      "transitions-mismatch",
      "unstable-observations",
    ]);
  });

  it("rejects a code outside the taxonomy", () => {
    expect(AdmissionRefusalCodeSchema.safeParse("nope").success).toBe(false);
    expect(AdmissionRefusalCodeSchema.safeParse("env-record-mismatch").success).toBe(true);
  });

  it("carries the code and detail on the thrown error and on its refusal", () => {
    try {
      refuse("env-record-mismatch", "inline platform linux/arm64 is not linux/amd64");
      expect.unreachable("refuse must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdmissionRefusalError);
      const refusal = (error as AdmissionRefusalError).refusal;
      expect(refusal.code).toBe("env-record-mismatch");
      expect(refusal.detail).toBe("inline platform linux/arm64 is not linux/amd64");
      expect((error as Error).message).toBe(
        "env-record-mismatch: inline platform linux/arm64 is not linux/amd64",
      );
    }
  });
});
