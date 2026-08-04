import { PolicyOutcomesInputError, parsePolicyOutcomesRows } from "./schema.js";
import type { PolicyOutcomesProjection, PolicyOutcomesRow } from "./projection.js";

/**
 * The wire token of this package's serialized derived state (substrate §6.2). Deliberately NOT a
 * record-kind IRI in the protocol's records namespace: a policy-outcomes projection is not a
 * record kind, has no sealed bytes, no digest identity, and no signature. It is host-stored state
 * that anyone can throw away and re-derive from the announcements listed in every row's
 * `inputRefs`.
 */
export const POLICY_OUTCOMES_PROJECTION_FORMAT = "network.jinn.policy.outcomes-projection/1.0";

// Explicit key order everywhere: the serialization is byte-stable so two hosts folding the same
// announcements can compare their stored state directly.
function rowToJson(row: PolicyOutcomesRow): Record<string, unknown> {
  return {
    tupleDigest: row.tupleDigest,
    axes: row.axes,
    bucket: row.bucket,
    attempts: row.attempts,
    verdicts: row.verdicts,
    passRate: { num: row.passRate.num, den: row.passRate.den },
    pinning: {
      harness: { ...row.pinning.harness },
      model: { ...row.pinning.model },
      loadout: { ...row.pinning.loadout },
      isolationPolicy: { ...row.pinning.isolationPolicy },
    },
    window: { first: row.window.first, last: row.window.last },
    inputRefs: row.inputRefs.map((ref) => ({
      source: { agent: ref.source.agent, name: ref.source.name },
      entry: ref.entry,
      announcementId: ref.announcementId,
      record: ref.record,
      attemptUri: ref.attemptUri,
    })),
  };
}

export function serializePolicyOutcomesProjection(projection: PolicyOutcomesProjection): string {
  return JSON.stringify({
    format: POLICY_OUTCOMES_PROJECTION_FORMAT,
    rows: projection.rows.map(rowToJson),
  });
}

/**
 * Reads stored state back. The document is untrusted input and is validated exactly as strictly
 * as an observation. Rows are RECONSTRUCTED, never passed through, so nothing a foreign writer
 * added rides along into the next fold.
 */
export function parsePolicyOutcomesProjection(text: string): PolicyOutcomesProjection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new PolicyOutcomesInputError("stored policy outcomes projection is not JSON", { cause });
  }
  const document = parsed as { format?: unknown; rows?: unknown };
  if (document?.format !== POLICY_OUTCOMES_PROJECTION_FORMAT) {
    throw new PolicyOutcomesInputError(
      `unexpected policy outcomes projection format: ${String(document?.format)}`,
    );
  }
  if (!Array.isArray(document.rows)) {
    throw new PolicyOutcomesInputError("stored policy outcomes projection has no rows array");
  }
  return { rows: parsePolicyOutcomesRows(document.rows) };
}
