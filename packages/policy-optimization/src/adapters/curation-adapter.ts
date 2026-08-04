// SPDX-License-Identifier: MIT

/**
 * The curation adapter (product §8.2 item 1; program §1 C8).
 *
 * Discharges the tier-4 obligation `@jinn-network/task-curation`'s README defers: "a named
 * tier-4 product must first supply verified subject, verdict, evaluator, time, attempt,
 * provenance, and judged-solution benchmark joins with a fail-closed conflict policy." This
 * module IS that supply — `curateAnnouncements` performs exactly the seven joins the curation
 * README's "Adapter boundary" table documents (see `./types.ts`'s module doc for the full list)
 * and fails closed on conflict rather than guessing.
 *
 * `CurationObservation`/`CurationInputRef` below are MIRRORED from `@jinn-network/task-curation`,
 * field for field — not imported. `packages/task-supply` is outside this product's
 * source-boundary allow-list (`.github/scripts/policy-optimization-source-boundaries.test.mjs`),
 * which denies every marketplace/discovery/task-supply import so v0 consumes those layers
 * read-only through exactly these injected-port adapters (design §8.2, §11). A caller that wants
 * an actual `@jinn-network/task-curation` projection passes this adapter's `observations` output
 * straight to that package's `projectCuration`/`foldCuration` — the shapes are structurally
 * identical by construction.
 */

import {
  buildAdapterRef,
  resolveVerdictJoins,
  type AdapterInputRef,
  type AdapterRefusal,
  type AnnouncedVerdict,
  type Instant,
  type ObservedVerdict,
  type Sha256Digest,
} from "./types.js";

export type { AdapterRefusal, AnnouncedVerdict } from "./types.js";

/** Mirrors `@jinn-network/task-curation`'s `CurationInputRef` (`src/observation.ts`). */
export type CurationInputRef = AdapterInputRef;

/** Mirrors `@jinn-network/task-curation`'s `CurationObservation` (`src/observation.ts`). */
export interface CurationObservation {
  readonly taskDigest: Sha256Digest;
  readonly verdict: ObservedVerdict;
  readonly observedAt: Instant;
  readonly attribution: string;
  readonly benchmarkRun?: string;
  readonly ref: CurationInputRef;
}

export interface CurationAdapterResult {
  readonly observations: readonly CurationObservation[];
  readonly refusals: readonly AdapterRefusal[];
}

/**
 * Joins each announced verdict into a `CurationObservation`. Fail-closed: a record whose subject
 * task digest or attribution candidates disagree, or whose verdict/attribution is missing
 * outright, is refused with every failing reason named — never guessed, never silently dropped.
 * Refusals ride alongside `observations` in the same result.
 */
export function curateAnnouncements(records: readonly AnnouncedVerdict[]): CurationAdapterResult {
  const observations: CurationObservation[] = [];
  const refusals: AdapterRefusal[] = [];

  for (const record of records) {
    const joins = resolveVerdictJoins(record);
    if (!joins.ok) {
      refusals.push({ reasons: joins.reasons, provenance: record.provenance });
      continue;
    }

    observations.push({
      taskDigest: joins.value.taskDigest,
      verdict: joins.value.verdict,
      observedAt: record.entryTimestamp,
      attribution: joins.value.attribution,
      ...(record.benchmarkRun === undefined ? {} : { benchmarkRun: record.benchmarkRun }),
      ref: buildAdapterRef(record),
    });
  }

  return { observations, refusals };
}
