// SPDX-License-Identifier: Apache-2.0
import {
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import {
  executeEvidenceArtifactStore,
  executeEvidenceFramePlacement,
  executeEvidenceRecordStore,
} from "./record-publication-adapter.js";
import { hashExactBytes } from "./identities.js";

describe("record publication adapter", () => {
  test("executes closed evidence records and artifacts as neutral exact actions", async () => {
    const artifactBytes = Uint8Array.of(1, 2);
    const recordBytes = Uint8Array.of(3, 4);
    const effects: string[] = [];

    await executeEvidenceArtifactStore({
      planId: "adapter-artifact",
      reference: createArtifactReference(artifactBytes),
      bytes: artifactBytes,
      store: async () => { effects.push("artifact"); },
    });
    await executeEvidenceRecordStore({
      planId: "adapter-record",
      reference: createRecordReference("execution-evidence", recordBytes),
      bytes: recordBytes,
      store: async () => { effects.push("record"); },
    });

    expect(effects).toEqual(["artifact", "record"]);
  });

  test("keeps frame action identities deterministic while the legacy caller owns its receipt", async () => {
    const frameBytes = Uint8Array.of(5, 6);
    const ids: string[] = [];
    const input = {
      planId: "adapter-frame",
      frameDigest: hashExactBytes(frameBytes),
      frameBytes,
      place: async (idempotencyKey: string) => { ids.push(idempotencyKey); },
    };

    await executeEvidenceFramePlacement(input);
    await executeEvidenceFramePlacement(input);

    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(ids[1]).toBe(ids[0]);
  });

  test("rejects bytes that do not match a closed evidence reference before effects", async () => {
    const bytes = Uint8Array.of(7);
    let called = false;
    await expect(executeEvidenceRecordStore({
      planId: "adapter-mismatch",
      reference: createRecordReference("result-evaluation", Uint8Array.of(8)),
      bytes,
      store: async () => { called = true; },
    })).rejects.toThrow("exact digest-matching bytes");
    expect(called).toBe(false);
  });
});
