// SPDX-License-Identifier: MIT

import {
  compareCalendarStrictRfc3339Instants,
  submissionExtensionBlock,
} from "@jinn-network/benchmarking-records";
import { checkPreregistrationAnchoredOrder } from "@jinn-network/benchmarking-run";
import type { AuthorityProjection } from "./authority-projection.js";
import {
  BENCHMARKING_CELL_EXTENSION,
  type SealedRecordMaterialPort,
} from "./cell-authority.js";
import {
  bytesMatchCanonicalSeal,
  decodeUtf8Json,
} from "./canonical-bytes.js";
import { sealSubmission, validateSubmission } from "@jinn-network/task-execution-protocol";

export class AnchoredOrderingViolationError extends Error {
  readonly check = "preregistration-precedes-dispatch" as const;

  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "AnchoredOrderingViolationError";
  }
}

export interface AnchoredOrderingTranscript {
  /** Finalized chain timestamp of the earliest Run-digest-anchoring Submission post. */
  readonly runDigestAnchorAt: string;
  readonly earliestCellPostAt: string;
  readonly check: ReturnType<typeof checkPreregistrationAnchoredOrder>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveCanonicalSubmission(input: {
  submissionUrn: string;
  taskDigest: string;
  material?: SealedRecordMaterialPort;
}): Promise<{ doc: Record<string, unknown>; time: string } | undefined> {
  if (input.material === undefined) return undefined;
  const taskRef = input.taskDigest.startsWith("sha256:")
    ? input.taskDigest
    : `sha256:${input.taskDigest}`;
  const bytes = await input.material.sealedSubmissionBytes({
    submissionUrn: input.submissionUrn,
    taskDigest: taskRef as `sha256:${string}`,
  });
  if (bytes === undefined) return undefined;
  const parsed = decodeUtf8Json(bytes);
  if (parsed === undefined || !isRecord(parsed)) return undefined;
  const validation = validateSubmission(parsed);
  if (!bytesMatchCanonicalSeal(bytes, parsed, sealSubmission, validation)) return undefined;
  return { doc: parsed, time: "" };
}

function extensionCommitsToRun(
  doc: Record<string, unknown>,
  runDigest: string,
  cellKey: string,
  armId: string,
): boolean {
  const block = doc[BENCHMARKING_CELL_EXTENSION];
  if (!isRecord(block)) return false;
  const expected = submissionExtensionBlock(runDigest, cellKey, armId);
  return block.run === expected.run
    && block.cellKey === expected.cellKey
    && block.armId === expected.armId;
}

/**
 * Earliest finalized Run-digest anchor: chain-anchored Submission accepted observation whose
 * canonical bytes structurally commit to this Run digest (design §7.2 leg (b), revised/today).
 */
export async function deriveRunDigestAnchorAt(input: {
  projection: AuthorityProjection;
  runDigest: string;
  material?: SealedRecordMaterialPort;
}): Promise<string | undefined> {
  let earliest: string | undefined;

  for (const observation of input.projection.observations) {
    if (observation.type !== "network.jinn.task-execution.submission-accepted.v1") continue;
    const data = observation.data;
    if (!isRecord(data)) continue;
    const task = data.task;
    const submissionUrn = observation.subject;
    if (typeof task !== "string" || typeof submissionUrn !== "string") continue;

    const taskHex = task.replace(/^sha256:/, "");
    const resolved = await resolveCanonicalSubmission({
      submissionUrn,
      taskDigest: taskHex,
      material: input.material,
    });
    if (resolved === undefined) continue;
    const extension = resolved.doc[BENCHMARKING_CELL_EXTENSION];
    if (!isRecord(extension)) continue;
    if (extension.run !== input.runDigest) continue;

    const time = observation.time;
    if (
      earliest === undefined
      || (compareCalendarStrictRfc3339Instants(time, earliest) ?? 1) < 0
    ) {
      earliest = time;
    }
  }

  return earliest;
}

/**
 * Earliest finalized cell-post timestamp for this Run digest from projector authority facts
 * backed by exact authorized Submission bytes (design §7.2 leg (b)).
 */
export async function deriveEarliestCellPostAt(input: {
  projection: AuthorityProjection;
  runDigest: string;
  material?: SealedRecordMaterialPort;
}): Promise<string | undefined> {
  let earliest: string | undefined;

  const consider = (time: string | undefined) => {
    if (typeof time !== "string") return;
    if (
      earliest === undefined
      || (compareCalendarStrictRfc3339Instants(time, earliest) ?? 1) < 0
    ) {
      earliest = time;
    }
  };

  for (const observation of input.projection.observations) {
    if (observation.type !== "network.jinn.task-execution.attempt-engaged.v1") continue;
    const data = observation.data;
    if (!isRecord(data)) continue;

    const task = data.task;
    const submissionUrn = data.submission;
    if (typeof task !== "string" || typeof submissionUrn !== "string") continue;
    const taskHex = task.replace(/^sha256:/, "");

    const resolved = await resolveCanonicalSubmission({
      submissionUrn,
      taskDigest: taskHex,
      material: input.material,
    });
    if (resolved === undefined) continue;
    const extension = resolved.doc[BENCHMARKING_CELL_EXTENSION];
    if (!isRecord(extension)) continue;
    if (extension.run !== input.runDigest) continue;

    consider(observation.time);
  }

  return earliest;
}

/**
 * Production ordering gate (design §7.2 leg (b)). Derives both anchors from the coherent
 * projection + exact bytes; throws before assembly on any violation — never a hand boolean.
 */
export async function enforceAnchoredOrderingGate(input: {
  projection: AuthorityProjection;
  runDigest: string;
  material?: SealedRecordMaterialPort;
}): Promise<AnchoredOrderingTranscript> {
  const runDigestAnchorAt = await deriveRunDigestAnchorAt(input);
  if (runDigestAnchorAt === undefined) {
    throw new AnchoredOrderingViolationError(
      "anchored ordering gate failed",
      "no finalized Run-digest-anchoring Submission with exact authorized bytes",
    );
  }

  const earliestCellPostAt = await deriveEarliestCellPostAt(input);
  if (earliestCellPostAt === undefined) {
    throw new AnchoredOrderingViolationError(
      "anchored ordering gate failed",
      "no finalized cell post with exact Submission bytes committing to this Run digest",
    );
  }

  const check = checkPreregistrationAnchoredOrder({
    runAnnouncedAt: runDigestAnchorAt,
    earliestCellPostAt,
  });
  if (!check.ok) {
    throw new AnchoredOrderingViolationError(
      "anchored ordering gate failed",
      check.detail,
    );
  }

  return {
    runDigestAnchorAt,
    earliestCellPostAt,
    check,
  };
}

/** Evidence transcript after the production gate passes. */
export function buildAnchoredOrderingTranscript(input: {
  runDigestAnchorAt: string;
  earliestCellPostAt: string;
  check: ReturnType<typeof checkPreregistrationAnchoredOrder>;
}): AnchoredOrderingTranscript {
  return {
    runDigestAnchorAt: input.runDigestAnchorAt,
    earliestCellPostAt: input.earliestCellPostAt,
    check: input.check,
  };
}
