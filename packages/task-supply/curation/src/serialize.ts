import { CurationInputError, parseCurationRows } from "./schema.js";
import type { CurationProjection, CurationRow } from "./projection.js";

/**
 * The wire token of this package's serialized derived state. Deliberately NOT a record-kind
 * IRI in the protocol's records namespace: a curation projection is not a record kind, has no
 * sealed bytes, no digest identity, and no signature. It is host-stored state that anyone can
 * throw away and re-derive from the announcements listed in every row's `inputRefs`.
 */
export const CURATION_PROJECTION_FORMAT = "network.jinn.task-supply.curation-projection/1.0";

// Explicit key order everywhere: the serialization is byte-stable so two hosts folding the
// same announcements can compare their stored state directly. No key here is integer-like,
// so insertion order is what `JSON.stringify` emits.
function rowToJson(row: CurationRow): Record<string, unknown> {
  return {
    taskDigest: row.taskDigest,
    bucket: row.bucket,
    attempts: row.attempts,
    verdicts: row.verdicts,
    passRate: { num: row.passRate.num, den: row.passRate.den },
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

export function serializeCurationProjection(projection: CurationProjection): string {
  return JSON.stringify({
    format: CURATION_PROJECTION_FORMAT,
    rows: projection.rows.map(rowToJson),
  });
}

/**
 * Reads stored state back. The document is untrusted input and is validated exactly as
 * strictly as an observation: digest form, bucket membership, instants, ref shape, dedupe-key
 * uniqueness, and every counter against `inputRefs`. Rows are RECONSTRUCTED, never passed
 * through, so nothing a foreign writer added rides along into the next fold.
 */
export function parseCurationProjection(text: string): CurationProjection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CurationInputError("stored curation projection is not JSON", { cause });
  }
  const document = parsed as { format?: unknown; rows?: unknown };
  if (document?.format !== CURATION_PROJECTION_FORMAT) {
    throw new CurationInputError(
      `unexpected curation projection format: ${String(document?.format)}`,
    );
  }
  if (!Array.isArray(document.rows)) {
    throw new CurationInputError("stored curation projection has no rows array");
  }
  return { rows: parseCurationRows(document.rows) };
}
