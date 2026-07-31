import { z } from "zod";
import type { CurationInputRef, Sha256Digest } from "./observation.js";
import type { CurationBucket, CurationRow } from "./projection.js";

/**
 * Internal validation primitives shared by the two input boundaries of this package: the
 * observation boundary (`parseCurationObservation`) and the stored-projection boundary
 * (`parseCurationProjection`, and `foldCuration`'s `previous` argument). Both are validated
 * with the same rigor, so a stored row cannot launder a shape an observation would be refused
 * for. Nothing here is re-exported from `src/index.ts`: these are not part of the public
 * surface, and the zod schemas in particular must not become one.
 *
 * This module imports only types from its siblings, so it introduces no runtime import cycle.
 */

/** Thrown on any malformed input. This package fails closed and never guesses. */
export class CurationInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CurationInputError";
  }
}

/**
 * The unit separator the dedupe key joins on (U+001F), built from its code point so no raw
 * control byte appears in source.
 */
export const KEY_SEPARATOR = String.fromCharCode(0x1f);

/**
 * C0 controls and DEL. They are refused in every free-text field, because the dedupe key is a
 * separator-joined string: a component carrying the separator re-partitions the key, which is
 * how one source would forge a collision with another source's ref and suppress its verdict.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Non-empty text with no control character — the only shape a key component may take. */
export const FreeTextSchema = z
  .string()
  .min(1)
  .refine((value) => !hasControlCharacter(value), "must not contain control characters");

export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** RFC 3339 date-time with a mandatory offset (`Z` or +/-HH:MM). */
export const InstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => !Number.isNaN(Date.parse(value)), "is not a real instant");

export const CurationInputRefSchema = z.object({
  source: z.object({ agent: FreeTextSchema, name: FreeTextSchema }),
  entry: Sha256DigestSchema,
  announcementId: FreeTextSchema,
  record: Sha256DigestSchema,
  attemptUri: FreeTextSchema,
});

const CountSchema = z.number().int().nonnegative();

const CurationRowSchema = z.strictObject({
  taskDigest: Sha256DigestSchema,
  bucket: z.enum(["benchmark", "organic"]),
  attempts: CountSchema,
  verdicts: CountSchema,
  passRate: z.strictObject({ num: CountSchema, den: CountSchema }),
  window: z.strictObject({ first: InstantSchema, last: InstantSchema }),
  inputRefs: z.array(CurationInputRefSchema),
});

export function issueText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

/**
 * The at-least-once dedupe key of the discovery subscribe plane — the same
 * `(source agent, source name, entry digest, announcementId)` tuple as `announcementDedupeKey`
 * in `packages/discovery/protocol/src/cloudevents.ts`. Refuses to key a ref whose components
 * carry the separator, so two distinct refs can never be made to key alike.
 */
export function refDedupeKey(ref: CurationInputRef): string {
  const components = [ref.source.agent, ref.source.name, ref.entry, ref.announcementId];
  for (const component of components) {
    if (typeof component !== "string" || component.length === 0 || hasControlCharacter(component)) {
      throw new CurationInputError(
        "input ref key components must be non-empty text with no control characters",
      );
    }
  }
  return components.join(KEY_SEPARATOR);
}

/** `Date.parse` is the one time primitive in this package, and it is pure. */
export function instantValue(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new CurationInputError(`observedAt is not an RFC 3339 instant: ${value}`);
  }
  return parsed;
}

export function curationRowKey(taskDigest: string, bucket: CurationBucket): string {
  return `${taskDigest}${KEY_SEPARATOR}${bucket}`;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Reconstructs one row from stored state, rejecting anything the projector cannot emit. */
function parseCurationRow(value: unknown, index: number): CurationRow {
  const result = CurationRowSchema.safeParse(value);
  if (!result.success) {
    throw new CurationInputError(`row ${index}: ${issueText(result.error)}`, {
      cause: result.error,
    });
  }
  const parsed = result.data;
  const inputRefs = [...parsed.inputRefs]
    .map((ref) => ({
      source: { agent: ref.source.agent, name: ref.source.name },
      entry: ref.entry as Sha256Digest,
      announcementId: ref.announcementId,
      record: ref.record as Sha256Digest,
      attemptUri: ref.attemptUri,
    }))
    .sort((a, b) => compareKeys(refDedupeKey(a), refDedupeKey(b)));

  if (new Set(inputRefs.map(refDedupeKey)).size !== inputRefs.length) {
    throw new CurationInputError(`row ${index}: inputRefs repeat one announcement dedupe key`);
  }
  if (inputRefs.length !== parsed.verdicts) {
    throw new CurationInputError(
      `row ${index}: verdicts (${parsed.verdicts}) does not match inputRefs (${inputRefs.length})`,
    );
  }
  if (new Set(inputRefs.map((ref) => ref.attemptUri)).size !== parsed.attempts) {
    throw new CurationInputError(
      `row ${index}: attempts does not match distinct inputRefs attempts`,
    );
  }
  if (parsed.passRate.den > parsed.verdicts || parsed.passRate.num > parsed.passRate.den) {
    throw new CurationInputError(`row ${index}: passRate is not a sub-count of verdicts`);
  }
  if (instantValue(parsed.window.first) > instantValue(parsed.window.last)) {
    throw new CurationInputError(`row ${index}: window is not ordered first before last`);
  }

  return {
    taskDigest: parsed.taskDigest as Sha256Digest,
    bucket: parsed.bucket,
    attempts: parsed.attempts,
    verdicts: parsed.verdicts,
    passRate: { num: parsed.passRate.num, den: parsed.passRate.den },
    window: { first: parsed.window.first, last: parsed.window.last },
    inputRefs,
  };
}

/**
 * Reconstructs the rows of a stored projection: every row validated, every row canonically
 * ordered, one `(task, bucket)` per row, and one announcement feeding at most one row. A
 * projection that fails any of these is refused rather than folded forward — a row whose
 * counters outrun its `inputRefs` is a rate with no attribution-preserving inputs behind it,
 * which is precisely what design F6 forbids this package to publish.
 */
export function parseCurationRows(value: unknown): CurationRow[] {
  if (!Array.isArray(value)) {
    throw new CurationInputError("curation projection has no rows array");
  }
  const rows = value.map((row, index) => parseCurationRow(row, index));
  const seenRowKeys = new Set<string>();
  const seenRefKeys = new Set<string>();
  for (const row of rows) {
    const key = curationRowKey(row.taskDigest, row.bucket);
    if (seenRowKeys.has(key)) {
      throw new CurationInputError(
        `duplicate row for task ${row.taskDigest} in bucket ${row.bucket}`,
      );
    }
    seenRowKeys.add(key);
    for (const ref of row.inputRefs) {
      const refKey = refDedupeKey(ref);
      if (seenRefKeys.has(refKey)) {
        throw new CurationInputError(
          `announcement ${ref.announcementId} feeds more than one row`,
        );
      }
      seenRefKeys.add(refKey);
    }
  }
  return rows.sort((a, b) =>
    compareKeys(curationRowKey(a.taskDigest, a.bucket), curationRowKey(b.taskDigest, b.bucket)),
  );
}
