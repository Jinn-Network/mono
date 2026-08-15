import { z } from "zod";
import {
  CurationInputError,
  CurationInputRefSchema,
  FreeTextSchema,
  InstantSchema,
  Sha256DigestSchema,
  issueText,
  refDedupeKey,
} from "./schema.js";

export { CurationInputError } from "./schema.js";

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
 * ("https://spec.jinn.network/facts/marketplace-verdict-correspondence/v1" in
 * `packages/marketplace/projector/src/announce.ts`), which is itself the evaluator-signed
 * Result Evaluation Statement's `verdict` (task-profiles design section 9.2).
 */
export type ObservedVerdict = "pass" | "fail" | "inconclusive";

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
 *
 * The three free-text fields must carry no control character: the dedupe key is a
 * separator-joined string, and a component carrying the separator would let one source forge
 * a key collision with another source's ref (see `inputRefKey`).
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

const CurationObservationSchema = z.object({
  taskDigest: Sha256DigestSchema,
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  observedAt: InstantSchema,
  attribution: FreeTextSchema,
  benchmarkRun: FreeTextSchema.optional(),
  ref: CurationInputRefSchema,
});

export function parseCurationObservation(value: unknown): CurationObservation {
  const result = CurationObservationSchema.safeParse(value);
  if (!result.success) {
    throw new CurationInputError(
      `malformed curation observation: ${issueText(result.error)}`,
      { cause: result.error },
    );
  }
  return result.data as CurationObservation;
}

/**
 * The at-least-once dedupe key of the discovery subscribe plane -- the same
 * `(source agent, source name, entry digest, announcementId)` tuple as
 * `announcementDedupeKey` in `packages/discovery/protocol/src/cloudevents.ts`. Folding on
 * this key is what makes redelivery a no-op.
 *
 * The tuple is joined on the unit separator, so it is only unambiguous while no component
 * contains one. A ref that breaks that rule is refused rather than keyed: an unescaped join
 * over unvalidated text is forgeable, and a forged key would let one source's ref displace
 * another's and silently drop an honest verdict from the published rate.
 */
export function inputRefKey(ref: CurationInputRef): string {
  return refDedupeKey(ref);
}
