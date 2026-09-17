// SPDX-License-Identifier: MIT

import { checkPreregistrationAnchoredOrder } from "@jinn-network/benchmarking-run";
import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import {
  sealSubmission,
  validateSubmission,
} from "@jinn-network/task-execution-protocol";
import { deriveAuthorityProjection } from "./authority-projection.js";
import {
  bytesMatchCanonicalSeal,
  decodeUtf8Json,
} from "./canonical-bytes.js";
import {
  BENCHMARKING_CELL_EXTENSION,
  type SealedRecordMaterialPort,
} from "./cell-authority.js";
import type { CloseAnchorRef } from "./input-scope.js";
import {
  deriveEarliestCellPostAt,
  deriveRunDigestAnchorAt,
  type AnchoredOrderingTranscript,
} from "./ordering-leg-b.js";
import {
  parseMarketplaceEventBytes,
  serializeMarketplaceEvent,
} from "./ordering-event-json.js";
import {
  MARKETPLACE_ORDERING_SCHEMA_ID,
  MarketplaceOrderingParseError,
  compareSubmissionEntries,
  eventMemberPath,
  memberSha256Hex,
  parseMarketplaceOrderingRecord,
  serializeMarketplaceOrderingRecord,
  submissionMemberPath,
  type MarketplaceOrderingRecord,
  type MarketplaceOrderingSubmissionEntry,
} from "./ordering-record.js";

export interface OrderingMemberStore {
  readonly get: (path: string) => Uint8Array | undefined;
  readonly paths: () => Iterable<string>;
}

export interface MarketplaceOrderingReceipt {
  readonly record: MarketplaceOrderingRecord;
  readonly recordBytes: Uint8Array;
  readonly recordSha256: string;
  readonly members: ReadonlyMap<string, Uint8Array>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function materialKey(submissionUrn: string, taskDigest: `sha256:${string}`): string {
  return `${submissionUrn}\0${taskDigest}`;
}

export function memoizeSealedRecordMaterial(
  port: SealedRecordMaterialPort,
): SealedRecordMaterialPort {
  const submissions = new Map<string, Promise<Uint8Array | undefined>>();
  const deliveries = new Map<string, Promise<Uint8Array | undefined>>();
  const verdicts = new Map<string, Promise<Uint8Array | undefined>>();
  return {
    sealedSubmissionBytes(input) {
      const key = materialKey(input.submissionUrn, input.taskDigest);
      let hit = submissions.get(key);
      if (hit === undefined) {
        hit = Promise.resolve(port.sealedSubmissionBytes(input));
        submissions.set(key, hit);
      }
      return hit;
    },
    sealedDeliveryBytes: port.sealedDeliveryBytes === undefined
      ? undefined
      : (input) => {
        const key = `${input.attemptUrn}\0${input.deliveryDigest}`;
        let hit = deliveries.get(key);
        if (hit === undefined) {
          hit = Promise.resolve(port.sealedDeliveryBytes!(input));
          deliveries.set(key, hit);
        }
        return hit;
      },
    sealedVerdictDeliveryBytes: port.sealedVerdictDeliveryBytes === undefined
      ? undefined
      : (input) => {
        const key = `${input.attemptUrn}\0${input.verdictIndex}\0${input.deliveryDigest}`;
        let hit = verdicts.get(key);
        if (hit === undefined) {
          hit = Promise.resolve(port.sealedVerdictDeliveryBytes!(input));
          verdicts.set(key, hit);
        }
        return hit;
      },
  };
}

function taskRef(task: string): `sha256:${string}` {
  return (task.startsWith("sha256:") ? task : `sha256:${task}`) as `sha256:${string}`;
}

async function collectCommittedSubmissions(input: {
  projectionEvents: readonly ObservationMarketplaceEvent[];
  closeAnchor: CloseAnchorRef;
  orphanedBlockHashes: ReadonlySet<string>;
  runDigest: string;
  material?: SealedRecordMaterialPort;
}): Promise<MarketplaceOrderingSubmissionEntry[]> {
  const projection = deriveAuthorityProjection(
    input.projectionEvents,
    input.closeAnchor,
    input.orphanedBlockHashes,
  );
  const entries = new Map<string, MarketplaceOrderingSubmissionEntry>();

  const consider = async (submissionUrn: unknown, task: unknown) => {
    if (typeof submissionUrn !== "string" || typeof task !== "string") return;
    const taskDigest = taskRef(task);
    if (input.material === undefined) return;
    const bytes = await input.material.sealedSubmissionBytes({
      submissionUrn,
      taskDigest,
    });
    if (bytes === undefined) return;
    const parsed = decodeUtf8Json(bytes);
    if (parsed === undefined || !isRecord(parsed)) return;
    const validation = validateSubmission(parsed);
    if (!bytesMatchCanonicalSeal(bytes, parsed, sealSubmission, validation)) return;
    const extension = parsed[BENCHMARKING_CELL_EXTENSION];
    if (!isRecord(extension) || extension.run !== input.runDigest) return;
    const sha256 = memberSha256Hex(bytes);
    const path = submissionMemberPath(sha256);
    const key = `${submissionUrn}\0${taskDigest}`;
    const existing = entries.get(key);
    if (existing !== undefined && existing.sha256 !== sha256) {
      throw new MarketplaceOrderingParseError("conflicting Submission identities");
    }
    entries.set(key, {
      submission: submissionUrn,
      task: taskDigest,
      sha256,
      path,
    });
  };

  for (const observation of projection.observations) {
    if (observation.type === "network.jinn.task-execution.submission-accepted.v1") {
      await consider(observation.subject, isRecord(observation.data) ? observation.data.task : undefined);
    }
    if (observation.type === "network.jinn.task-execution.attempt-engaged.v1") {
      const data = observation.data;
      await consider(
        isRecord(data) ? data.submission : undefined,
        isRecord(data) ? data.task : undefined,
      );
    }
  }

  return [...entries.values()].sort(compareSubmissionEntries);
}

export async function buildMarketplaceOrderingReceipt(input: {
  events: readonly ObservationMarketplaceEvent[];
  closeAnchor: CloseAnchorRef;
  orphanedBlockHashes?: ReadonlySet<string>;
  runDigest: string;
  material?: SealedRecordMaterialPort;
  transcript: Pick<AnchoredOrderingTranscript, "runDigestAnchorAt" | "earliestCellPostAt">;
}): Promise<MarketplaceOrderingReceipt> {
  const orphaned = input.orphanedBlockHashes ?? new Set<string>();
  if (input.events.length === 0) {
    throw new MarketplaceOrderingParseError("ordering receipt requires at least one event");
  }
  const members = new Map<string, Uint8Array>();
  const eventEntries = input.events.map((event, ordinal) => {
    const bytes = serializeMarketplaceEvent(event);
    const sha256 = memberSha256Hex(bytes);
    const path = eventMemberPath(ordinal, sha256);
    members.set(path, bytes);
    return { ordinal, sha256, path };
  });
  const submissions = await collectCommittedSubmissions({
    projectionEvents: input.events,
    closeAnchor: input.closeAnchor,
    orphanedBlockHashes: orphaned,
    runDigest: input.runDigest,
    material: input.material,
  });
  for (const entry of submissions) {
    if (input.material === undefined) continue;
    const bytes = await input.material.sealedSubmissionBytes({
      submissionUrn: entry.submission,
      taskDigest: entry.task,
    });
    if (bytes === undefined) {
      throw new MarketplaceOrderingParseError("missing referenced Submission member");
    }
    members.set(entry.path, bytes);
  }
  const record: MarketplaceOrderingRecord = {
    schema: MARKETPLACE_ORDERING_SCHEMA_ID,
    runDigest: input.runDigest as `sha256:${string}`,
    closeAnchor: input.closeAnchor,
    events: eventEntries,
    submissions,
    transcript: {
      runDigestAnchorAt: input.transcript.runDigestAnchorAt,
      earliestCellPostAt: input.transcript.earliestCellPostAt,
    },
  };
  const recordBytes = serializeMarketplaceOrderingRecord(record);
  return {
    record,
    recordBytes,
    recordSha256: memberSha256Hex(recordBytes),
    members,
  };
}

export type OrderingByteStatus = "present" | "invalid";

export interface OrderingByteEvaluation {
  readonly status: OrderingByteStatus;
  readonly detail?: string;
  readonly record?: MarketplaceOrderingRecord;
}

function memberMap(members: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>): OrderingMemberStore {
  if (members instanceof Map) {
    return { get: (path) => members.get(path), paths: () => members.keys() };
  }
  const record = members as Record<string, Uint8Array>;
  return {
    get: (path) => record[path],
    paths: () => Object.keys(record),
  };
}

function fail(detail: string): OrderingByteEvaluation {
  return { status: "invalid", detail };
}

export async function evaluateOrderingBytes(input: {
  recordBytes: Uint8Array;
  members: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
}): Promise<OrderingByteEvaluation> {
  const parsedJson = decodeUtf8Json(input.recordBytes);
  let record: MarketplaceOrderingRecord;
  try {
    record = parseMarketplaceOrderingRecord(parsedJson);
  } catch (error) {
    return fail(error instanceof MarketplaceOrderingParseError ? error.detail : "record parse failed");
  }
  const store = memberMap(input.members);
  const referenced = new Set<string>();
  const events: ObservationMarketplaceEvent[] = [];
  for (const entry of record.events) {
    referenced.add(entry.path);
    const bytes = store.get(entry.path);
    if (bytes === undefined) return fail("missing referenced event member");
    if (memberSha256Hex(bytes) !== entry.sha256) return fail("event digest mismatch");
    try {
      events.push(parseMarketplaceEventBytes(bytes));
    } catch (error) {
      return fail(error instanceof MarketplaceOrderingParseError ? error.detail : "event member is not canonical");
    }
  }
  const submissionBytes = new Map<string, Uint8Array>();
  for (const entry of record.submissions) {
    referenced.add(entry.path);
    const bytes = store.get(entry.path);
    if (bytes === undefined) return fail("missing referenced Submission member");
    if (memberSha256Hex(bytes) !== entry.sha256) return fail("Submission digest mismatch");
    const previous = submissionBytes.get(entry.path);
    if (previous !== undefined && previous !== bytes && memberSha256Hex(previous) !== memberSha256Hex(bytes)) {
      return fail("conflicting Submission identities");
    }
    const parsed = decodeUtf8Json(bytes);
    if (parsed === undefined || !isRecord(parsed)) return fail("non-canonical Submission bytes");
    const validation = validateSubmission(parsed);
    if (!bytesMatchCanonicalSeal(bytes, parsed, sealSubmission, validation)) {
      return fail("non-canonical Submission bytes");
    }
    submissionBytes.set(entry.path, bytes);
  }
  for (const path of store.paths()) {
    if (!path.startsWith("ordering/")) continue;
    if (!referenced.has(path)) return fail("unreferenced ordering member");
  }

  const projection = deriveAuthorityProjection(events, record.closeAnchor, new Set());
  const material: SealedRecordMaterialPort = {
    sealedSubmissionBytes({ submissionUrn, taskDigest }) {
      const entry = record.submissions.find(
        (candidate) => candidate.submission === submissionUrn && candidate.task === taskDigest,
      );
      if (entry === undefined) return undefined;
      return submissionBytes.get(entry.path);
    },
  };
  const runDigestAnchorAt = await deriveRunDigestAnchorAt({
    projection,
    runDigest: record.runDigest,
    material,
  });
  const earliestCellPostAt = await deriveEarliestCellPostAt({
    projection,
    runDigest: record.runDigest,
    material,
  });
  if (runDigestAnchorAt === undefined || earliestCellPostAt === undefined) {
    return fail("could not rederive transcript timestamps");
  }
  if (
    runDigestAnchorAt !== record.transcript.runDigestAnchorAt
    || earliestCellPostAt !== record.transcript.earliestCellPostAt
  ) {
    return fail("transcript timestamps do not match rederived pair");
  }
  const check = checkPreregistrationAnchoredOrder({
    runAnnouncedAt: runDigestAnchorAt,
    earliestCellPostAt,
  });
  if (!check.ok) return fail(check.detail);
  return { status: "present", record };
}
