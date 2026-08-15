// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  PoolEntryManifestSchema,
  parsePoolEntryManifest,
  poolEntryConflictKeyBytes,
  poolEntryManifestBytes,
  type PoolEntrySummary,
} from "../pool.js";

const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}` as const;

function minedSummary(): PoolEntrySummary {
  return {
    taskDigest: digest("1"),
    evaluationSpecDigest: digest("2"),
    receiptDigest: digest("3"),
    environmentRecordDigest: digest("4"),
    strategyId: "https://spec.jinn.network/derivation-strategies/import/v1",
    provenance: {
      kind: "mined",
      sourceCommitment: digest("5"),
      upstream: { dataset: "d", revision: "r", instanceId: "i" },
    },
    rights: { sourceLicense: "MIT" },
  };
}

describe("the widened provenance union leaves mined bytes untouched (F-CE5-1)", () => {
  it("emits the same manifest bytes a pinned mined entry has always emitted", () => {
    expect(new TextDecoder().decode(poolEntryManifestBytes(minedSummary()))).toBe(
      '{"environmentRecordDigest":"' + digest("4") + '",'
        + '"evaluationSpecDigest":"' + digest("2") + '",'
        + '"provenance":{"kind":"mined","sourceCommitment":"' + digest("5") + '",'
        + '"upstream":{"dataset":"d","instanceId":"i","revision":"r"}},'
        + '"receiptDigest":"' + digest("3") + '",'
        + '"rights":{"sourceLicense":"MIT"},'
        + '"schemaVersion":1,'
        + '"strategyId":"https://spec.jinn.network/derivation-strategies/import/v1",'
        + '"taskDigest":"' + digest("1") + '"}',
    );
  });

  it("round-trips a mined manifest through the widened schema", () => {
    const summary = minedSummary();
    expect(parsePoolEntryManifest(poolEntryManifestBytes(summary))).toStrictEqual(summary);
  });
});

describe("a synthetic entry round-trips with template lineage", () => {
  const summary: PoolEntrySummary = {
    ...minedSummary(),
    strategyId: "https://spec.jinn.network/derivation-strategies/chain-scenarios/v1",
    provenance: {
      kind: "synthetic",
      sourceCommitment: digest("6"),
      lineage: {
        templateId: "https://spec.jinn.network/scenario-templates/lending-lifecycle/v1",
        templateVersion: "1.0.0",
        parameterDigest: digest("7"),
        environmentRecordDigest: digest("4"),
      },
    },
  };

  it("parses back to exactly what was written", () => {
    expect(parsePoolEntryManifest(poolEntryManifestBytes(summary))).toStrictEqual(summary);
  });

  it("refuses a synthetic manifest carrying an upstream identity", () => {
    const bad = JSON.parse(new TextDecoder().decode(poolEntryManifestBytes(summary))) as
      Record<string, Record<string, unknown>>;
    bad.provenance.upstream = { dataset: "d", revision: "r", instanceId: "i" };
    expect(PoolEntryManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("gives the two kinds different conflict keys even at the same address", () => {
    expect(new TextDecoder().decode(poolEntryConflictKeyBytes(summary))).not.toBe(
      new TextDecoder().decode(poolEntryConflictKeyBytes(minedSummary())),
    );
  });
});
