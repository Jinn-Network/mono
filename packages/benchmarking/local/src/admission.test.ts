// SPDX-License-Identifier: MIT

import type { InScopeCell } from "@jinn-network/benchmarking-run";
import { describe, expect, test } from "vitest";
import { integrityTierFromReceipt, localAdmissionEvidence } from "./admission.js";

const CELL: Pick<InScopeCell, "cellKey" | "taskDigest" | "evaluationSpecDigest"> = {
  cellKey: "task/arm/1",
  taskDigest: "a".repeat(64),
  evaluationSpecDigest: `sha256:${"e".repeat(64)}`,
};

describe("integrityTierFromReceipt (design §8.4)", () => {
  test("re-derivable needs both zero replay variance and no external capabilities", () => {
    expect(integrityTierFromReceipt({ zeroReplayVariance: true, externalCapabilities: false }))
      .toBe("re-derivable");
  });

  test("either condition failing degrades to attested-only", () => {
    expect(integrityTierFromReceipt({ zeroReplayVariance: false, externalCapabilities: false }))
      .toBe("attested-only");
    expect(integrityTierFromReceipt({ zeroReplayVariance: true, externalCapabilities: true }))
      .toBe("attested-only");
  });

  test("an absent receipt is attested-only, the conservative default", () => {
    expect(integrityTierFromReceipt(undefined)).toBe("attested-only");
  });
});

describe("localAdmissionEvidence", () => {
  test("degrades to attested-only when no receipt source is wired", async () => {
    expect(await localAdmissionEvidence().tierFor(CELL)).toBe("attested-only");
  });

  test("copies the tier from the cell's receipt", async () => {
    const port = localAdmissionEvidence({
      receiptFor: (cell) => cell.cellKey === CELL.cellKey
        ? { zeroReplayVariance: true, externalCapabilities: false }
        : undefined,
    });
    expect(await port.tierFor(CELL)).toBe("re-derivable");
    expect(await port.tierFor({ ...CELL, cellKey: "other/arm/1" })).toBe("attested-only");
  });

  test("accepts an async receipt lookup", async () => {
    const port = localAdmissionEvidence({
      receiptFor: async () => ({ zeroReplayVariance: true, externalCapabilities: false }),
    });
    expect(await port.tierFor(CELL)).toBe("re-derivable");
  });
});
