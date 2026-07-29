import { describe, expect, test } from "vitest";
import {
  attestedPinningObservation,
  marketplaceAdmissionEvidence,
} from "./pinning-admission.js";

describe("honest marketplace pinning and admission defaults", () => {
  test("all pinning axes are unverifiable", async () => {
    const pinning = attestedPinningObservation();
    await expect(pinning.observe(null, {})).resolves.toEqual({
      harness: "unverifiable",
      model: "unverifiable",
      loadout: "unverifiable",
      isolation: "unverifiable",
    });
  });

  test("absent admission receipt defaults to attested-only", async () => {
    const admission = marketplaceAdmissionEvidence();
    await expect(
      admission.tierFor({
        cellKey: `${"a".repeat(64)}/armA/1`,
        taskDigest: "a".repeat(64),
      }),
    ).resolves.toBe("attested-only");
  });
});
