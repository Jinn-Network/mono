// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/task-execution-profiles";
import {
  PROMPTED_SCREENING_PROCEDURE_PROTOCOL,
  PROMPTED_SCREENING_PROFILE,
  SCREENING_POOL_CANDIDATE_CLASSES,
  SCREENING_POOL_PROTOCOL,
  SCREENING_POOL_V2_PROTOCOL,
  SCREENING_POOL_V2_RESERVE_SELECTION_PROTOCOL,
  SCREENING_POOL_STRATA,
  SCREENING_SAMPLE_COMMITMENT_PROTOCOL,
  SCREENING_TABLE_V2_PROTOCOL,
  PromptedScreeningProcedureV1Schema,
  ScreeningPoolV1Schema,
  ScreeningPoolV2Schema,
  RegisteredScreeningSampleCommitmentV1Schema,
  ScreeningSampleCommitmentV1Schema,
  ScreeningTableV2Schema,
} from "./contracts.js";
import { computeScreeningPoolDigest, computeScreeningSample } from "./screening-sample.js";
import { parseScreeningSampleCommitmentBytes } from "./prompted-commitment.js";
import { selectPromptedScreeningPool } from "./prompted-selection.js";

const DRAFT_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const SEALED_AT = "2026-08-21T12:00:00.000Z";
const digest = (index: number): `sha256:${string}` => `sha256:${index.toString(16).padStart(64, "0")}`;

function procedure() {
  return {
    protocol: PROMPTED_SCREENING_PROCEDURE_PROTOCOL,
    procedureId: PROMPTED_SCREENING_PROFILE,
    coordinatorPromptSha256: digest(900),
    coordinator: { alias: "Sol", model: "gpt-5.6-sol", reasoningEffort: "high", mayOrchestrate: true },
    judgmentAgents: [
      { alias: "Luna", model: "gpt-5.6-luna", reasoningEffort: "medium", maxBatchSize: 32 },
      { alias: "Terra", model: "gpt-5.6-terra", reasoningEffort: "high", maxBatchSize: 16 },
      { alias: "Sol", model: "gpt-5.6-sol", reasoningEffort: "high", maxBatchSize: 8 },
    ],
    toolPolicy: { coordinator: "orchestration-only", judgmentAgents: { web: false, shell: false, repository: false, search: false } },
    output: { alphabet: ["CORRECT", "WRONG", "UNSURE"], invalidOutputDecision: "UNSURE" },
    retry: { maxRetries: 1, onlyWhen: "infrastructure-failure-with-no-model-output", prompt: "identical" },
    transcriptSha256: digest(901),
    sealedAt: SEALED_AT,
  } as const;
}

function pool() {
  const mains = [];
  let position = 1;
  let slot = 1;
  for (const candidateClass of SCREENING_POOL_CANDIDATE_CLASSES) {
    for (const stratum of SCREENING_POOL_STRATA) {
      for (let cellIndex = 0; cellIndex < 20; cellIndex += 1) {
        mains.push({
          itemSha256: digest(position),
          intendedLabel: candidateClass === "correct" ? "CORRECT" as const : "WRONG" as const,
          candidateClass,
          stratum,
          poolPosition: position,
          slotId: `slot-${slot.toString().padStart(3, "0")}`,
          poolKind: "main" as const,
        });
        position += 1;
        slot += 1;
      }
    }
  }
  const reserves = [];
  for (let reserveIndex = 0; reserveIndex < 424; reserveIndex += 1) {
    const main = mains[reserveIndex % mains.length]!;
    reserves.push({
      ...main,
      itemSha256: digest(position),
      poolPosition: position,
      poolKind: "reserve" as const,
      reserveOrder: reserveIndex < mains.length ? 1 : 2,
    });
    position += 1;
  }
  const items = [...mains, ...reserves];
  return {
    protocol: SCREENING_POOL_PROTOCOL,
    draftId: DRAFT_ID,
    identityCommitmentSha256: computeScreeningPoolDigest(items.map((item) => item.itemSha256)) as `sha256:${string}`,
    items,
    sealedAt: SEALED_AT,
  } as const;
}

function sharedReservePool() {
  const mains = [];
  let position = 1;
  let slot = 1;
  for (const candidateClass of SCREENING_POOL_CANDIDATE_CLASSES) {
    for (const stratum of SCREENING_POOL_STRATA) {
      for (let cellIndex = 0; cellIndex < 20; cellIndex += 1) {
        mains.push({
          screeningIdentitySha256: digest(10_000 + position),
          itemSha256: digest(position),
          intendedLabel: candidateClass === "correct" ? "CORRECT" as const : "WRONG" as const,
          candidateClass,
          stratum,
          poolPosition: position,
          sourceQuestionLineageId: `question-${position}`,
          slotId: `slot-${slot.toString().padStart(3, "0")}`,
          poolKind: "main" as const,
        });
        position += 1;
        slot += 1;
      }
    }
  }
  const cells = SCREENING_POOL_CANDIDATE_CLASSES.flatMap((candidateClass) =>
    SCREENING_POOL_STRATA.map((stratum) => ({ candidateClass, stratum })));
  const reserveCounts = new Map<string, number>();
  const reserves = [];
  for (let reserveIndex = 0; reserveIndex < 424; reserveIndex += 1) {
    const cell = cells[reserveIndex % cells.length]!;
    const key = `${cell.candidateClass}/${cell.stratum}`;
    const reserveOrder = (reserveCounts.get(key) ?? 0) + 1;
    reserveCounts.set(key, reserveOrder);
    reserves.push({
      screeningIdentitySha256: digest(10_000 + position),
      itemSha256: digest(position),
      intendedLabel: cell.candidateClass === "correct" ? "CORRECT" as const : "WRONG" as const,
      candidateClass: cell.candidateClass,
      stratum: cell.stratum,
      poolPosition: position,
      sourceQuestionLineageId: `question-${position}`,
      poolKind: "reserve" as const,
      reserveOrder,
    });
    position += 1;
  }
  const items = [...mains, ...reserves];
  return {
    protocol: SCREENING_POOL_V2_PROTOCOL,
    reserveSelectionProtocol: SCREENING_POOL_V2_RESERVE_SELECTION_PROTOCOL,
    draftId: DRAFT_ID,
    identityCommitmentSha256: computeScreeningPoolDigest(items.map((item) => item.screeningIdentitySha256)) as `sha256:${string}`,
    items,
    sealedAt: SEALED_AT,
  } as const;
}

describe("PromptedScreeningProcedureV1Schema", () => {
  test("accepts only the closed Sol-coordinated Luna/Terra/Sol procedure", () => {
    expect(PromptedScreeningProcedureV1Schema.parse(procedure())).toEqual(procedure());
    expect(PromptedScreeningProcedureV1Schema.safeParse({ ...procedure(), extra: true }).success).toBe(false);
    expect(PromptedScreeningProcedureV1Schema.safeParse({ ...procedure(), retry: { ...procedure().retry, maxRetries: 2 } }).success).toBe(false);
    expect(PromptedScreeningProcedureV1Schema.safeParse({ ...procedure(), output: { ...procedure().output, invalidOutputDecision: "WRONG" } }).success).toBe(false);
    expect(PromptedScreeningProcedureV1Schema.safeParse({
      ...procedure(),
      judgmentAgents: [{ ...procedure().judgmentAgents[0], maxBatchSize: 31 }, ...procedure().judgmentAgents.slice(1)],
    }).success).toBe(false);
  });

  test("canonical identity moves on any declared procedure field", () => {
    const original = recordDigest(canonicalJsonBytes(PromptedScreeningProcedureV1Schema.parse(procedure())));
    const changed = recordDigest(canonicalJsonBytes(PromptedScreeningProcedureV1Schema.parse({ ...procedure(), transcriptSha256: digest(902) })));
    expect(changed).not.toBe(original);
  });

  test.each([
    ["coordinator Sol", (value: ReturnType<typeof procedure>) => ({ ...value, coordinator: { ...value.coordinator, reasoningEffort: "medium" } })],
    ["Luna judgment agent", (value: ReturnType<typeof procedure>) => ({ ...value, judgmentAgents: value.judgmentAgents.map((agent, index) => index === 0 ? { ...agent, reasoningEffort: "high" } : agent) })],
    ["Terra judgment agent", (value: ReturnType<typeof procedure>) => ({ ...value, judgmentAgents: value.judgmentAgents.map((agent, index) => index === 1 ? { ...agent, reasoningEffort: "medium" } : agent) })],
    ["Sol judgment agent", (value: ReturnType<typeof procedure>) => ({ ...value, judgmentAgents: value.judgmentAgents.map((agent, index) => index === 2 ? { ...agent, reasoningEffort: "medium" } : agent) })],
  ])("refuses the wrong reasoning effort for %s", (_name, mutate) => {
    expect(PromptedScreeningProcedureV1Schema.safeParse(mutate(procedure())).success).toBe(false);
  });
});

describe("ScreeningPoolV1Schema", () => {
  test("accepts exactly 240 balanced mains and 424 deterministic reserves", () => {
    const parsed = ScreeningPoolV1Schema.parse(pool());
    expect(parsed.items).toHaveLength(664);
    expect(parsed.items.filter((item) => item.poolKind === "main")).toHaveLength(240);
    expect(parsed.items.filter((item) => item.poolKind === "reserve")).toHaveLength(424);
  });

  test.each([
    ["duplicate identity", (value: ReturnType<typeof pool>): unknown => ({ ...value, items: value.items.with(1, { ...value.items[1]!, itemSha256: value.items[0]!.itemSha256 }) })],
    ["position drift", (value: ReturnType<typeof pool>): unknown => ({ ...value, items: value.items.with(1, { ...value.items[1]!, poolPosition: 99 }) })],
    ["class drift", (value: ReturnType<typeof pool>): unknown => ({ ...value, items: value.items.map((item, index) => index === 240 ? { ...item, candidateClass: "specific-wrong", intendedLabel: "WRONG" } : item) })],
    ["reserve-order drift", (value: ReturnType<typeof pool>): unknown => ({ ...value, items: value.items.map((item, index) => index === 240 ? { ...item, reserveOrder: 2 } : item) })],
    ["slot-lineage drift", (value: ReturnType<typeof pool>): unknown => ({ ...value, items: value.items.map((item, index) => index === 0 ? { ...item, slotId: "slot-999" } : item) })],
    ["unknown row member", (value: ReturnType<typeof pool>): unknown => ({ ...value, items: value.items.map((item, index) => index === 0 ? { ...item, note: "not in the closed row shape" } : item) })],
  ])("refuses %s", (_name, mutate) => {
    expect(ScreeningPoolV1Schema.safeParse(mutate(pool())).success).toBe(false);
  });
});

describe("ScreeningPoolV2Schema", () => {
  test("separates the committed screening identity from the later item digest and supports shared reserve slices", () => {
    const parsed = ScreeningPoolV2Schema.parse(sharedReservePool());
    expect(parsed.items).toHaveLength(664);
    expect(parsed.items.filter((item) => item.poolKind === "main")).toHaveLength(240);
    expect(parsed.items.filter((item) => item.poolKind === "reserve")).toHaveLength(424);
    expect(parsed.items[0]!.screeningIdentitySha256).not.toBe(parsed.items[0]!.itemSha256);
  });

  test.each([
    ["duplicate screening identity", (value: ReturnType<typeof sharedReservePool>): unknown => ({ ...value, items: value.items.with(1, { ...value.items[1]!, screeningIdentitySha256: value.items[0]!.screeningIdentitySha256 }) })],
    ["duplicate item digest", (value: ReturnType<typeof sharedReservePool>): unknown => ({ ...value, items: value.items.with(1, { ...value.items[1]!, itemSha256: value.items[0]!.itemSha256 }) })],
    ["duplicate main lineage", (value: ReturnType<typeof sharedReservePool>): unknown => ({ ...value, items: value.items.with(1, { ...value.items[1]!, sourceQuestionLineageId: value.items[0]!.sourceQuestionLineageId }) })],
    ["reserve-order drift", (value: ReturnType<typeof sharedReservePool>): unknown => {
      const items: unknown[] = [...value.items];
      items[240] = { ...value.items[240]!, reserveOrder: 2 };
      return { ...value, items };
    }],
  ])("refuses %s", (_name, mutate) => {
    expect(ScreeningPoolV2Schema.safeParse(mutate(sharedReservePool())).success).toBe(false);
  });

  test("selects each cell's first admissible reserve with an unused question lineage", () => {
    const original = ScreeningPoolV2Schema.parse(sharedReservePool());
    const cellMains = original.items.filter((item) => item.poolKind === "main"
      && item.candidateClass === "correct" && item.stratum === "category-1");
    const cellReserves = original.items.filter((item) => item.poolKind === "reserve"
      && item.candidateClass === "correct" && item.stratum === "category-1");
    const pool = ScreeningPoolV2Schema.parse({
      ...original,
      items: original.items.map((item) => item.itemSha256 === cellReserves[0]!.itemSha256
        ? { ...item, sourceQuestionLineageId: cellMains[2]!.sourceQuestionLineageId }
        : item),
    });
    const excluded = new Set(cellMains.slice(0, 2).map((item) => item.itemSha256));
    const rows = new Map(pool.items.map((item) => [item.itemSha256, {
      itemSha256: item.itemSha256,
      intendedLabel: item.intendedLabel,
      screeningVerdict: item.intendedLabel,
      ritsuDecision: excluded.has(item.itemSha256)
        ? { checked: true as const, verdict: "exclude" as const, decidedAt: SEALED_AT }
        : { checked: false as const },
    }]));
    const selection = selectPromptedScreeningPool(pool, rows);
    expect(selection.winners).toHaveLength(240);
    expect(selection.replacements.map((entry) => ({
      receivingSlotId: entry.receivingSlotId,
      replacementItemSha256: entry.replacement.itemSha256,
    }))).toEqual([
      { receivingSlotId: "slot-001", replacementItemSha256: cellReserves[1]!.itemSha256 },
      { receivingSlotId: "slot-002", replacementItemSha256: cellReserves[2]!.itemSha256 },
    ]);
  });
});

describe("RegisteredScreeningSampleCommitmentV1Schema", () => {
  test("accepts an exact external identity-only commitment made before the later pool bridge", () => {
    const identities = sharedReservePool().items
      .map((item) => item.screeningIdentitySha256)
      .sort();
    const commitment = RegisteredScreeningSampleCommitmentV1Schema.parse({
      schema: "https://fixtures.example.test/screening-commitment/v1",
      candidateItemDigests: identities,
      committedAt: "2026-08-21T10:00:00.000Z",
      poolDigest: computeScreeningPoolDigest(identities),
      sampleSeed: "registered-seed",
      sampleSize: 72,
      samplingScriptSha256: digest(9_999),
    });
    const exactPublicBytes = new Uint8Array([...canonicalJsonBytes(commitment), 0x0a]);
    expect(parseScreeningSampleCommitmentBytes(exactPublicBytes)).toEqual(commitment);
    expect(() => parseScreeningSampleCommitmentBytes(canonicalJsonBytes(commitment))).toThrow(/canonical wire encoding/u);
  });

  test("refuses reordered registered identities", () => {
    const identities = sharedReservePool().items
      .map((item) => item.screeningIdentitySha256)
      .sort();
    expect(RegisteredScreeningSampleCommitmentV1Schema.safeParse({
      schema: "https://fixtures.example.test/screening-commitment/v1",
      candidateItemDigests: identities.with(0, identities[1]!).with(1, identities[0]!),
      committedAt: "2026-08-21T10:00:00.000Z",
      poolDigest: computeScreeningPoolDigest(identities),
      sampleSeed: "registered-seed",
      sampleSize: 72,
      samplingScriptSha256: digest(9_999),
    }).success).toBe(false);
  });
});

describe("ScreeningSampleCommitmentV1Schema and ScreeningTableV2Schema", () => {
  test("freeze a sorted 72-item public sample and a sorted 664-row signed payload", () => {
    const poolValue = ScreeningPoolV1Schema.parse(pool());
    const sample = computeScreeningSample({ itemSha256s: poolValue.items.map((item) => item.itemSha256), sampleSeed: "public-seed", sampleSize: 72 });
    const commitment = ScreeningSampleCommitmentV1Schema.parse({
      protocol: SCREENING_SAMPLE_COMMITMENT_PROTOCOL,
      draftId: DRAFT_ID,
      poolSha256: digest(902),
      poolIdentityCommitmentSha256: poolValue.identityCommitmentSha256,
      samplingProcedure: "screening-sample/1",
      sampleSeed: "public-seed",
      sampleSize: 72,
      sampleItemSha256s: [...sample.sample].sort(),
      committedAt: SEALED_AT,
    });
    const sampled = new Set(commitment.sampleItemSha256s);
    const rows = poolValue.items.map((item) => ({
      itemSha256: item.itemSha256,
      intendedLabel: item.intendedLabel,
      screeningVerdict: item.intendedLabel,
      ritsuDecision: sampled.has(item.itemSha256)
        ? { checked: true as const, verdict: "confirm" as const, decidedAt: SEALED_AT }
        : { checked: false as const },
    })).sort((left, right) => left.itemSha256.localeCompare(right.itemSha256));
    expect(ScreeningTableV2Schema.parse({
      protocol: SCREENING_TABLE_V2_PROTOCOL,
      draftId: DRAFT_ID,
      procedureSha256: digest(903),
      coordinatorPromptSha256: digest(900),
      poolSha256: digest(902),
      sampleCommitmentSha256: digest(904),
      samplingScriptSha256: digest(905),
      transcriptSha256: digest(901),
      operator: "Ritsu",
      rows,
      sealedAt: SEALED_AT,
    }).rows).toHaveLength(664);
    expect(ScreeningTableV2Schema.safeParse({
      protocol: SCREENING_TABLE_V2_PROTOCOL,
      draftId: DRAFT_ID,
      procedureSha256: digest(903),
      coordinatorPromptSha256: digest(900),
      poolSha256: digest(902),
      sampleCommitmentSha256: digest(904),
      samplingScriptSha256: digest(905),
      transcriptSha256: digest(901),
      operator: "Ritsu",
      rows: rows.slice(1),
      sealedAt: SEALED_AT,
    }).success).toBe(false);
    expect(ScreeningTableV2Schema.safeParse({
      protocol: SCREENING_TABLE_V2_PROTOCOL,
      draftId: DRAFT_ID,
      procedureSha256: digest(903),
      coordinatorPromptSha256: digest(900),
      poolSha256: digest(902),
      sampleCommitmentSha256: digest(904),
      samplingScriptSha256: digest(905),
      transcriptSha256: digest(901),
      operator: "Ritsu",
      rows: rows.with(0, rows[1]!).with(1, rows[0]!),
      sealedAt: SEALED_AT,
    }).success).toBe(false);
  });
});
