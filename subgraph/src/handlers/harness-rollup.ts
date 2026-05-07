/**
 * harness-rollup.ts
 *
 * Maintains HarnessRollup and LanguageRollup aggregation entities.
 *
 * Called from the identity handler's EVALUATION Execution path (i.e. whenever
 * a `kind = EVALUATION` Execution is indexed or updated).
 *
 * STUB STATUS (2026-05-07):
 * The Verdict→Solution join is not yet available. A Verdict (EVALUATION
 * Execution) carries the evaluator's own identity, not the solver's. The
 * rollup must attribute to the *solver's* (implName, codeDigest, mode), which
 * is published in the corresponding ENVELOPE Execution. The join key to link
 * them (JinnRouter requestId in the payload v2 encoding) is not yet carried
 * in on-chain events.
 *
 * Additionally, the payload v2 fields (implName, codeDigest, language, score)
 * are null for all v1 payloads — decodeExecutionPayload does not yet populate
 * them. Until payload v2 ships, all four fields are null and this handler
 * returns early without mutating any HarnessRollup or LanguageRollup rows.
 *
 * The function IS wired into the execution path (called from identity.ts after
 * saving an EVALUATION Execution) so no integration work is needed when
 * payload v2 lands — remove the early-return guard and the rollup will start
 * populating automatically.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.5
 * DR:   log/decisions/2026-05-06-aggregation-multi-winrate.md
 */

import { BigDecimal, BigInt, log } from "@graphprotocol/graph-ts";

import { Execution, HarnessRollup, LanguageRollup } from "../../generated/schema";

// 30-day window in seconds: 30 * 24 * 60 * 60
const WINDOW_SECONDS: i64 = 2592000;

/**
 * Compute the start of the 30-day window that contains `timestamp`.
 *
 *   windowStart = floor(timestamp / WINDOW_SECONDS) * WINDOW_SECONDS
 *
 * Returns 0 (as BigInt) on overflow, though in practice timestamps fit in i64.
 */
export function windowStartFor(timestamp: BigInt): BigInt {
  let ts = timestamp.toI64();
  let start = (ts / WINDOW_SECONDS) * WINDOW_SECONDS;
  return BigInt.fromI64(start);
}

/**
 * Compose the HarnessRollup entity id.
 *
 *   "<implName>|<codeDigest>|<mode>|<windowStart>"
 */
export function harnessRollupId(
  implName: string,
  codeDigest: string,
  mode: string,
  windowStart: BigInt,
): string {
  return implName + "|" + codeDigest + "|" + mode + "|" + windowStart.toString();
}

/**
 * Compose the LanguageRollup entity id.
 *
 *   "<harnessRollupId>|<language>"
 */
export function languageRollupId(parentId: string, language: string): string {
  return parentId + "|" + language;
}

/**
 * Recompute meanResolved from scoreSum / verdictCount.
 * Returns BigDecimal("0") when verdictCount is zero.
 */
function recomputeMean(scoreSum: BigInt, verdictCount: BigInt): BigDecimal {
  if (verdictCount.equals(BigInt.fromI32(0))) {
    return BigDecimal.fromString("0");
  }
  return scoreSum.toBigDecimal().div(verdictCount.toBigDecimal());
}

/**
 * updateHarnessRollup — called from the EVALUATION Execution path.
 *
 * @param exec         The EVALUATION Execution that was just indexed.
 * @param timestamp    Block timestamp (for window computation + firstSeenAt/lastSeenAt).
 * @param operatorKey  Operator.id (used as a proxy for the signing key until a
 *                     dedicated per-operator-key field is available).
 *
 * STUB: Returns immediately if exec.implName or exec.codeDigest is null,
 * which is always the case for v1 payloads. Remove this guard once payload v2
 * carries implName + codeDigest and the Verdict→Solution join is wired.
 */
export function updateHarnessRollup(
  exec: Execution,
  timestamp: BigInt,
  operatorKey: string,
): void {
  // ── STUB GUARD ────────────────────────────────────────────────────────────
  // implName and codeDigest are populated by payload v2, which has not shipped.
  // All v1 EVALUATION Executions will hit this guard and return early.
  // The handler is intentionally wired here so it activates automatically when
  // payload v2 populates these fields. See module-level comment.
  let implName = exec.implName;
  let codeDigest = exec.codeDigest;

  if (implName == null || codeDigest == null) {
    log.debug(
      "updateHarnessRollup: skipping execution {} — implName/codeDigest not yet populated (awaiting payload v2)",
      [exec.id],
    );
    return;
  }
  // ── END STUB GUARD ────────────────────────────────────────────────────────

  // Payload v2 populates score; the generated getter returns 0 when the
  // entity field is null (nullable Int → i32 with null→0 default in graph-ts).
  let scoreBigInt = BigInt.fromI32(exec.score);

  let mode = exec.mode; // "train" | "frozen"; always set (defaults to "train")
  let language = exec.language; // may be null even in v2 for non-swe-rebench tasks

  let windowStart = windowStartFor(timestamp);
  let windowEnd = windowStart.plus(BigInt.fromI64(WINDOW_SECONDS));

  let rollupId = harnessRollupId(implName as string, codeDigest as string, mode, windowStart);

  // ── Load-or-create HarnessRollup ─────────────────────────────────────────
  let rollup = HarnessRollup.load(rollupId);
  if (rollup == null) {
    rollup = new HarnessRollup(rollupId);
    rollup.implName = implName as string;
    rollup.codeDigest = codeDigest as string;
    rollup.mode = mode;
    rollup.windowStart = windowStart;
    rollup.windowEnd = windowEnd;
    rollup.verdictCount = BigInt.fromI32(0);
    rollup.scoreSum = BigInt.fromI32(0);
    rollup.meanResolved = BigDecimal.fromString("0");
    rollup.uniqueOperators = BigInt.fromI32(0);
    rollup.firstSeenAt = timestamp;
    rollup.lastSeenAt = timestamp;
  }

  // Increment verdict stats.
  rollup.verdictCount = rollup.verdictCount.plus(BigInt.fromI32(1));
  rollup.scoreSum = rollup.scoreSum.plus(scoreBigInt);
  rollup.meanResolved = recomputeMean(rollup.scoreSum, rollup.verdictCount);

  // NOTE: uniqueOperators is a simple increment here — it counts total
  // contributing executions as a proxy for distinct operators. True distinct-
  // key counting requires a Set which AssemblyScript/Graph-node does not
  // support natively in mappings. A deduplicated count requires a separate
  // entity (OperatorContribution) or a bitset approach. This is a known
  // simplification; a follow-up can replace it when the full cardinality
  // matters (typical window sizes are small enough that the approximation
  // is acceptable for v1 dashboard use).
  rollup.uniqueOperators = rollup.uniqueOperators.plus(BigInt.fromI32(1));

  rollup.lastSeenAt = timestamp;
  rollup.save();

  // ── Language sub-rollup ───────────────────────────────────────────────────
  if (language == null) {
    return; // no language data — skip LanguageRollup update
  }

  let langId = languageRollupId(rollupId, language as string);
  let langRollup = LanguageRollup.load(langId);
  if (langRollup == null) {
    langRollup = new LanguageRollup(langId);
    langRollup.parent = rollupId;
    langRollup.language = language as string;
    langRollup.verdictCount = BigInt.fromI32(0);
    langRollup.scoreSum = BigInt.fromI32(0);
    langRollup.meanResolved = BigDecimal.fromString("0");
  }

  langRollup.verdictCount = langRollup.verdictCount.plus(BigInt.fromI32(1));
  langRollup.scoreSum = langRollup.scoreSum.plus(scoreBigInt);
  langRollup.meanResolved = recomputeMean(langRollup.scoreSum, langRollup.verdictCount);
  langRollup.save();
}
