// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  isCalendarStrictRfc3339,
  type Sha256Digest,
} from "@jinn-network/trust-core";
import { z } from "zod";

import { PrefixedSha256Schema } from "./digests.js";
import { invalidInput } from "./errors.js";
import {
  VERIFICATION_FAILURE_REASONS,
  classifyVerificationFailure,
  type VerificationFailureReason,
} from "./failures.js";

export const STAGED_STATE_SCHEMA_VERSION = "environment-verification-staged-state.v1" as const;
export const MAX_INFRASTRUCTURE_ATTEMPTS = 3;

export const STAGED_STAGES = [
  "discovered",
  "acquiring",
  "running",
  "attesting",
  "complete",
] as const;
export type StagedStage = (typeof STAGED_STAGES)[number];

export const STAGED_DISPOSITIONS = [
  "pending",
  "retrying",
  "attested",
  "terminal_policy",
  "awaiting_input",
  "quarantined",
  "failed_infrastructure",
] as const;
export type StagedDisposition = (typeof STAGED_DISPOSITIONS)[number];

/**
 * Every timestamp in this file is an RFC 3339 UTC instant. The fence
 * (`nextAttemptAt <= now`) and the ordering are plain string comparisons, which
 * are only meaningful over one fixed shape.
 */
const Rfc3339UtcSchema = z
  .string()
  .refine(isCalendarStrictRfc3339, "must be a calendar-strict RFC 3339 timestamp")
  .refine((value) => value.endsWith("Z"), "must be expressed in UTC with a trailing Z");

/** Validates a caller-supplied instant before it can reach a stored field. */
function requireInstant(value: string, label: string): string {
  if (!Rfc3339UtcSchema.safeParse(value).success) {
    invalidInput(`${label} must be an RFC 3339 UTC instant with a trailing Z; received "${value}".`);
  }
  return value;
}

const StagedJobSchema = z.strictObject({
  key: PrefixedSha256Schema,
  stage: z.enum(STAGED_STAGES),
  disposition: z.enum(STAGED_DISPOSITIONS),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: Rfc3339UtcSchema.optional(),
  reason: z.enum(VERIFICATION_FAILURE_REASONS).optional(),
  attestationDigest: PrefixedSha256Schema.optional(),
  createdAt: Rfc3339UtcSchema,
  updatedAt: Rfc3339UtcSchema,
});
export type StagedJob = z.infer<typeof StagedJobSchema>;

const StagedStateFileSchema = z.strictObject({
  schemaVersion: z.literal(STAGED_STATE_SCHEMA_VERSION),
  updatedAt: Rfc3339UtcSchema,
  jobs: z.record(PrefixedSha256Schema, StagedJobSchema),
});
export type StagedStateFile = z.infer<typeof StagedStateFileSchema>;

/** A job is keyed by the environment record digest: one record, one job. */
export function createStagedStateFile(now: string): StagedStateFile {
  return {
    schemaVersion: STAGED_STATE_SCHEMA_VERSION,
    updatedAt: requireInstant(now, "now"),
    jobs: {},
  };
}

function withJobs(
  file: StagedStateFile,
  jobs: Record<string, StagedJob>,
  now: string,
): StagedStateFile {
  return {
    schemaVersion: STAGED_STATE_SCHEMA_VERSION,
    updatedAt: requireInstant(now, "now"),
    jobs,
  };
}

function requireJob(file: StagedStateFile, key: Sha256Digest): StagedJob {
  const job = file.jobs[key];
  if (job === undefined) invalidInput(`Unknown staged job ${key}.`);
  return job;
}

/** Idempotent: an existing key keeps its stage, disposition, and createdAt. */
export function upsertStagedJobs(
  file: StagedStateFile,
  keys: readonly Sha256Digest[],
  now: string,
): StagedStateFile {
  const jobs: Record<string, StagedJob> = { ...file.jobs };
  for (const key of keys) {
    if (jobs[key] !== undefined) continue;
    jobs[key] = {
      key,
      stage: "discovered",
      disposition: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
  return withJobs(file, jobs, now);
}

export function advanceStagedJob(
  file: StagedStateFile,
  key: Sha256Digest,
  stage: StagedStage,
  now: string,
): StagedStateFile {
  const job = requireJob(file, key);
  return withJobs(file, { ...file.jobs, [key]: { ...job, stage, updatedAt: now } }, now);
}

export function recordStagedAttested(
  file: StagedStateFile,
  key: Sha256Digest,
  attestationDigest: Sha256Digest,
  now: string,
): StagedStateFile {
  const job = requireJob(file, key);
  const { nextAttemptAt: _fence, reason: _reason, ...rest } = job;
  return withJobs(file, {
    ...file.jobs,
    [key]: {
      ...rest,
      stage: "complete",
      disposition: "attested",
      attestationDigest,
      updatedAt: now,
    },
  }, now);
}

/**
 * Applies the closed taxonomy's disposition. `failed_infrastructure` retries
 * behind a fence until `MAX_INFRASTRUCTURE_ATTEMPTS`; every other disposition
 * is terminal for this record and clears the fence.
 *
 * A terminal failure is a *published* fact -- design §6 maps `quarantined` to a
 * published `unstable` attestation and a parked `failed_infrastructure` job to
 * a published `error` one -- so the caller may name that attestation by digest.
 * A retry has published nothing and takes none.
 */
export function recordStagedFailure(
  file: StagedStateFile,
  key: Sha256Digest,
  reason: VerificationFailureReason,
  now: string,
  retryDelayMs: number,
  attestationDigest?: Sha256Digest,
): StagedStateFile {
  const job = requireJob(file, key);
  const disposition = classifyVerificationFailure(reason);
  if (disposition !== "failed_infrastructure") {
    const { nextAttemptAt: _fence, ...rest } = job;
    return withJobs(file, {
      ...file.jobs,
      [key]: {
        ...rest,
        disposition,
        reason,
        ...(attestationDigest === undefined ? {} : { attestationDigest }),
        updatedAt: now,
      },
    }, now);
  }

  const attempts = job.attempts + 1;
  if (attempts >= MAX_INFRASTRUCTURE_ATTEMPTS) {
    const { nextAttemptAt: _fence, ...rest } = job;
    return withJobs(file, {
      ...file.jobs,
      [key]: {
        ...rest,
        attempts,
        disposition: "failed_infrastructure",
        reason,
        ...(attestationDigest === undefined ? {} : { attestationDigest }),
        updatedAt: now,
      },
    }, now);
  }
  const fence = new Date(new Date(now).getTime() + retryDelayMs);
  if (!Number.isFinite(fence.getTime())) invalidInput(`Invalid timestamp or delay for ${key}.`);
  return withJobs(file, {
    ...file.jobs,
    [key]: {
      ...job,
      attempts,
      disposition: "retrying",
      reason,
      nextAttemptAt: fence.toISOString(),
      updatedAt: now,
    },
  }, now);
}

/** Resumable work: pending or fenced-and-due, ordered by creation then key. */
export function dueStagedJobs(file: StagedStateFile, now: string): readonly StagedJob[] {
  requireInstant(now, "now");
  return Object.values(file.jobs)
    .filter((job) => job.disposition === "pending" || job.disposition === "retrying")
    .filter((job) => job.nextAttemptAt === undefined || job.nextAttemptAt <= now)
    .sort((left, right) =>
      compareCodeUnitStrings(left.createdAt, right.createdAt)
      || compareCodeUnitStrings(left.key, right.key));
}

export function serializeStagedStateFile(file: StagedStateFile): Uint8Array {
  return canonicalJsonBytes(file);
}

/** Fails loud on a corrupt file. A silent reset would discard every recorded
 * job -- exactly what the legacy store did. */
export function parseStagedStateFile(bytes: Uint8Array): StagedStateFile {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    invalidInput("Staged state file is not valid UTF-8 JSON.", cause);
  }
  const result = StagedStateFileSchema.safeParse(decoded);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid staged state file at /${first.path.join("/")}: ${first.message}`
        : "Invalid staged state file.",
    );
  }
  return result.data;
}

/** Persistence port. `createFileStagedStateStore` is the shipped implementation. */
export interface StagedStateStore {
  read(): Promise<StagedStateFile | null>;
  write(file: StagedStateFile): Promise<void>;
}
