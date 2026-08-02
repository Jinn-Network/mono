// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  isCalendarStrictRfc3339,
  recordDigest,
  type Sha256Digest,
} from "@jinn-network/trust-core";
import { z } from "zod";

import type { ExtractionRequest } from "./baseline.js";
import { invalidInput } from "./errors.js";
import {
  EXTRACTION_FAILURE_DISPOSITIONS,
  EXTRACTION_FAILURE_REASONS,
  EXTRACTION_STAGES,
  classifyExtractionFailure,
  isRetryableExtractionFailure,
  type ExtractionFailureDisposition,
  type ExtractionFailureReason,
  type ExtractionStage,
} from "./failures.js";
import { EXTRACTION_STATE_SCHEMA_VERSION, type ArchiveBudgetLimits } from "./identifiers.js";
import type { ArchiveUsage } from "./ports.js";

export const MAX_INFRASTRUCTURE_ATTEMPTS = 3;

export const EXTRACTION_JOB_DISPOSITIONS = [
  "pending",
  "retrying",
  "converged",
  ...EXTRACTION_FAILURE_DISPOSITIONS,
] as const;
export type ExtractionJobDisposition = (typeof EXTRACTION_JOB_DISPOSITIONS)[number];

const PrefixedSha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lowercase hex digits>");

const Rfc3339UtcSchema = z
  .string()
  .refine(isCalendarStrictRfc3339, "must be a calendar-strict RFC 3339 timestamp")
  .refine((value) => value.endsWith("Z"), "must be expressed in UTC with a trailing Z");

function requireInstant(value: string, label: string): string {
  if (!Rfc3339UtcSchema.safeParse(value).success) {
    invalidInput(`${label} must be an RFC 3339 UTC instant with a trailing Z; received "${value}".`);
  }
  return value;
}

const ExtractionJobSchema = z.strictObject({
  key: PrefixedSha256Schema,
  stage: z.enum(EXTRACTION_STAGES),
  disposition: z.enum(EXTRACTION_JOB_DISPOSITIONS),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: Rfc3339UtcSchema.optional(),
  reason: z.enum(EXTRACTION_FAILURE_REASONS).optional(),
  spentCalls: z.number().int().nonnegative(),
  spentBytes: z.number().int().nonnegative(),
  candidateRecordDigest: PrefixedSha256Schema.optional(),
  artifactDigest: PrefixedSha256Schema.optional(),
  attestationDigest: PrefixedSha256Schema.optional(),
  widenings: z.number().int().nonnegative().optional(),
  createdAt: Rfc3339UtcSchema,
  updatedAt: Rfc3339UtcSchema,
});
export type ExtractionJob = z.infer<typeof ExtractionJobSchema>;

const ExtractionStateFileSchema = z.strictObject({
  schemaVersion: z.literal(EXTRACTION_STATE_SCHEMA_VERSION),
  updatedAt: Rfc3339UtcSchema,
  jobs: z.record(PrefixedSha256Schema, ExtractionJobSchema),
});
export type ExtractionStateFile = z.infer<typeof ExtractionStateFileSchema>;

export function createExtractionStateFile(now: string): ExtractionStateFile {
  return {
    schemaVersion: EXTRACTION_STATE_SCHEMA_VERSION,
    updatedAt: requireInstant(now, "now"),
    jobs: {},
  };
}

function withJobs(
  file: ExtractionStateFile,
  jobs: Record<string, ExtractionJob>,
  now: string,
): ExtractionStateFile {
  return {
    schemaVersion: EXTRACTION_STATE_SCHEMA_VERSION,
    updatedAt: requireInstant(now, "now"),
    jobs,
  };
}

function requireJob(file: ExtractionStateFile, key: Sha256Digest): ExtractionJob {
  const job = file.jobs[key];
  if (job === undefined) invalidInput(`Unknown extraction job ${key}.`);
  return job;
}

function sortedFixtureDeclarations(
  declarations: ExtractionRequest["fixtureDeclarations"],
): ExtractionRequest["fixtureDeclarations"] {
  const decode = (value: (typeof declarations)[number]) =>
    new TextDecoder().decode(canonicalJsonBytes(value));
  return [...declarations].sort((left, right) =>
    compareCodeUnitStrings(decode(left), decode(right)));
}

/** Keys a job by the request identity fields so a resume addresses the same work. */
export function extractionJobKey(request: ExtractionRequest): Sha256Digest {
  const anchor = request.draft.sourceAnchor;
  return recordDigest(canonicalJsonBytes({
    caip2ChainId: anchor?.caip2ChainId ?? request.caip2ChainId,
    nativeChainId: anchor?.nativeChainId,
    anchorBlockNumber: request.anchorBlockNumber,
    fidelity: request.fidelityClass,
    sourceAddresses: [...request.sourceAddresses].sort(compareCodeUnitStrings),
    fixtureDeclarations: sortedFixtureDeclarations(request.fixtureDeclarations),
    draftDigest: recordDigest(canonicalJsonBytes(request.draft)),
  }));
}

/** Idempotent: an existing key keeps its stage, disposition, spend, and createdAt. */
export function upsertExtractionJobs(
  file: ExtractionStateFile,
  keys: readonly Sha256Digest[],
  now: string,
): ExtractionStateFile {
  const jobs: Record<string, ExtractionJob> = { ...file.jobs };
  for (const key of keys) {
    if (jobs[key] !== undefined) continue;
    jobs[key] = {
      key,
      stage: "anchor",
      disposition: "pending",
      attempts: 0,
      spentCalls: 0,
      spentBytes: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
  return withJobs(file, jobs, now);
}

export function advanceExtractionJob(
  file: ExtractionStateFile,
  key: Sha256Digest,
  stage: ExtractionStage,
  now: string,
): ExtractionStateFile {
  const job = requireJob(file, key);
  return withJobs(file, { ...file.jobs, [key]: { ...job, stage, updatedAt: now } }, now);
}

export function recordExtractionSpend(
  file: ExtractionStateFile,
  key: Sha256Digest,
  usage: ArchiveUsage,
  now: string,
): ExtractionStateFile {
  const job = requireJob(file, key);
  return withJobs(file, {
    ...file.jobs,
    [key]: {
      ...job,
      spentCalls: job.spentCalls + usage.calls,
      spentBytes: job.spentBytes + usage.bytes,
      updatedAt: now,
    },
  }, now);
}

export function recordExtractionConverged(
  file: ExtractionStateFile,
  key: Sha256Digest,
  digests: {
    readonly candidateRecordDigest: Sha256Digest;
    readonly artifactDigest: Sha256Digest;
    readonly attestationDigest: Sha256Digest;
    readonly widenings: number;
  },
  now: string,
): ExtractionStateFile {
  const job = requireJob(file, key);
  const { nextAttemptAt: _fence, reason: _reason, ...rest } = job;
  return withJobs(file, {
    ...file.jobs,
    [key]: {
      ...rest,
      stage: "reverify",
      disposition: "converged",
      candidateRecordDigest: digests.candidateRecordDigest,
      artifactDigest: digests.artifactDigest,
      attestationDigest: digests.attestationDigest,
      widenings: digests.widenings,
      updatedAt: now,
    },
  }, now);
}

/**
 * Applies the closed taxonomy's disposition. `infrastructure` retries behind a fence until
 * `MAX_INFRASTRUCTURE_ATTEMPTS`; every other disposition is terminal for this request.
 */
export function recordExtractionFailure(
  file: ExtractionStateFile,
  key: Sha256Digest,
  reason: ExtractionFailureReason,
  now: string,
  retryDelayMs: number,
): ExtractionStateFile {
  const job = requireJob(file, key);
  const disposition = classifyExtractionFailure(reason);
  if (!isRetryableExtractionFailure(reason)) {
    const { nextAttemptAt: _fence, ...rest } = job;
    return withJobs(file, {
      ...file.jobs,
      [key]: {
        ...rest,
        disposition,
        reason,
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
        disposition: "infrastructure" satisfies ExtractionFailureDisposition,
        reason,
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

/** Unspent archive budget remainder, clamped at zero, for resume. */
export function remainingBudget(
  job: ExtractionJob,
  limits: ArchiveBudgetLimits,
): ArchiveBudgetLimits {
  return {
    maxCalls: Math.max(0, limits.maxCalls - job.spentCalls),
    maxBytes: Math.max(0, limits.maxBytes - job.spentBytes),
  };
}

/** Resumable work: pending or fenced-and-due, ordered by creation then key. */
export function dueExtractionJobs(file: ExtractionStateFile, now: string): readonly ExtractionJob[] {
  requireInstant(now, "now");
  return Object.values(file.jobs)
    .filter((job) => job.disposition === "pending" || job.disposition === "retrying")
    .filter((job) => job.nextAttemptAt === undefined || job.nextAttemptAt <= now)
    .sort((left, right) =>
      compareCodeUnitStrings(left.createdAt, right.createdAt)
      || compareCodeUnitStrings(left.key, right.key));
}

export function serializeExtractionStateFile(file: ExtractionStateFile): Uint8Array {
  return canonicalJsonBytes(file);
}

/** Fails loud on a corrupt file. A silent reset would discard every recorded job. */
export function parseExtractionStateFile(bytes: Uint8Array): ExtractionStateFile {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    invalidInput("Extraction state file is not valid UTF-8 JSON.", cause);
  }
  const result = ExtractionStateFileSchema.safeParse(decoded);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid extraction state file at /${first.path.join("/")}: ${first.message}`
        : "Invalid extraction state file.",
    );
  }
  return result.data;
}

/** Persistence port. `createFileExtractionStateStore` is the shipped implementation. */
export interface ExtractionStateStore {
  read(): Promise<ExtractionStateFile | null>;
  write(file: ExtractionStateFile): Promise<void>;
}
