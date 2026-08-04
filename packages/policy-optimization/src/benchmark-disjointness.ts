// SPDX-License-Identifier: MIT

/**
 * Development and promotion Benchmarks must share **no item** (review disposition M4).
 *
 * F-C7a-3 already refused the degenerate case — a campaign whose `promotionBenchmark` *equals* its
 * `developmentBenchmark` — on the reasoning that "a dev wave reveals every item it runs". That
 * reasoning does not stop at whole-document equality: it is a statement about **items**. Two
 * distinct Benchmark records that happen to share one Task contaminate the gate for exactly that
 * Task, and the campaign's promotion claim then rests partly on a problem every candidate was
 * tuned against. Digest inequality is not disjointness, and nothing else in the stack checks it —
 * `checkRevealConsistency` verifies commitments, not overlap with some other slate.
 *
 * Authority: coordinator ruling on review finding M4. The product design's dated item-disjointness
 * amendment (PR #2371) had **not** landed on `integration/evidence-v1` when this shipped, so the
 * citation here is the ruling and §6.3's own contamination rationale, not a spec line. If the
 * amendment lands later, this module's doc comment is the one place to update.
 *
 * Checked at both gates, deliberately:
 *
 * - **Campaign sealing**, when the sealer holds the bytes. It cannot always: the document carries
 *   digests, so the check is uncomputable from it alone (the same shape as §5.1's seed check, which
 *   takes the seed referents beside the document). Supplying them is therefore optional there.
 * - **`DRAFT → EXPLORING`**, always. That gate already demands the promotion Benchmark's exact
 *   bytes, it is the moment before a campaign spends, and the journal will not record the
 *   transition without it — so this is where the property is actually closed rather than merely
 *   offered.
 */

import {
  documentDigest,
  itemTaskDigest,
  parseBenchmark,
  type BenchmarkRecord,
} from "@jinn-network/benchmarking-records";
import { compareCodeUnitStrings } from "@jinn-network/policy-identity";

/** The two slates' exact sealed bytes — the referents the digests in the document name. */
export interface CampaignBenchmarkBytes {
  readonly development: Uint8Array;
  readonly promotion: Uint8Array;
}

export type BenchmarkDisjointnessResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly reason: "digest-mismatch" | "invalid-benchmark" | "shared-items";
    readonly detail: string;
    /** The offending Task digests, sorted. Empty unless `reason` is `shared-items`. */
    readonly shared: readonly string[];
  };

function parse(
  bytes: Uint8Array,
  label: string,
): { record: BenchmarkRecord } | { detail: string } {
  try {
    return { record: parseBenchmark(bytes) };
  } catch (cause) {
    return {
      detail: `${label} Benchmark bytes do not parse: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/**
 * Do the campaign's two slates share an item?
 *
 * Both digests are verified against the supplied bytes first. Without that, a caller could hand
 * over two unrelated (and genuinely disjoint) benchmarks and collect a pass for the pair the
 * campaign actually names — the same substitution the seed check re-digests to rule out.
 */
export function checkBenchmarkDisjointness(
  target: { readonly developmentBenchmark: string; readonly promotionBenchmark: string },
  bytes: CampaignBenchmarkBytes,
): BenchmarkDisjointnessResult {
  const developmentDigest = documentDigest(bytes.development);
  if (developmentDigest !== target.developmentBenchmark) {
    return {
      ok: false,
      reason: "digest-mismatch",
      detail: `supplied development bytes digest to ${developmentDigest}, campaign names ${target.developmentBenchmark}`,
      shared: [],
    };
  }
  const promotionDigest = documentDigest(bytes.promotion);
  if (promotionDigest !== target.promotionBenchmark) {
    return {
      ok: false,
      reason: "digest-mismatch",
      detail: `supplied promotion bytes digest to ${promotionDigest}, campaign names ${target.promotionBenchmark}`,
      shared: [],
    };
  }

  const development = parse(bytes.development, "development");
  if (!("record" in development)) {
    return { ok: false, reason: "invalid-benchmark", detail: development.detail, shared: [] };
  }
  const promotion = parse(bytes.promotion, "promotion");
  if (!("record" in promotion)) {
    return { ok: false, reason: "invalid-benchmark", detail: promotion.detail, shared: [] };
  }

  const developmentItems = new Set(development.record.items.map(itemTaskDigest));
  const shared = [...new Set(
    promotion.record.items.map(itemTaskDigest).filter((digest) => developmentItems.has(digest)),
  )].sort(compareCodeUnitStrings);
  if (shared.length > 0) {
    return {
      ok: false,
      reason: "shared-items",
      detail: `${shared.length} Task(s) appear in both the development slate and the promotion gate: ${shared.join(", ")}`,
      shared,
    };
  }
  return { ok: true };
}
