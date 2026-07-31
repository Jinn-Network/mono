// SPDX-License-Identifier: Apache-2.0

import { isCalendarStrictRfc3339 } from "@jinn-network/trust-core";
import { z } from "zod";

import { PrefixedSha256Schema, ResourceDescriptorSchema } from "./digests.js";
import { invalidInput } from "./errors.js";
import { FAILURE_STAGES, VERIFICATION_FAILURE_REASONS } from "./failures.js";
import { ENVIRONMENT_VERIFICATION_PROTOCOL_URI, MINIMUM_RUN_COUNT } from "./identifiers.js";

const Rfc3339UtcSchema = z
  .string()
  .refine(isCalendarStrictRfc3339, "must be a calendar-strict RFC 3339 timestamp")
  .refine((value) => value.endsWith("Z"), "must be expressed in UTC with a trailing Z");

/**
 * When the runs happened. Inside the signed payload on purpose: a re-announced
 * old attestation cannot present itself as fresh (design §5.2).
 */
export const VerificationWindowSchema = z
  .strictObject({ startedAt: Rfc3339UtcSchema, endedAt: Rfc3339UtcSchema })
  .refine((window) => window.startedAt <= window.endedAt, {
    message: "window.endedAt must not precede window.startedAt",
    path: ["endedAt"],
  });
export type VerificationWindow = z.infer<typeof VerificationWindowSchema>;

/** The declared controls the K runs ran under. Required in every result --
 * including `error`, where they say what would have been applied. */
export const VerificationControlsSchema = z.strictObject({
  network: z.literal("none"),
  seeds: z.record(z.string().min(1), z.string()),
  order: z.enum(["declared", "fixed", "default"]),
  parallelism: z.number().int().positive(),
  locale: z.string().min(1),
  tz: z.string().min(1),
});
export type VerificationControls = z.infer<typeof VerificationControlsSchema>;

export const RunObservationSchema = z.strictObject({
  outcomeSetDigest: PrefixedSha256Schema,
  wallSeconds: z.number().nonnegative().finite(),
});
export type RunObservation = z.infer<typeof RunObservationSchema>;

export const RunsBlockSchema = z
  .strictObject({
    count: z.number().int().min(MINIMUM_RUN_COUNT),
    outcomeSetDigest: PrefixedSha256Schema,
    perRun: z.array(RunObservationSchema).min(MINIMUM_RUN_COUNT),
  })
  .refine((runs) => runs.count === runs.perRun.length, {
    message: "runs.count must equal runs.perRun.length",
    path: ["count"],
  });
export type RunsBlock = z.infer<typeof RunsBlockSchema>;

/**
 * Which tests fail at this commit. A baseline with failures is a *known*
 * baseline, not a rejected environment (design §5.2) -- imported per-instance
 * images carry the instance's bug and its failing tests by construction.
 */
export const BaselineBlockSchema = z.strictObject({
  passing: z.number().int().nonnegative(),
  failing: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  outcomes: ResourceDescriptorSchema,
});
export type BaselineBlock = z.infer<typeof BaselineBlockSchema>;

/** Observed bounds, never an equality claim; `timeoutSeconds` is the declared
 * ceiling and is present even when no run happened. */
export const RuntimeBoundsSchema = z
  .strictObject({
    minSeconds: z.number().nonnegative().finite().optional(),
    maxSeconds: z.number().nonnegative().finite().optional(),
    timeoutSeconds: z.number().positive().finite(),
  })
  .refine(
    (runtime) => runtime.minSeconds === undefined
      || runtime.maxSeconds === undefined
      || runtime.minSeconds <= runtime.maxSeconds,
    { message: "runtime.minSeconds must not exceed runtime.maxSeconds", path: ["minSeconds"] },
  )
  .refine(
    (runtime) => runtime.maxSeconds === undefined || runtime.maxSeconds <= runtime.timeoutSeconds,
    { message: "runtime.maxSeconds must not exceed runtime.timeoutSeconds", path: ["maxSeconds"] },
  );
export type RuntimeBounds = z.infer<typeof RuntimeBoundsSchema>;

/** Identity of the toolchain that ran the protocol. Host-declared -- a library
 * cannot truthfully digest its own build (see Findings F-C2-1). */
export const VerifierIdentitySchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: PrefixedSha256Schema,
});
export type VerifierIdentity = z.infer<typeof VerifierIdentitySchema>;

export const DivergenceSchema = z.strictObject({
  referenceRunIndex: z.number().int().nonnegative(),
  referenceOutcomeSetDigest: PrefixedSha256Schema,
  divergentRuns: z
    .array(z.strictObject({
      index: z.number().int().nonnegative(),
      outcomeSetDigest: PrefixedSha256Schema,
      outcomes: ResourceDescriptorSchema,
    }))
    .min(1),
});
export type Divergence = z.infer<typeof DivergenceSchema>;

export const FailureBlockSchema = z.strictObject({
  stage: z.enum(FAILURE_STAGES),
  reason: z.enum(VERIFICATION_FAILURE_REASONS),
  detail: z.string().min(1).optional(),
  divergence: DivergenceSchema.optional(),
});
export type FailureBlock = z.infer<typeof FailureBlockSchema>;

const PredicateShapeSchema = z.strictObject({
  protocol: z.literal(ENVIRONMENT_VERIFICATION_PROTOCOL_URI),
  result: z.enum(["stable", "unstable", "error"]),
  window: VerificationWindowSchema,
  runs: RunsBlockSchema.optional(),
  baseline: BaselineBlockSchema.optional(),
  controls: VerificationControlsSchema,
  runtime: RuntimeBoundsSchema,
  verifier: VerifierIdentitySchema,
  failure: FailureBlockSchema.optional(),
  evidence: z.array(ResourceDescriptorSchema).optional(),
});

export const EnvironmentVerificationPredicateSchema = PredicateShapeSchema.superRefine(
  (predicate, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: "custom", message, path });
    };

    // Presence rule (design §5.2): runs and baseline are present iff the result
    // is not `error`. An `error` attestation carries window, failure, and any
    // partial evidence only.
    if (predicate.result === "error") {
      if (predicate.runs !== undefined) issue("an error result carries no runs", ["runs"]);
      if (predicate.baseline !== undefined) {
        issue("an error result carries no baseline", ["baseline"]);
      }
      if (predicate.runtime.minSeconds !== undefined || predicate.runtime.maxSeconds !== undefined) {
        issue("observed runtime bounds require at least one run", ["runtime", "minSeconds"]);
      }
      if (predicate.failure === undefined) {
        issue("an error result requires a failure block", ["failure"]);
      } else if (predicate.failure.stage === "compare") {
        issue("compare-stage failures are unstable results, not errors", ["failure", "stage"]);
      } else if (predicate.failure.divergence !== undefined) {
        issue("divergence evidence requires runs", ["failure", "divergence"]);
      }
    } else {
      if (predicate.runs === undefined) issue("a non-error result requires runs", ["runs"]);
      if (predicate.baseline === undefined) {
        issue("a non-error result requires a baseline", ["baseline"]);
      }
      if (predicate.runtime.minSeconds === undefined || predicate.runtime.maxSeconds === undefined) {
        issue("a non-error result requires observed runtime bounds", ["runtime", "minSeconds"]);
      }
      if (
        predicate.runs !== undefined
        && predicate.baseline !== undefined
        && predicate.baseline.outcomes.digest.sha256
          !== predicate.runs.outcomeSetDigest.slice("sha256:".length)
      ) {
        issue(
          "baseline.outcomes must reference the canonical outcome set named by runs.outcomeSetDigest",
          ["baseline", "outcomes"],
        );
      }
    }

    // `stable` means every run agreed. A `stable` result whose per-run digests
    // differ is exactly the adversarial fixture of design §5.5.
    if (predicate.result === "stable") {
      if (predicate.failure !== undefined) {
        issue("a stable result carries no failure block", ["failure"]);
      }
      predicate.runs?.perRun.forEach((run, index) => {
        if (run.outcomeSetDigest !== predicate.runs?.outcomeSetDigest) {
          issue(
            "a stable result requires every per-run outcome-set digest to equal the canonical one",
            ["runs", "perRun", index, "outcomeSetDigest"],
          );
        }
      });
    }

    // `unstable` exists only as observed divergence, and says so structurally.
    if (predicate.result === "unstable") {
      if (predicate.failure === undefined) {
        issue("an unstable result requires a failure block", ["failure"]);
      } else {
        if (predicate.failure.stage !== "compare") {
          issue("an unstable result is a compare-stage failure", ["failure", "stage"]);
        }
        if (predicate.failure.reason !== "outcome-set-divergence") {
          issue("an unstable result is outcome-set divergence", ["failure", "reason"]);
        }
        if (predicate.failure.divergence === undefined) {
          issue("an unstable result requires divergence evidence", ["failure", "divergence"]);
        }
      }
    }
  },
);

export type EnvironmentVerificationPredicate = z.infer<typeof PredicateShapeSchema>;

export function parseEnvironmentVerificationPredicate(
  value: unknown,
): EnvironmentVerificationPredicate {
  const result = EnvironmentVerificationPredicateSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid verification predicate at /${first.path.join("/")}: ${first.message}`
        : "Invalid verification predicate.",
    );
  }
  return result.data;
}
