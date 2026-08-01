// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessArtifactCoverage } from "./coverage.js";

const AAVE = "0x00000000000000000000000000000000000000aa";
const ORACLE = "0x00000000000000000000000000000000000000bb";
const FUNDED = "0x00000000000000000000000000000000000000cc";
const SLOT_1 = `0x${"0".repeat(63)}1`;
const SLOT_2 = `0x${"0".repeat(63)}2`;

function input(overrides: Record<string, unknown> = {}) {
  return {
    fidelityClass: "anchored-subset",
    entries: {
      accounts: [AAVE, ORACLE, FUNDED],
      codeEntries: [AAVE],
      storageSlots: [{ address: AAVE, slot: SLOT_1 }, { address: ORACLE, slot: SLOT_2 }],
    },
    manifest: {
      anchorStateRoot: `0x${"3".repeat(64)}`,
      accounts: [{ address: AAVE, verified: true }, { address: ORACLE, verified: true }],
      codeEntries: [{ address: AAVE, codeHash: `0x${"4".repeat(64)}`, verified: true }],
      storageSlots: [
        { address: AAVE, slot: SLOT_1, verified: true },
        { address: ORACLE, slot: SLOT_2, verified: true },
      ],
    },
    fixtureMutations: [
      { address: FUNDED, kind: "account" },
    ],
    mutatesSourceProtocolState: false,
    ...overrides,
  } as const;
}

describe("E13 artifact coverage", () => {
  it("passes when every entry is proof-covered or fixture-declared", () => {
    const assessment = assessArtifactCoverage(input());
    expect(assessment).toMatchObject({ complete: true, proofCovered: 5, fixtureDeclared: 1 });
    expect(assessment.uncovered).toBe(0);
    expect(assessment.reason).toBeUndefined();
  });

  it("catches the tampered slot that no other check would see", () => {
    // The forged-slice gap, exactly: real code and real storage proven, plus one extra slot
    // that the manifest never mentions and no fixture declares.
    const tampered = input({
      entries: {
        accounts: [AAVE, ORACLE, FUNDED],
        codeEntries: [AAVE],
        storageSlots: [
          { address: AAVE, slot: SLOT_1 },
          { address: ORACLE, slot: SLOT_2 },
          { address: ORACLE, slot: `0x${"0".repeat(63)}9` },
        ],
      },
    });
    const assessment = assessArtifactCoverage(tampered);
    expect(assessment.complete).toBe(false);
    expect(assessment.reason).toBe("artifact-entry-uncovered");
    expect(assessment.uncoveredStorageSlots).toEqual([
      { address: ORACLE, slot: `0x${"0".repeat(63)}9` },
    ]);
    expect(assessment.uncovered).toBe(1);
  });

  it("reports uncovered accounts and code separately", () => {
    const assessment = assessArtifactCoverage(input({
      manifest: { ...input().manifest, codeEntries: [] },
    }));
    expect(assessment.uncoveredCodeEntries).toEqual([AAVE]);
    expect(assessment.reason).toBe("artifact-entry-uncovered");
  });

  it("treats an unverified proof entry as no coverage at all", () => {
    const assessment = assessArtifactCoverage(input({
      manifest: {
        ...input().manifest,
        storageSlots: [
          { address: AAVE, slot: SLOT_1, verified: true },
          { address: ORACLE, slot: SLOT_2, verified: false },
        ],
      },
    }));
    expect(assessment.complete).toBe(false);
    expect(assessment.uncoveredStorageSlots).toEqual([{ address: ORACLE, slot: SLOT_2 }]);
  });

  it("requires the visibility flag when a fixture mutates proof-covered protocol state", () => {
    const assessment = assessArtifactCoverage(input({
      fixtureMutations: [{ address: FUNDED, kind: "account" }, { address: AAVE, kind: "storage", slot: SLOT_1 }],
      mutatesSourceProtocolState: false,
    }));
    expect(assessment.complete).toBe(false);
    expect(assessment.reason).toBe("undeclared-source-mutation");
    expect(assessment.undeclaredMutations).toEqual([AAVE]);
    // Declared, it is legal: mutating real protocol state is how scenarios are built.
    expect(assessArtifactCoverage(input({
      fixtureMutations: [{ address: FUNDED, kind: "account" }, { address: AAVE, kind: "storage", slot: SLOT_1 }],
      mutatesSourceProtocolState: true,
    })).complete).toBe(true);
  });

  it("does not apply to local records", () => {
    const assessment = assessArtifactCoverage(input({
      fidelityClass: "local",
      manifest: undefined,
    }));
    expect(assessment).toMatchObject({ applicable: false, complete: true, uncovered: 0 });
  });

  it("requires a manifest for anchored-subset and full-state", () => {
    expect(assessArtifactCoverage(input({ manifest: undefined })))
      .toMatchObject({ complete: false, reason: "artifact-entry-uncovered" });
  });

  it("returns uncovered sets in code-unit order", () => {
    const assessment = assessArtifactCoverage(input({ manifest: { ...input().manifest, accounts: [] } }));
    expect(assessment.uncoveredAccounts).toEqual([AAVE, ORACLE]);
  });
});
