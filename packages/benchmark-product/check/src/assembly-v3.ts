/**
 * `benchmark-product-assembly/3` contract (dispatch-timestamps packet 1, issue #4614).
 *
 * Source of truth for the header grammar in
 * `docs/superpowers/specs/2026-09-06-dispatch-timestamps-assembly-header-design.md`
 * §3.1–§3.2 and §5.2. `/3` retains every `/2` header and cell member and adds one
 * required, non-empty `graph.dispatchBoundaries` array. The producer does not emit
 * this format here — packet 2 projects it — and the standalone verifier still parses
 * `/2`. This module is the typed grammar, the projection types, and the exact
 * RFC 3339 comparator later packets reuse.
 */

import { z } from "zod";
import {
  compareCalendarStrictRfc3339Instants,
  isCalendarStrictRfc3339,
} from "@jinn-network/benchmarking-records";
import { BundleAssemblyHeaderSchema } from "./schema.js";

export {
  compareCalendarStrictRfc3339Instants,
  isCalendarStrictRfc3339,
};

export const BUNDLE_ASSEMBLY_V3_FORMAT = "benchmark-product-assembly/3" as const;

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const NonNegativeSafeIntSchema = z.number().int().nonnegative().refine(
  Number.isSafeInteger,
  "must be a non-negative safe integer",
);
const PositiveIntSchema = z.number().int().positive();
const CalendarStrictRfc3339Schema = z
  .string()
  .refine(isCalendarStrictRfc3339, { message: "at must be calendar-strict RFC 3339" });

/** Solve capture projected from a `submission-captured` journal entry (§3.2). */
export const DispatchBoundarySolveEventSchema = z.object({
  journalIndex: NonNegativeSafeIntSchema,
  entrySha256: Sha256HexSchema,
  kind: z.literal("submission-captured"),
  at: CalendarStrictRfc3339Schema,
  cellKey: z.string().min(1),
  armId: z.string().min(1),
  replicate: PositiveIntSchema,
  dispatch: PositiveIntSchema,
  submissionSha256: Sha256HexSchema,
  publicationSourceSequence: z.string().regex(/^\d{16}$/).optional(),
  publicationEntrySha256: Sha256HexSchema.optional(),
});
export type DispatchBoundarySolveEvent = z.infer<typeof DispatchBoundarySolveEventSchema>;

/** Evaluation capture projected from an `evaluation-submission-captured` entry (§3.2). */
export const DispatchBoundaryEvaluationEventSchema = z.object({
  journalIndex: NonNegativeSafeIntSchema,
  entrySha256: Sha256HexSchema,
  kind: z.literal("evaluation-submission-captured"),
  at: CalendarStrictRfc3339Schema,
  cellKey: z.string().min(1),
  dispatch: PositiveIntSchema,
  evalIndex: PositiveIntSchema,
  evaluationAttempt: PositiveIntSchema,
  submissionSha256: Sha256HexSchema,
});
export type DispatchBoundaryEvaluationEvent = z.infer<typeof DispatchBoundaryEvaluationEventSchema>;

export const DispatchBoundaryEventSchema = z.discriminatedUnion("kind", [
  DispatchBoundarySolveEventSchema,
  DispatchBoundaryEvaluationEventSchema,
]);
export type DispatchBoundaryEvent = z.infer<typeof DispatchBoundaryEventSchema>;

/**
 * Exact projected capture array. Non-empty; `journalIndex` strictly increasing
 * (gaps are legal). Solve publication receipts appear together or not at all.
 */
export const DispatchBoundariesSchema = z.array(DispatchBoundaryEventSchema).min(1).superRefine(
  (events, ctx) => {
    for (const [index, event] of events.entries()) {
      if (event.kind === "submission-captured") {
        const hasSequence = event.publicationSourceSequence !== undefined;
        const hasDigest = event.publicationEntrySha256 !== undefined;
        if (hasSequence !== hasDigest) {
          ctx.addIssue({
            code: "custom",
            path: [index, hasSequence ? "publicationEntrySha256" : "publicationSourceSequence"],
            message: "publicationSourceSequence and publicationEntrySha256 must appear together or not at all",
          });
        }
      }
      if (index === 0) continue;
      if (event.journalIndex <= events[index - 1]!.journalIndex) {
        ctx.addIssue({
          code: "custom",
          path: [index, "journalIndex"],
          message: "journalIndex values must be strictly increasing",
        });
      }
    }
  },
);
export type DispatchBoundariesProjection = z.infer<typeof DispatchBoundariesSchema>;

export const BundleAssemblyV3HeaderSchema = z.object({
  format: z.literal(BUNDLE_ASSEMBLY_V3_FORMAT),
  kind: BundleAssemblyHeaderSchema.shape.kind,
  runCancelled: BundleAssemblyHeaderSchema.shape.runCancelled,
  draftId: BundleAssemblyHeaderSchema.shape.draftId,
  assurancePreset: BundleAssemblyHeaderSchema.shape.assurancePreset,
  rehearsal: BundleAssemblyHeaderSchema.shape.rehearsal,
  graph: z.object({
    ...BundleAssemblyHeaderSchema.shape.graph.shape,
    dispatchBoundaries: DispatchBoundariesSchema,
  }),
});
export type BundleAssemblyV3Header = z.infer<typeof BundleAssemblyV3HeaderSchema>;

/** Event with the lowest `journalIndex` (§5.2). After grammar validation that is the first row. */
export function firstDispatchBoundary(
  events: readonly DispatchBoundaryEvent[],
): DispatchBoundaryEvent {
  if (events.length === 0) {
    throw new Error("dispatchBoundaries is empty");
  }
  let first = events[0]!;
  for (const event of events.slice(1)) {
    if (event.journalIndex < first.journalIndex) first = event;
  }
  return first;
}

/**
 * Event with the minimum exact RFC 3339 instant, lowest `journalIndex` on a tie (§5.2).
 * Uses `compareCalendarStrictRfc3339Instants` from the records package, not `Date.parse`.
 */
export function earliestRecordedDispatch(
  events: readonly DispatchBoundaryEvent[],
): DispatchBoundaryEvent {
  if (events.length === 0) {
    throw new Error("dispatchBoundaries is empty");
  }
  let earliest = events[0]!;
  for (const event of events.slice(1)) {
    const order = compareCalendarStrictRfc3339Instants(event.at, earliest.at);
    if (order === undefined) {
      throw new Error("dispatchBoundaries at is not calendar-strict RFC 3339");
    }
    if (order < 0 || (order === 0 && event.journalIndex < earliest.journalIndex)) {
      earliest = event;
    }
  }
  return earliest;
}

export function dispatchBoundaryCount(events: readonly DispatchBoundaryEvent[]): number {
  return events.length;
}
