// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "@jinn-network/task-execution-profiles";
import {
  SCREENING_POOL_V2_PROTOCOL,
  type PromptedScreeningRowV2,
  type ScreeningPool,
  type ScreeningPoolV1,
  type ScreeningPoolV2,
} from "./contracts.js";

type PoolItem = ScreeningPool["items"][number];
type MainItem = Extract<PoolItem, { poolKind: "main" }>;
type ReserveItem = Extract<PoolItem, { poolKind: "reserve" }>;

export interface PromptedScreeningReplacement {
  readonly excludedMain: MainItem;
  readonly replacement: ReserveItem;
  readonly receivingSlotId: string;
}

export interface PromptedScreeningSelection {
  readonly winners: readonly PoolItem[];
  readonly replacements: readonly PromptedScreeningReplacement[];
  readonly participatingItemSha256s: ReadonlySet<string>;
}

export class PromptedScreeningSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptedScreeningSelectionError";
  }
}

function admitted(row: PromptedScreeningRowV2): boolean {
  const agreed = row.screeningVerdict !== "UNSURE" && row.screeningVerdict === row.intendedLabel;
  return row.ritsuDecision.checked ? row.ritsuDecision.verdict === "confirm" : agreed;
}

function v1Selection(pool: ScreeningPoolV1, rows: ReadonlyMap<string, PromptedScreeningRowV2>): PromptedScreeningSelection {
  const winners: PoolItem[] = [];
  const replacements: PromptedScreeningReplacement[] = [];
  const participating = new Set<string>();
  const slotIds = [...new Set(pool.items.map((item) => item.slotId))].sort(compareCodeUnitStrings);
  for (const slotId of slotIds) {
    const slotItems = pool.items.filter((item) => item.slotId === slotId);
    const main = slotItems.find((item): item is Extract<ScreeningPoolV1["items"][number], { poolKind: "main" }> => item.poolKind === "main")!;
    const reserves = slotItems
      .filter((item): item is Extract<ScreeningPoolV1["items"][number], { poolKind: "reserve" }> => item.poolKind === "reserve")
      .sort((left, right) => left.reserveOrder - right.reserveOrder);
    const winner = [main, ...reserves].find((item) => admitted(rows.get(item.itemSha256)!));
    if (winner === undefined) throw new PromptedScreeningSelectionError(`${slotId} has no admissible main or reserve candidate`);
    winners.push(winner);
    participating.add(winner.itemSha256);
    if (winner.poolKind === "reserve") {
      participating.add(main.itemSha256);
      replacements.push({ excludedMain: main, replacement: winner, receivingSlotId: slotId });
    }
  }
  return { winners, replacements, participatingItemSha256s: participating };
}

function v2Selection(pool: ScreeningPoolV2, rows: ReadonlyMap<string, PromptedScreeningRowV2>): PromptedScreeningSelection {
  const mains = pool.items
    .filter((item): item is Extract<ScreeningPoolV2["items"][number], { poolKind: "main" }> => item.poolKind === "main")
    .sort((left, right) => compareCodeUnitStrings(left.slotId, right.slotId));
  const winners: PoolItem[] = [];
  const replacements: PromptedScreeningReplacement[] = [];
  const participating = new Set<string>();
  const activeLineages = new Set<string>();

  for (const main of mains) {
    if (!admitted(rows.get(main.itemSha256)!)) continue;
    if (activeLineages.has(main.sourceQuestionLineageId)) {
      throw new PromptedScreeningSelectionError(`admitted mains duplicate source-question lineage ${main.sourceQuestionLineageId}`);
    }
    activeLineages.add(main.sourceQuestionLineageId);
    winners.push(main);
    participating.add(main.itemSha256);
  }

  for (const main of mains) {
    if (admitted(rows.get(main.itemSha256)!)) continue;
    const reserves = pool.items
      .filter((item): item is Extract<ScreeningPoolV2["items"][number], { poolKind: "reserve" }> => item.poolKind === "reserve"
        && item.candidateClass === main.candidateClass
        && item.stratum === main.stratum)
      .sort((left, right) => left.reserveOrder - right.reserveOrder);
    const replacement = reserves.find((reserve) => admitted(rows.get(reserve.itemSha256)!)
      && !activeLineages.has(reserve.sourceQuestionLineageId));
    if (replacement === undefined) {
      throw new PromptedScreeningSelectionError(`${main.slotId} has no admissible unused-lineage reserve in ${main.candidateClass}/${main.stratum}`);
    }
    activeLineages.add(replacement.sourceQuestionLineageId);
    winners.push(replacement);
    participating.add(main.itemSha256);
    participating.add(replacement.itemSha256);
    replacements.push({ excludedMain: main, replacement, receivingSlotId: main.slotId });
  }

  return {
    winners: winners.sort((left, right) => left.poolPosition - right.poolPosition),
    replacements,
    participatingItemSha256s: participating,
  };
}

/** Deterministic prompted-screening winner selection shared by the producer and portable replay. */
export function selectPromptedScreeningPool(
  pool: ScreeningPool,
  rows: ReadonlyMap<string, PromptedScreeningRowV2>,
): PromptedScreeningSelection {
  return pool.protocol === SCREENING_POOL_V2_PROTOCOL
    ? v2Selection(pool, rows)
    : v1Selection(pool, rows);
}
