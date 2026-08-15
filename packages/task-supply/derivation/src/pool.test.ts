// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DerivationError } from "./errors.js";
import {
  POOL_ENTRY_SCHEMA_VERSION,
  assertEntryDigests,
  parsePoolEntryManifest,
  poolEntryManifestBytes,
} from "./pool.js";
import { buildFixturePoolEntry } from "./testing-support.js";

describe("pool entry manifest", () => {
  it("round-trips through canonical bytes", () => {
    const entry = buildFixturePoolEntry();
    const bytes = poolEntryManifestBytes(entry);
    expect(parsePoolEntryManifest(bytes)).toEqual({
      taskDigest: entry.taskDigest,
      evaluationSpecDigest: entry.evaluationSpecDigest,
      receiptDigest: entry.receiptDigest,
      environmentRecordDigest: entry.environmentRecordDigest,
      strategyId: entry.strategyId,
      provenance: entry.provenance,
      rights: entry.rights,
    });
  });

  it("records no timestamp and no status field (§12)", () => {
    const manifest = JSON.parse(new TextDecoder().decode(poolEntryManifestBytes(buildFixturePoolEntry())));
    expect(Object.keys(manifest).sort()).toEqual([
      "environmentRecordDigest",
      "evaluationSpecDigest",
      "provenance",
      "receiptDigest",
      "rights",
      "schemaVersion",
      "strategyId",
      "taskDigest",
    ]);
    expect(manifest.schemaVersion).toBe(POOL_ENTRY_SCHEMA_VERSION);
  });

  it("refuses an entry whose declared digest does not address its bytes", () => {
    const entry = buildFixturePoolEntry();
    expect(() => assertEntryDigests({ ...entry, taskDigest: `sha256:${"0".repeat(64)}` }))
      .toThrow(DerivationError);
    expect(() => assertEntryDigests({ ...entry, evaluationSpecDigest: `sha256:${"0".repeat(64)}` }))
      .toThrow(DerivationError);
  });
});
