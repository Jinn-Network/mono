import { z } from "zod";
import type { PolicyOutcomeInputRef } from "./observation.js";
import type { PolicyOutcomesBucket, PolicyOutcomesRow } from "./projection.js";

/**
 * Internal validation primitives shared by the two input boundaries of this package: the
 * observation boundary (`parsePolicyOutcomeObservation`) and the stored-projection boundary
 * (`parsePolicyOutcomesProjection`, and `foldPolicyOutcomes`'s `previous` argument). Both are
 * validated with the same rigor, so a stored row cannot launder a shape an observation would be
 * refused for (mirrors `@jinn-network/task-curation`'s `schema.ts`).
 *
 * This module imports only types from its siblings, so it introduces no runtime import cycle.
 * Nothing here is re-exported from `src/index.ts`.
 */

/** Thrown on any malformed input. This package fails closed and never guesses. */
export class PolicyOutcomesInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PolicyOutcomesInputError";
  }
}

/**
 * The unit separator the dedupe key joins on (U+001F), built from its code point so no raw
 * control byte appears in source.
 */
export const KEY_SEPARATOR = String.fromCharCode(0x1f);

/**
 * C0 controls and DEL. Refused in every free-text field, because the dedupe key is a
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

/** Non-empty text with no control character -- the only shape a key component may take. */
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

export const PolicyOutcomeInputRefSchema = z.object({
  source: z.object({ agent: FreeTextSchema, name: FreeTextSchema }),
  entry: Sha256DigestSchema,
  announcementId: FreeTextSchema,
  record: Sha256DigestSchema,
  attemptUri: FreeTextSchema,
});

/** Substrate §7 -- the per-axis treatment-fidelity tri-state (vocabulary mirrored from `@jinn-network/policy-identity`'s `AxisFidelityStatus`). */
export const AxisFidelityStatusSchema = z.enum(["match", "mismatch", "unverifiable"]);

export const PerAxisStatusSchema = z.strictObject({
  harness: AxisFidelityStatusSchema,
  model: AxisFidelityStatusSchema,
  loadout: AxisFidelityStatusSchema,
  isolationPolicy: AxisFidelityStatusSchema,
});

const CountSchema = z.number().int().nonnegative();

const PinningCountsSchema = z.strictObject({
  match: CountSchema,
  mismatch: CountSchema,
  unverifiable: CountSchema,
});

const AxesSchema = z.record(z.string(), z.unknown());

const PolicyOutcomesRowSchema = z.strictObject({
  tupleDigest: Sha256DigestSchema,
  axes: AxesSchema,
  bucket: z.enum(["benchmark", "organic"]),
  attempts: CountSchema,
  verdicts: CountSchema,
  passRate: z.strictObject({ num: CountSchema, den: CountSchema }),
  pinning: z.strictObject({
    harness: PinningCountsSchema,
    model: PinningCountsSchema,
    loadout: PinningCountsSchema,
    isolationPolicy: PinningCountsSchema,
  }),
  window: z.strictObject({ first: InstantSchema, last: InstantSchema }),
  inputRefs: z.array(PolicyOutcomeInputRefSchema),
});

export function issueText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

/**
 * The at-least-once dedupe key of the discovery subscribe plane -- the same
 * `(source agent, source name, entry digest, announcementId)` tuple as `announcementDedupeKey`
 * in `packages/discovery/protocol/src/cloudevents.ts`, identical to curation's `refDedupeKey`.
 * Refuses to key a ref whose components carry the separator, so two distinct refs can never be
 * made to key alike.
 */
export function refDedupeKey(ref: PolicyOutcomeInputRef): string {
  const components = [ref.source.agent, ref.source.name, ref.entry, ref.announcementId];
  for (const component of components) {
    if (typeof component !== "string" || component.length === 0 || hasControlCharacter(component)) {
      throw new PolicyOutcomesInputError(
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
    throw new PolicyOutcomesInputError(`observedAt is not an RFC 3339 instant: ${value}`);
  }
  return parsed;
}

export function policyOutcomesRowKey(tupleDigest: string, bucket: PolicyOutcomesBucket): string {
  return `${tupleDigest}${KEY_SEPARATOR}${bucket}`;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const PINNING_AXES = ["harness", "model", "loadout", "isolationPolicy"] as const;

/** Reconstructs one row from stored state, rejecting anything the projector cannot emit. */
function parsePolicyOutcomesRow(value: unknown, index: number): PolicyOutcomesRow {
  const result = PolicyOutcomesRowSchema.safeParse(value);
  if (!result.success) {
    throw new PolicyOutcomesInputError(`row ${index}: ${issueText(result.error)}`, {
      cause: result.error,
    });
  }
  const parsed = result.data;
  const inputRefs = [...parsed.inputRefs]
    .map((ref) => ({
      source: { agent: ref.source.agent, name: ref.source.name },
      entry: ref.entry as PolicyOutcomeInputRef["entry"],
      announcementId: ref.announcementId,
      record: ref.record as PolicyOutcomeInputRef["record"],
      attemptUri: ref.attemptUri,
    }))
    .sort((a, b) => compareKeys(refDedupeKey(a), refDedupeKey(b)));

  if (new Set(inputRefs.map(refDedupeKey)).size !== inputRefs.length) {
    throw new PolicyOutcomesInputError(`row ${index}: inputRefs repeat one announcement dedupe key`);
  }
  if (inputRefs.length !== parsed.verdicts) {
    throw new PolicyOutcomesInputError(
      `row ${index}: verdicts (${parsed.verdicts}) does not match inputRefs (${inputRefs.length})`,
    );
  }
  if (new Set(inputRefs.map((ref) => ref.attemptUri)).size !== parsed.attempts) {
    throw new PolicyOutcomesInputError(
      `row ${index}: attempts does not match distinct inputRefs attempts`,
    );
  }
  if (parsed.passRate.den > parsed.verdicts || parsed.passRate.num > parsed.passRate.den) {
    throw new PolicyOutcomesInputError(`row ${index}: passRate is not a sub-count of verdicts`);
  }
  if (instantValue(parsed.window.first) > instantValue(parsed.window.last)) {
    throw new PolicyOutcomesInputError(`row ${index}: window is not ordered first before last`);
  }
  for (const axis of PINNING_AXES) {
    const counts = parsed.pinning[axis];
    if (counts.match + counts.mismatch + counts.unverifiable !== parsed.verdicts) {
      throw new PolicyOutcomesInputError(
        `row ${index}: pinning.${axis} counters (${counts.match}+${counts.mismatch}+${counts.unverifiable}) do not sum to verdicts (${parsed.verdicts})`,
      );
    }
  }
  if (Object.hasOwn(parsed.axes, "formatToken")) {
    throw new PolicyOutcomesInputError(`row ${index}: axes must not carry formatToken (document metadata, not an axis)`);
  }

  return {
    tupleDigest: parsed.tupleDigest as PolicyOutcomesRow["tupleDigest"],
    axes: parsed.axes as PolicyOutcomesRow["axes"],
    bucket: parsed.bucket,
    attempts: parsed.attempts,
    verdicts: parsed.verdicts,
    passRate: { num: parsed.passRate.num, den: parsed.passRate.den },
    pinning: {
      harness: { ...parsed.pinning.harness },
      model: { ...parsed.pinning.model },
      loadout: { ...parsed.pinning.loadout },
      isolationPolicy: { ...parsed.pinning.isolationPolicy },
    },
    window: { first: parsed.window.first, last: parsed.window.last },
    inputRefs,
  };
}

/**
 * Reconstructs the rows of a stored projection: every row validated, every row canonically
 * ordered, one `(tupleDigest, bucket)` per row, and one announcement feeding at most one row.
 */
export function parsePolicyOutcomesRows(value: unknown): PolicyOutcomesRow[] {
  if (!Array.isArray(value)) {
    throw new PolicyOutcomesInputError("policy outcomes projection has no rows array");
  }
  const rows = value.map((row, index) => parsePolicyOutcomesRow(row, index));
  const seenRowKeys = new Set<string>();
  const seenRefKeys = new Set<string>();
  for (const row of rows) {
    const key = policyOutcomesRowKey(row.tupleDigest, row.bucket);
    if (seenRowKeys.has(key)) {
      throw new PolicyOutcomesInputError(
        `duplicate row for tuple ${row.tupleDigest} in bucket ${row.bucket}`,
      );
    }
    seenRowKeys.add(key);
    for (const ref of row.inputRefs) {
      const refKey = refDedupeKey(ref);
      if (seenRefKeys.has(refKey)) {
        throw new PolicyOutcomesInputError(
          `announcement ${ref.announcementId} feeds more than one row`,
        );
      }
      seenRefKeys.add(refKey);
    }
  }
  return rows.sort((a, b) =>
    compareKeys(
      policyOutcomesRowKey(a.tupleDigest, a.bucket),
      policyOutcomesRowKey(b.tupleDigest, b.bucket),
    ),
  );
}
