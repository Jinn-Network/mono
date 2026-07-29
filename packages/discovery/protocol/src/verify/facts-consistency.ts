import type { FactsProfileDocument } from "../facts-profile.js";
import type { AnnouncedItem } from "../item.js";
import type {
  FactsRecompute,
  RecordFactScalar,
  RecordFactValue,
  ReferencedBytes,
  RecordFetcher,
} from "./ports.js";
import type { FactsConsistency } from "./outcomes.js";

function isRecordFactScalar(value: unknown): value is RecordFactScalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Exact facts-consistency equality (program §7.129): scalars use `===`;
 * arrays compare by exact length and element value in record order.
 */
export function recordFactValuesEqual(
  recomputed: Exclude<RecordFactValue, undefined>,
  announced: unknown,
): boolean {
  if (Array.isArray(recomputed)) {
    if (!Array.isArray(announced) || announced.length !== recomputed.length) return false;
    for (let i = 0; i < recomputed.length; i++) {
      if (!isRecordFactScalar(announced[i]) || announced[i] !== recomputed[i]) return false;
    }
    return true;
  }
  return recomputed === announced;
}

// Named check: facts-consistency (design §5.4, §10.4 step 2, program §7.13).
// Recomputes each RECORD-classed fact from the record's own fetched bytes
// (plus, for fields the profile marks reference-bearing = false, bytes the
// record itself references) via the injected per-kind FactsRecompute
// registry, and compares field-by-field against the announced facts card.
// `FactsProfileDocument` supplies only the declarative field labeling; the
// leaf-exported recompute fn supplies the imperative bytes->values
// extraction the card alone cannot express.

/**
 * Wraps `records` (the same port `verifyItem` uses to `fetch` the item's own
 * record) as a `ReferencedBytes` source for recompute functions that need a
 * *different* record's bytes (e.g. a Submission's task-derived fields). A
 * `fetch` failure -- the referenced bytes are unavailable or capability-gated
 * to this consumer -- becomes `undefined`, driving `indeterminate` (§5.4).
 */
function referencedBytesFrom(records: RecordFetcher): ReferencedBytes {
  return {
    async "fetch"(digest) {
      try {
        return await records.fetch(digest);
      } catch {
        return undefined;
      }
    },
  };
}

export async function factsConsistency(params: {
  item: AnnouncedItem;
  profile: FactsProfileDocument | undefined;
  recordBytes: Uint8Array;
  factsRecompute: FactsRecompute;
  records: RecordFetcher;
}): Promise<FactsConsistency> {
  const { item, profile, recordBytes, factsRecompute, records } = params;

  // Without a facts profile there is no declarative schema to check the
  // announced card against -- nothing was attempted, so nothing is flagged.
  // This differs from a KNOWN kind whose registry has no recompute fn
  // (below), which fails closed to `indeterminate` per plan Task 13 Step 2
  // ("never silently consistent") -- that case presupposes a profile (and
  // therefore a kind) is already in play.
  if (profile === undefined) return "consistent";

  const card = (item.facts ?? {}) as Record<string, unknown>;

  // §5.4 rule 2: substrate facts are projection-only; an author-source item
  // (no derivation annotation, §6.2) carrying a substrate-classed field in
  // its facts card is a signed false statement.
  const isAuthorSource = item.provenance.derivation === undefined;
  for (const field of profile.fields) {
    if (
      field.class === "substrate"
      && isAuthorSource
      && Object.prototype.hasOwnProperty.call(card, field.name)
    ) {
      return "inconsistent";
    }
  }

  const recompute = factsRecompute.get(item.record.kind);
  if (recompute === undefined) return "indeterminate"; // never silently consistent

  const refs = referencedBytesFrom(records);
  const recomputed = await recompute(recordBytes, refs);

  for (const field of profile.fields) {
    if (field.class !== "record") continue; // substrate facts are never record-recomputable
    if (!Object.prototype.hasOwnProperty.call(card, field.name)) continue; // not announced -- nothing to check (§15/§18 unknown-field skip is symmetric: extra card fields the profile doesn't name are likewise never visited)
    const recomputedValue = recomputed[field.name];
    if (recomputedValue === undefined) return "indeterminate";
    if (!recordFactValuesEqual(recomputedValue, card[field.name])) return "inconsistent";
  }
  return "consistent";
}
