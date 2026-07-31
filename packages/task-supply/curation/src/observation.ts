import { z } from "zod";

/**
 * An RFC 3339 instant. In practice this is the Announcement Entry timestamp
 * (`packages/discovery/protocol/src/entry.ts`), which the marketplace projection source
 * fills from the deterministic block timestamp of the substrate event
 * (`packages/marketplace/projector/src/observe.ts`) -- never a wall clock. It is this
 * package's ONLY time source; there is no clock here.
 */
export type Instant = string;

export type Sha256Digest = `sha256:${string}`;

/**
 * The three-valued verdict vocabulary, as surfaced by the marketplace projection source's
 * verdict-correspondence facts card
 * ("https://jinn.network/facts/marketplace-verdict-correspondence/1.0" in
 * `packages/marketplace/projector/src/announce.ts`), which is itself the evaluator-signed
 * Result Evaluation Statement's `verdict` (task-profiles design section 9.2).
 */
export type ObservedVerdict = "pass" | "fail" | "inconclusive";

/** Thrown on any malformed input. This package fails closed and never guesses. */
export class CurationInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CurationInputError";
  }
}

/**
 * Provenance of one announced verdict, plus the attempt it judged.
 *
 * The first four fields mirror the discovery query plane's `AnnouncedItem.provenance` and
 * `record.digest` (`packages/discovery/protocol/src/item.ts`) field for field, so a caller
 * can hand one straight in; they are mirrored rather than imported to keep this package
 * dependency-free (see the plan's Finding FC6-1 and the drift guard).
 *
 * `attemptUri` is the Delivery facts card's `attemptUri`
 * (`packages/discovery/facts/task-execution/profiles/delivery.1.0.json`). It rides on the
 * ref rather than beside it so that a row's `attempts` count stays re-derivable from
 * `inputRefs` alone -- which is what makes the projection incrementally foldable.
 */
export interface CurationInputRef {
  readonly source: { readonly agent: string; readonly name: string };
  readonly entry: Sha256Digest;
  readonly announcementId: string;
  readonly record: Sha256Digest;
  readonly attemptUri: string;
}

/**
 * One observed verdict, as the curation adapter hands it over.
 *
 * Three fields require an adapter join and are NOT read off a single announcement (plan
 * Findings FC6-2, FC6-4, FC6-5):
 *  - `taskDigest` is the SUBJECT Task digest. The evaluation Delivery's own `task` field is
 *    the derived evaluation Task (`packages/marketplace/binding/src/evaluation-derive.ts`),
 *    so the adapter resolves the subject through the evaluation Task payload's
 *    `subjectTask.digest` or the Result Evaluation Statement's subjects.
 *  - `benchmarkRun` is the `benchrun` attribute of the JUDGED SOLUTION Delivery
 *    (benchmarking design section 11); absent means organic.
 *  - `attribution` is the evaluator identity (on-chain `VerdictDeliveryClaimed.evaluator` or
 *    the statement's `evaluator.id`). Required, because design finding F6 makes
 *    consumer-side filtering the whole mitigation. This package never groups or reports on
 *    it -- per-solver breakdown is a parked extension (design section 14).
 */
export interface CurationObservation {
  readonly taskDigest: Sha256Digest;
  readonly verdict: ObservedVerdict;
  readonly observedAt: Instant;
  readonly attribution: string;
  readonly benchmarkRun?: string;
  readonly ref: CurationInputRef;
}

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** RFC 3339 date-time with a mandatory offset (`Z` or +/-HH:MM). */
const InstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => !Number.isNaN(Date.parse(value)), "observedAt is not a real instant");

const CurationInputRefSchema = z.object({
  source: z.object({ agent: z.string().min(1), name: z.string().min(1) }),
  entry: Sha256DigestSchema,
  announcementId: z.string().min(1),
  record: Sha256DigestSchema,
  attemptUri: z.string().min(1),
});

const CurationObservationSchema = z.object({
  taskDigest: Sha256DigestSchema,
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  observedAt: InstantSchema,
  attribution: z.string().min(1),
  benchmarkRun: z.string().min(1).optional(),
  ref: CurationInputRefSchema,
});

export function parseCurationObservation(value: unknown): CurationObservation {
  const result = CurationObservationSchema.safeParse(value);
  if (!result.success) {
    throw new CurationInputError(
      `malformed curation observation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      { cause: result.error },
    );
  }
  return result.data as CurationObservation;
}

/** Unit separator, written as an escape so no raw control byte appears in source. */
const KEY_SEPARATOR = "\u001f";

/**
 * The at-least-once dedupe key of the discovery subscribe plane -- the same
 * `(source agent, source name, entry digest, announcementId)` tuple as
 * `announcementDedupeKey` in `packages/discovery/protocol/src/cloudevents.ts`. Folding on
 * this key is what makes redelivery a no-op.
 */
export function inputRefKey(ref: CurationInputRef): string {
  return [ref.source.agent, ref.source.name, ref.entry, ref.announcementId].join(KEY_SEPARATOR);
}
