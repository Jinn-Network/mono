import { ProtocolObservationSchema, type ProtocolObservation } from "@jinn-network/task-execution-protocol";
import { z } from "zod";
import { AgentIriSchema, DigestBearingResourceDescriptorSchema } from "../descriptors.js";
import { topLevelRecordSchema } from "../extensions.js";
import {
  BENCHMARK_ACCOUNTING_PROCEDURE,
  BENCHMARK_ACCOUNTING_PROCEDURE_VERSION,
  BENCHMARKING_PROTOCOL,
  BENCHMARK_OBSERVATION_ARCHIVE_PROFILE,
} from "../identifiers.js";
import { isJsonValue } from "../json.js";
import { compareCodeUnitStrings } from "../order.js";
import { isCalendarStrictRfc3339 } from "../rfc3339.js";
import { parseExactWithSchema, sealWithSchema, type SealedRecord } from "../sealing.js";
import { CellKeySchema } from "../run/cells.js";

const AbsoluteIriSchema = z.string().refine(
  (value) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value),
  "must be an absolute IRI",
);
const Rfc3339Schema = z.string().refine(isCalendarStrictRfc3339, "must be a calendar-valid RFC 3339 timestamp");
const SequenceSchema = z.string().regex(/^\d{16}$/, "must be a fixed-width 16 digit sequence");
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "must be sha256:<64 lowercase hex>");
const JsonValueSchema = z.unknown().refine(isJsonValue, "must be a losslessly representable JSON value");
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A kind-bearing exact record reference. Locations are descriptor hints, never identity. */
export const TypedRecordReferenceSchema = z.object({
  kind: AbsoluteIriSchema,
  record: DigestBearingResourceDescriptorSchema,
});

const SourceSchema = z.object({
  agent: AgentIriSchema,
  name: z.string().min(1),
});
const SourcePositionSchema = z.object({
  sequence: SequenceSchema,
  entry: DigestSchema,
});
const RecordDiscoveryBoundarySchema = z.object({
  kind: z.literal("record-discovery"),
  source: SourceSchema,
  position: SourcePositionSchema,
});
const SubstrateBoundarySchema = z.object({
  kind: z.literal("substrate"),
  profile: AbsoluteIriSchema,
  authority: z.string().min(1),
  anchor: JsonValueSchema,
});
export const RegistrationBoundarySchema = z.discriminatedUnion("kind", [
  RecordDiscoveryBoundarySchema,
  SubstrateBoundarySchema,
]);

const RecordDiscoveryScopeStreamSchema = z.object({
  role: AbsoluteIriSchema,
  kind: z.literal("record-discovery"),
  source: SourceSchema,
  through: SourcePositionSchema,
});
const SubstrateScopeStreamSchema = z.object({
  role: AbsoluteIriSchema,
  kind: z.literal("substrate"),
  profile: AbsoluteIriSchema,
  authority: z.string().min(1),
  through: JsonValueSchema,
});
export const AccountingScopeStreamSchema = z.discriminatedUnion("kind", [
  RecordDiscoveryScopeStreamSchema,
  SubstrateScopeStreamSchema,
]);

const PublicRegistrationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pre-dispatch"),
    runBoundary: RegistrationBoundarySchema,
    firstDispatchBoundary: RegistrationBoundarySchema,
  }),
  z.object({ status: z.literal("post-hoc") }),
  z.object({
    status: z.literal("unverifiable"),
    runBoundary: RegistrationBoundarySchema.optional(),
    firstDispatchBoundary: RegistrationBoundarySchema.optional(),
  }),
]);

const CloseBoundarySchema = z.object({
  at: Rfc3339Schema,
  anchor: z.object({
    chain: z.string(),
    blockNumber: z.number().int().nonnegative(),
    blockHash: z.string(),
  }).optional(),
});

const ArtifactReferenceSchema = z.object({
  role: AbsoluteIriSchema,
  artifact: DigestBearingResourceDescriptorSchema,
});
const NativeArtifactSchema = z.object({
  role: AbsoluteIriSchema,
  availability: z.enum(["public", "digest-only", "source-absent", "collection-failed"]),
  artifact: DigestBearingResourceDescriptorSchema.optional(),
  reason: z.string().min(1).refine((value) => value.trim().length > 0, "reason must not be blank").optional(),
}).superRefine((artifact, ctx) => {
  if (artifact.availability === "public" && artifact.artifact === undefined) {
    ctx.addIssue({ code: "custom", path: ["artifact"], message: "public native artifacts require a digest-bearing descriptor" });
  }
  if (artifact.availability !== "public" && (artifact.reason === undefined || artifact.reason.trim() === "")) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "non-public native artifacts require a non-blank reason" });
  }
});

const AccountingDispatchSchema = z.object({
  index: PositiveSafeIntegerSchema,
  submission: TypedRecordReferenceSchema,
  attempt: AgentIriSchema.optional(),
  observations: DigestBearingResourceDescriptorSchema.optional(),
  delivery: TypedRecordReferenceSchema.optional(),
  evidence: z.array(TypedRecordReferenceSchema),
  evaluations: z.array(TypedRecordReferenceSchema),
  correlations: z.array(ArtifactReferenceSchema),
  nativeArtifacts: z.array(NativeArtifactSchema),
});

const AccountingCellSchema = z.object({
  cellKey: CellKeySchema,
  dispatches: z.array(AccountingDispatchSchema),
});

function sortedBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  return values.every((value, index) => index === 0 || compareCodeUnitStrings(key(values[index - 1]!), key(value)) < 0);
}

function sameSource(left: z.infer<typeof SourceSchema>, right: z.infer<typeof SourceSchema>): boolean {
  return left.agent === right.agent && left.name === right.name;
}

/** Sealed publisher claim of the dispatch/evidence closure; it deliberately contains no outcomes. */
export const BenchmarkAccountingRecordSchema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL),
  run: DigestBearingResourceDescriptorSchema,
  publisher: AgentIriSchema,
  procedure: z.object({
    id: z.literal(BENCHMARK_ACCOUNTING_PROCEDURE),
    version: z.literal(BENCHMARK_ACCOUNTING_PROCEDURE_VERSION),
  }),
  scope: z.object({ streams: z.array(AccountingScopeStreamSchema).min(1) }),
  publicRegistration: PublicRegistrationSchema,
  closeBoundary: CloseBoundarySchema,
  cells: z.array(AccountingCellSchema),
}).superRefine((accounting, ctx) => {
  if (!sortedBy(accounting.scope.streams, (stream) => `${stream.role}\u001f${stream.kind}\u001f${stream.kind === "record-discovery" ? `${stream.source.agent}\u001f${stream.source.name}` : `${stream.profile}\u001f${stream.authority}`}`)) {
    ctx.addIssue({ code: "custom", path: ["scope", "streams"], message: "scope.streams must be deterministically sorted and unique" });
  }
  if (!sortedBy(accounting.cells, (cell) => cell.cellKey)) {
    ctx.addIssue({ code: "custom", path: ["cells"], message: "cells must be sorted and unique by cellKey (UTF-16 code-unit order)" });
  }
  for (const [cellIndex, cell] of accounting.cells.entries()) {
    for (const [dispatchIndex, dispatch] of cell.dispatches.entries()) {
      if (dispatch.index !== dispatchIndex + 1) {
        ctx.addIssue({ code: "custom", path: ["cells", cellIndex, "dispatches", dispatchIndex, "index"], message: "dispatch indices must begin at 1 and have no gaps" });
      }
    }
  }
  if (accounting.publicRegistration.status === "pre-dispatch") {
    const { runBoundary, firstDispatchBoundary } = accounting.publicRegistration;
    if (runBoundary.kind !== firstDispatchBoundary.kind) {
      ctx.addIssue({ code: "custom", path: ["publicRegistration"], message: "pre-dispatch boundaries must use one comparable ordering authority" });
    } else if (runBoundary.kind === "record-discovery" && firstDispatchBoundary.kind === "record-discovery" && !sameSource(runBoundary.source, firstDispatchBoundary.source)) {
      ctx.addIssue({ code: "custom", path: ["publicRegistration"], message: "record-discovery pre-dispatch boundaries must share an identical source" });
    }
  }
});

export type TypedRecordReference = z.infer<typeof TypedRecordReferenceSchema>;
export type RegistrationBoundary = z.infer<typeof RegistrationBoundarySchema>;
export type AccountingScopeStream = z.infer<typeof AccountingScopeStreamSchema>;
export type BenchmarkAccountingRecord = z.infer<typeof BenchmarkAccountingRecordSchema>;
export type BenchmarkAccountingCell = BenchmarkAccountingRecord["cells"][number];
export type BenchmarkAccountingDispatch = BenchmarkAccountingCell["dispatches"][number];

export function parseBenchmarkAccounting(bytes: Uint8Array): BenchmarkAccountingRecord {
  return parseExactWithSchema(BenchmarkAccountingRecordSchema, bytes);
}

export function sealBenchmarkAccounting(document: unknown): SealedRecord {
  return sealWithSchema(BenchmarkAccountingRecordSchema, document);
}

/** Draft 2020-12 cannot faithfully express TEP's open CloudEvents envelope intersected with its
 * discriminated payload union. Runtime delegates this sealed embedded object to TEP; the archive
 * schema keeps an intentionally open JSON slot rather than publishing a falsely rejecting wire
 * contract. */
const ArchivedObservationSchema = z.custom<ProtocolObservation>(
  (value) => ProtocolObservationSchema.safeParse(value).success,
  "must be a valid Task Execution Protocol observation",
);

const ObservationConflictSchema = z.object({
  source: z.string().min(1),
  id: z.string().min(1),
  observations: z.array(ArchivedObservationSchema).min(2),
});

const ObservationArchiveStreamSchema = z.object({
  source: z.string().min(1),
  subject: z.string().min(1),
  authority: z.enum(["authoritative", "corroborating"]),
  observations: z.array(ArchivedObservationSchema),
  conflicts: z.array(ObservationConflictSchema),
  exactEnvelopes: z.array(DigestBearingResourceDescriptorSchema),
});

/** A deterministic, sealed projection of validated observations, not a mutable protocol log. */
export const ObservationArchiveSchema = z.object({
  profile: z.literal(BENCHMARK_OBSERVATION_ARCHIVE_PROFILE),
  submission: DigestBearingResourceDescriptorSchema,
  capturedThrough: z.object({ at: Rfc3339Schema, cursor: z.string().min(1).optional() }),
  streams: z.array(ObservationArchiveStreamSchema),
}).superRefine((archive, ctx) => {
  if (!sortedBy(archive.streams, (stream) => `${stream.source}\u001f${stream.subject}`)) {
    ctx.addIssue({ code: "custom", path: ["streams"], message: "streams must be sorted and unique by source then subject (UTF-16 code-unit order)" });
  }
  const authoritativeBySubject = new Map<string, number>();
  for (const [streamIndex, stream] of archive.streams.entries()) {
    if (stream.authority === "authoritative") authoritativeBySubject.set(stream.subject, (authoritativeBySubject.get(stream.subject) ?? 0) + 1);
    if (!sortedBy(stream.observations, (observation) => `${observation.sequence}\u001f${observation.id}`)) {
      ctx.addIssue({ code: "custom", path: ["streams", streamIndex, "observations"], message: "observations must be deduplicated and sorted by sequence then id" });
    }
    const observationKeys = new Set<string>();
    for (const [observationIndex, observation] of stream.observations.entries()) {
      const key = `${observation.source}\u001f${observation.id}`;
      if (observation.source !== stream.source || observation.subject !== stream.subject) {
        ctx.addIssue({ code: "custom", path: ["streams", streamIndex, "observations", observationIndex], message: "every observation must belong to its source/subject stream" });
      }
      if (observationKeys.has(key)) {
        ctx.addIssue({ code: "custom", path: ["streams", streamIndex, "observations", observationIndex], message: "duplicate observation (source,id) must be retained as a conflict, not overwritten" });
      }
      observationKeys.add(key);
      if (observation.type === "network.jinn.task-execution.attempt-engaged.v1" && observation.data.source !== stream.source) {
        ctx.addIssue({ code: "custom", path: ["streams", streamIndex, "observations", observationIndex], message: "attempt-engaged authoritative source must equal its stream source" });
      }
    }
    for (const [conflictIndex, conflict] of stream.conflicts.entries()) {
      if (!conflict.observations.every((observation) => observation.source === stream.source && observation.subject === stream.subject && observation.source === conflict.source && observation.id === conflict.id)) {
        ctx.addIssue({ code: "custom", path: ["streams", streamIndex, "conflicts", conflictIndex], message: "conflict observations must retain one source/id within their stream" });
      }
      if (new Set(conflict.observations.map((value) => JSON.stringify(value))).size < 2) {
        ctx.addIssue({ code: "custom", path: ["streams", streamIndex, "conflicts", conflictIndex], message: "a conflict must contain non-equivalent observations" });
      }
    }
    if (!sortedBy(stream.exactEnvelopes, (descriptor) => `${descriptor.digest.sha256}\u001f${descriptor.name ?? ""}`)) {
      ctx.addIssue({ code: "custom", path: ["streams", streamIndex, "exactEnvelopes"], message: "exactEnvelopes must be sorted and unique by sha256 then name" });
    }
  }
  for (const [subject, count] of authoritativeBySubject) {
    if (count > 1) ctx.addIssue({ code: "custom", path: ["streams"], message: `subject ${subject} has more than one authoritative stream` });
  }
  for (const stream of archive.streams) {
    for (const observation of stream.observations) {
      if (observation.type !== "network.jinn.task-execution.attempt-engaged.v1") continue;
      const authoritative = archive.streams.filter((candidate) => candidate.subject === stream.subject && candidate.authority === "authoritative");
      if (authoritative.length !== 1 || authoritative[0]!.source !== observation.data.source) {
        ctx.addIssue({ code: "custom", path: ["streams"], message: "attempt-engaged observations must identify exactly one authoritative stream" });
      }
    }
  }
});

export type ObservationArchive = z.infer<typeof ObservationArchiveSchema>;
export type ObservationArchiveStream = ObservationArchive["streams"][number];
export type ObservationConflict = ObservationArchiveStream["conflicts"][number];

export function parseObservationArchive(bytes: Uint8Array): ObservationArchive {
  return parseExactWithSchema(ObservationArchiveSchema, bytes);
}

export function sealObservationArchive(document: unknown): SealedRecord {
  return sealWithSchema(ObservationArchiveSchema, document);
}
