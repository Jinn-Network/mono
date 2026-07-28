import { z } from "zod";
import {
  EvidenceRecordReferenceSchema,
  ResourceDescriptorSchema,
  Rfc3339,
  Sha256Digest,
  UrnUuid,
} from "./common.js";

const TYPE_PREFIX = "network.jinn.task-execution.";

/**
 * The 11 observation types (§10.2), reverse-DNS prefixed. This is the single source of truth
 * for the literal type strings — `events.ts` (Task 1.5) imports them from here rather than
 * re-declaring a parallel list.
 */
export const SUBMISSION_OBSERVATION_TYPES = [
  `${TYPE_PREFIX}submission-accepted.v1`,
  `${TYPE_PREFIX}submission-rejected.v1`,
  `${TYPE_PREFIX}submission-closed.v1`,
] as const;

export const ATTEMPT_OBSERVATION_TYPES = [
  `${TYPE_PREFIX}attempt-engaged.v1`,
  `${TYPE_PREFIX}attempt-started.v1`,
  `${TYPE_PREFIX}progress.v1`,
  `${TYPE_PREFIX}cancel-requested.v1`,
  `${TYPE_PREFIX}cancel-acknowledged.v1`,
  `${TYPE_PREFIX}execution-observed.v1`,
  `${TYPE_PREFIX}delivery-recorded.v1`,
  `${TYPE_PREFIX}attempt-terminal.v1`,
] as const;

export const OBSERVATION_TYPES = [
  ...SUBMISSION_OBSERVATION_TYPES,
  ...ATTEMPT_OBSERVATION_TYPES,
] as const;

// Bounded free text (§10.2/§20): observation payloads carry identifiers, digests, categories,
// and bounded free text only — never task instructions, input content, or artifact content.
const BoundedMessage = z.string().max(4096);

const SubmissionAcceptedDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}submission-accepted.v1`),
  data: z.object({
    submission: UrnUuid,
    task: Sha256Digest,
  }),
});

const SubmissionRejectedDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}submission-rejected.v1`),
  data: z.object({
    category: z.string(), // one of the §13 error categories (errors.ts owns the frozen vocabulary)
    detail: BoundedMessage.optional(),
  }),
});

const SubmissionClosedDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}submission-closed.v1`),
  data: z.object({
    reason: z.enum(["deadline", "requester-close", "capacity"]),
  }),
});

const AttemptEngagedDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}attempt-engaged.v1`),
  data: z.object({
    attempt: UrnUuid,
    task: Sha256Digest,
    submission: UrnUuid,
    executor: z.string().optional(),
    effectiveDeadline: Rfc3339,
    source: z.string(), // the authoritative observation-producer source URI (§10.1)
    dispatchContext: ResourceDescriptorSchema,
    annotations: z.record(z.string(), z.unknown()).optional(),
  }),
});

const AttemptStartedDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}attempt-started.v1`),
  data: z.object({
    startedAt: Rfc3339,
    executor: z.string().optional(),
  }),
});

const ProgressDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}progress.v1`),
  data: z.object({
    message: BoundedMessage.optional(),
    fraction: z.number().min(0).max(1).optional(),
  }),
});

const CancelRequestedDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}cancel-requested.v1`),
  data: z.object({
    reason: BoundedMessage,
    requestedBy: z.string(),
  }),
});

const CancelAcknowledgedDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}cancel-acknowledged.v1`),
  data: z.object({
    acknowledgedBy: z.string(),
  }),
});

const ExecutionObservedDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}execution-observed.v1`),
  data: z.object({
    executionId: UrnUuid,
    evidenceRecord: EvidenceRecordReferenceSchema.optional(),
  }),
});

const DeliveryRecordedDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}delivery-recorded.v1`),
  data: z.object({
    digest: Sha256Digest,
    locators: ResourceDescriptorSchema.optional(),
  }),
});

const AttemptTerminalDataSchema = z.object({
  type: z.literal(`${TYPE_PREFIX}attempt-terminal.v1`),
  data: z.object({
    state: z.enum(["delivered", "failed", "rejected", "cancelled", "expired", "lost"]),
    blame: z.enum(["task", "infrastructure"]).optional(),
    category: z.string().optional(), // one of the §13 error categories, where applicable
    detail: BoundedMessage.optional(),
  }),
});

const ObservationPayloadSchema = z.discriminatedUnion("type", [
  SubmissionAcceptedDataSchema,
  SubmissionRejectedDataSchema,
  SubmissionClosedDataSchema,
  AttemptEngagedDataSchema,
  AttemptStartedDataSchema,
  ProgressDataSchema,
  CancelRequestedDataSchema,
  CancelAcknowledgedDataSchema,
  ExecutionObservedDataSchema,
  DeliveryRecordedDataSchema,
  AttemptTerminalDataSchema,
]);

/**
 * The CloudEvents v1.0 JSON envelope (§10.1) plus the §10.2 typed payload, joined via a
 * discriminated union on `type` so `data` is shaped correctly per event type.
 */
export const ProtocolObservationSchema = z
  .object({
    specversion: z.literal("1.0"),
    id: z.string(),
    source: z.string(),
    subject: z.string(), // the Attempt URI (attempt-scoped) or Submission URI (submission-scoped)
    time: Rfc3339,
    datacontenttype: z.literal("application/json"),
    dataschema: z.string().optional(),
    sequence: z.string().regex(/^\d{16}$/), // fixed-width, zero-padded 16-digit decimal (§10.1)
    taskdigest: Sha256Digest.optional(),
    traceparent: z.string().optional(),
  })
  .loose()
  .and(ObservationPayloadSchema);

export type ProtocolObservation = z.infer<typeof ProtocolObservationSchema>;
