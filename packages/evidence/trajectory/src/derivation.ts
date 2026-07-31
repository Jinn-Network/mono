// SPDX-License-Identifier: Apache-2.0

import {
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from "@jinn-network/evidence-protocol";
import {
  type DsseSigner,
  dssePreAuthEncoding,
  isCalendarStrictRfc3339,
  parseDsseEnvelope,
  sealSignedRecord,
} from "@jinn-network/trust-core";
import { z } from "zod";

import {
  type BareSha256Hex,
  type RepositorySha256Digest,
  toBareSha256Hex,
  toRepositorySha256Digest,
} from "./digests.js";
import { documentDigest } from "./hashing.js";
import {
  TRAJECTORY_DERIVATION_PREDICATE_TYPE,
  TRAJECTORY_MEDIA_TYPE,
  TRAJECTORY_SUBJECT_NAME,
  TRAJECTORY_VOCABULARY_PROFILE,
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
} from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { parseTrajectory } from "./schema.js";
import { type Timebase, TIMEBASES } from "./timebase.js";

const AbsoluteIri = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u, "must be an absolute IRI");

const BareSha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

const TrajectoryDerivationPredicateSchema = z.strictObject({
  derivedAt: z.string(),
  producer: z.strictObject({ id: z.string().min(1) }),
  trajectorySubject: z.literal(TRAJECTORY_SUBJECT_NAME),
  execution: z.strictObject({
    name: z.literal("execution.json"),
    digest: z.strictObject({ sha256: BareSha256HexSchema }),
    mediaType: z.string().optional(),
  }),
  nativeTrace: z.strictObject({
    name: z.literal("native-trace.bin"),
    digest: z.strictObject({ sha256: BareSha256HexSchema }),
  }),
  formatIri: AbsoluteIri,
  decoderId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  decoderVersion: z.string().min(1),
  vocabularyProfile: z.literal(TRAJECTORY_VOCABULARY_PROFILE),
  timebase: z.enum(TIMEBASES),
});

const TrajectoryDerivationStatementSchema = z.strictObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.tuple([
    z.strictObject({
      name: z.literal(TRAJECTORY_SUBJECT_NAME),
      digest: z.strictObject({ sha256: BareSha256HexSchema }),
      mediaType: z.literal(TRAJECTORY_MEDIA_TYPE),
    }),
  ]),
  predicateType: z.literal(TRAJECTORY_DERIVATION_PREDICATE_TYPE),
  predicate: TrajectoryDerivationPredicateSchema,
});

export interface BuildTrajectoryDerivationStatementInput {
  readonly producerId: string;
  readonly executionDigest: RepositorySha256Digest;
  readonly trajectoryDigest: RepositorySha256Digest;
  readonly nativeTraceDigest: RepositorySha256Digest;
  readonly formatIri: string;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly vocabularyProfile: typeof TRAJECTORY_VOCABULARY_PROFILE;
  readonly timebase: Timebase;
  readonly derivedAt: string;
}

export interface TrajectoryDerivationPredicate {
  readonly derivedAt: string;
  readonly producer: { readonly id: string };
  readonly trajectorySubject: typeof TRAJECTORY_SUBJECT_NAME;
  readonly execution: {
    readonly name: "execution.json";
    readonly digest: { readonly sha256: BareSha256Hex };
    readonly mediaType?: string;
  };
  readonly nativeTrace: {
    readonly name: "native-trace.bin";
    readonly digest: { readonly sha256: BareSha256Hex };
  };
  readonly formatIri: string;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly vocabularyProfile: typeof TRAJECTORY_VOCABULARY_PROFILE;
  readonly timebase: Timebase;
}

export interface TrajectoryDerivationStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_TYPE;
  readonly subject: readonly [
    {
      readonly name: typeof TRAJECTORY_SUBJECT_NAME;
      readonly digest: { readonly sha256: BareSha256Hex };
      readonly mediaType: typeof TRAJECTORY_MEDIA_TYPE;
    },
  ];
  readonly predicateType: typeof TRAJECTORY_DERIVATION_PREDICATE_TYPE;
  readonly predicate: TrajectoryDerivationPredicate;
}

export interface SealTrajectoryDerivationAttestationInput {
  readonly statement: TrajectoryDerivationStatement;
  readonly signer: DsseSigner;
  readonly signal?: AbortSignal;
}

export interface SealedTrajectoryDerivationAttestation {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly statement: TrajectoryDerivationStatement;
  readonly digest: RepositorySha256Digest;
}

export interface TrajectoryDerivationAuthorityVerifierInput {
  readonly envelopeBytes: Uint8Array;
  readonly payloadType: typeof DSSE_PAYLOAD_TYPE;
  readonly payloadBytes: Uint8Array;
  readonly preAuthEncoding: Uint8Array;
  readonly producerId: string;
  readonly derivedAt: string;
  readonly signal?: AbortSignal;
}

export type TrajectoryDerivationAuthorityVerifierResult =
  | { readonly verified: true; readonly signerKeyIds: readonly string[]; readonly detail?: string }
  | {
      readonly verified: false;
      readonly signerKeyIds?: readonly string[];
      readonly reason: string;
      readonly detail?: string;
    };

export type TrajectoryDerivationAuthorityVerifier = (
  input: TrajectoryDerivationAuthorityVerifierInput,
) => Promise<TrajectoryDerivationAuthorityVerifierResult>;

export interface VerifyTrajectoryDerivationAttestationInput {
  readonly envelopeBytes: Uint8Array;
  readonly executionRecordBytes: Uint8Array;
  readonly trajectoryRecordBytes: Uint8Array;
  readonly verifyAuthority: TrajectoryDerivationAuthorityVerifier;
  readonly signal?: AbortSignal;
}

export type TrajectoryDerivationLayerOutcome =
  | { readonly status: "pass" }
  | { readonly status: "fail"; readonly code: string; readonly message: string }
  | { readonly status: "not-evaluated"; readonly reason: string };

export interface TrajectoryDerivationVerificationLayers {
  readonly l1: TrajectoryDerivationLayerOutcome;
  readonly l2: TrajectoryDerivationLayerOutcome;
  readonly l3: TrajectoryDerivationLayerOutcome;
  readonly l4: TrajectoryDerivationLayerOutcome;
}

export type TrajectoryDerivationVerificationResult =
  | {
      readonly ok: true;
      readonly statement: TrajectoryDerivationStatement;
      readonly envelopeDigest: RepositorySha256Digest;
      readonly layers: {
        readonly l1: { readonly status: "pass" };
        readonly l2: { readonly status: "pass" };
        readonly l3: { readonly status: "pass" };
        readonly l4: { readonly status: "not-evaluated"; readonly reason: "replay-required" };
      };
      readonly signerKeyIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failedLayer: 1 | 2 | 3;
      readonly statement?: TrajectoryDerivationStatement;
      readonly layers: TrajectoryDerivationVerificationLayers;
      readonly reason: string;
      readonly code: string;
    };

function invalidInput(message: string): never {
  throw new InvalidDocumentError([{ path: "", message }]);
}

function parseStatementBytes(payloadBytes: Uint8Array): TrajectoryDerivationStatement {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    invalidInput("attestation payload is not valid UTF-8 JSON");
  }
  const parsed = TrajectoryDerivationStatementSchema.safeParse(decoded);
  if (!parsed.success) {
    invalidInput("attestation payload is not a valid Trajectory derivation statement");
  }
  if (!isCalendarStrictRfc3339(parsed.data.predicate.derivedAt)) {
    invalidInput("predicate.derivedAt must be calendar-strict RFC 3339");
  }
  return parsed.data;
}

export function buildTrajectoryDerivationStatement(
  input: BuildTrajectoryDerivationStatementInput,
): TrajectoryDerivationStatement {
  if (!input.producerId) invalidInput("producerId must be non-empty");
  if (!isCalendarStrictRfc3339(input.derivedAt)) {
    invalidInput("derivedAt must be calendar-strict RFC 3339");
  }
  if (input.vocabularyProfile !== TRAJECTORY_VOCABULARY_PROFILE) {
    invalidInput("vocabularyProfile must equal TRAJECTORY_VOCABULARY_PROFILE");
  }

  const executionHex = toBareSha256Hex(input.executionDigest);
  const trajectoryHex = toBareSha256Hex(input.trajectoryDigest);
  const nativeTraceHex = toBareSha256Hex(input.nativeTraceDigest);

  const statement: TrajectoryDerivationStatement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      {
        name: TRAJECTORY_SUBJECT_NAME,
        digest: { sha256: trajectoryHex },
        mediaType: TRAJECTORY_MEDIA_TYPE,
      },
    ],
    predicateType: TRAJECTORY_DERIVATION_PREDICATE_TYPE,
    predicate: {
      derivedAt: input.derivedAt,
      producer: { id: input.producerId },
      trajectorySubject: TRAJECTORY_SUBJECT_NAME,
      execution: {
        name: "execution.json",
        digest: { sha256: executionHex },
      },
      nativeTrace: {
        name: "native-trace.bin",
        digest: { sha256: nativeTraceHex },
      },
      formatIri: input.formatIri,
      decoderId: input.decoderId,
      decoderVersion: input.decoderVersion,
      vocabularyProfile: input.vocabularyProfile,
      timebase: input.timebase,
    },
  };

  const validated = TrajectoryDerivationStatementSchema.safeParse(statement);
  if (!validated.success) invalidInput("built statement failed structural validation");
  return validated.data;
}

export async function sealTrajectoryDerivationAttestation(
  input: SealTrajectoryDerivationAttestationInput,
): Promise<SealedTrajectoryDerivationAttestation> {
  const validated = TrajectoryDerivationStatementSchema.safeParse(input.statement);
  if (!validated.success) invalidInput("statement failed structural validation");
  if (!isCalendarStrictRfc3339(validated.data.predicate.derivedAt)) {
    invalidInput("predicate.derivedAt must be calendar-strict RFC 3339");
  }

  const sealed = await sealSignedRecord({
    record: validated.data,
    payloadType: DSSE_PAYLOAD_TYPE,
    signer: input.signer,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  return {
    envelopeBytes: sealed.envelopeBytes,
    payloadBytes: sealed.payloadBytes,
    statement: validated.data,
    digest: sealed.recordDigest as RepositorySha256Digest,
  };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entityTypes(entity: JsonObject): readonly string[] {
  const type = entity["@type"];
  if (type === undefined) return [];
  return Array.isArray(type) ? type.map(String) : [String(type)];
}

function hasType(entity: JsonObject, type: string): boolean {
  return entityTypes(entity).includes(type);
}

function identifierEntries(entity: JsonObject): readonly JsonObject[] {
  const identifier = entity["identifier"];
  if (identifier === undefined) return [];
  return (Array.isArray(identifier) ? identifier : [identifier]).filter(isObject);
}

function findForwardLinkMatches(
  executionRecordBytes: Uint8Array,
  nativeTraceHex: BareSha256Hex,
  trajectoryDigest: RepositorySha256Digest,
): { readonly code?: string; readonly message?: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(executionRecordBytes));
  } catch {
    return { code: "l3-forward-link-missing", message: "execution record is not valid JSON" };
  }
  if (!isObject(decoded) || !Array.isArray(decoded["@graph"])) {
    return { code: "l3-forward-link-missing", message: "execution record has no @graph" };
  }

  const nativeTraceFiles = (decoded["@graph"] as unknown[]).filter(
    (entity): entity is JsonObject =>
      isObject(entity) && hasType(entity, "File") && entity["sha256"] === nativeTraceHex,
  );
  if (nativeTraceFiles.length === 0) {
    return {
      code: "l3-forward-link-missing",
      message: "execution record has no native-trace File entity matching attested digest",
    };
  }

  let matchCount = 0;
  for (const file of nativeTraceFiles) {
    for (const identifier of identifierEntries(file)) {
      if (identifier["propertyID"] !== TRAJECTORY_RECORD_IDENTIFIER_PROPERTY) continue;
      if (identifier["value"] === trajectoryDigest) matchCount += 1;
    }
  }

  if (matchCount === 0) {
    return { code: "l3-forward-link-missing", message: "trajectory forward link is missing" };
  }
  if (matchCount > 1) {
    return { code: "l3-forward-link-duplicate", message: "trajectory forward link is duplicated" };
  }
  return {};
}

function l4NotEvaluated(): TrajectoryDerivationLayerOutcome {
  return { status: "not-evaluated", reason: "replay-required" };
}

export async function verifyTrajectoryDerivationAttestation(
  input: VerifyTrajectoryDerivationAttestationInput,
): Promise<TrajectoryDerivationVerificationResult> {
  const l4 = l4NotEvaluated();
  let statement: TrajectoryDerivationStatement | undefined;

  let parsedEnvelope;
  try {
    parsedEnvelope = parseDsseEnvelope(input.envelopeBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "malformed DSSE envelope";
    return {
      ok: false,
      failedLayer: 1,
      layers: {
        l1: { status: "fail", code: "l1-envelope-malformed", message },
        l2: { status: "not-evaluated", reason: "l1-failed" },
        l3: { status: "not-evaluated", reason: "l1-failed" },
        l4,
      },
      reason: message,
      code: "l1-envelope-malformed",
    };
  }

  if (parsedEnvelope.payloadType !== DSSE_PAYLOAD_TYPE) {
    const message = `payloadType must be ${DSSE_PAYLOAD_TYPE}`;
    return {
      ok: false,
      failedLayer: 1,
      layers: {
        l1: { status: "fail", code: "l1-payload-type-mismatch", message },
        l2: { status: "not-evaluated", reason: "l1-failed" },
        l3: { status: "not-evaluated", reason: "l1-failed" },
        l4,
      },
      reason: message,
      code: "l1-payload-type-mismatch",
    };
  }

  try {
    statement = parseStatementBytes(parsedEnvelope.payloadBytes);
  } catch (error) {
    const message =
      error instanceof InvalidDocumentError
        ? error.errors[0]?.message ?? error.message
        : error instanceof Error
          ? error.message
          : "malformed attestation payload";
    return {
      ok: false,
      failedLayer: 1,
      layers: {
        l1: { status: "fail", code: "l1-statement-malformed", message },
        l2: { status: "not-evaluated", reason: "l1-failed" },
        l3: { status: "not-evaluated", reason: "l1-failed" },
        l4,
      },
      reason: message,
      code: "l1-statement-malformed",
    };
  }

  const preAuthEncoding = dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, parsedEnvelope.payloadBytes);
  let authorityResult: TrajectoryDerivationAuthorityVerifierResult;
  try {
    authorityResult = await input.verifyAuthority({
      envelopeBytes: input.envelopeBytes,
      payloadType: DSSE_PAYLOAD_TYPE,
      payloadBytes: parsedEnvelope.payloadBytes,
      preAuthEncoding,
      producerId: statement.predicate.producer.id,
      derivedAt: statement.predicate.derivedAt,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "authority verifier threw";
    return {
      ok: false,
      failedLayer: 2,
      statement,
      layers: {
        l1: { status: "pass" },
        l2: { status: "fail", code: "l2-authority-error", message },
        l3: { status: "not-evaluated", reason: "l2-failed" },
        l4,
      },
      reason: message,
      code: "l2-authority-error",
    };
  }

  if (!authorityResult.verified) {
    const message = authorityResult.reason;
    return {
      ok: false,
      failedLayer: 2,
      statement,
      layers: {
        l1: { status: "pass" },
        l2: { status: "fail", code: "l2-authority-rejected", message },
        l3: { status: "not-evaluated", reason: "l2-failed" },
        l4,
      },
      reason: message,
      code: "l2-authority-rejected",
    };
  }

  const executionDigest = documentDigest(input.executionRecordBytes);
  const trajectoryDigest = documentDigest(input.trajectoryRecordBytes);
  const attestedExecution = `sha256:${statement.predicate.execution.digest.sha256}`;
  const attestedTrajectory = `sha256:${statement.subject[0].digest.sha256}`;

  if (executionDigest !== attestedExecution) {
    const message = "execution record digest does not match attestation";
    return {
      ok: false,
      failedLayer: 3,
      statement,
      layers: {
        l1: { status: "pass" },
        l2: { status: "pass" },
        l3: { status: "fail", code: "l3-execution-digest-mismatch", message },
        l4,
      },
      reason: message,
      code: "l3-execution-digest-mismatch",
    };
  }

  if (trajectoryDigest !== attestedTrajectory) {
    const message = "trajectory record digest does not match attestation subject";
    return {
      ok: false,
      failedLayer: 3,
      statement,
      layers: {
        l1: { status: "pass" },
        l2: { status: "pass" },
        l3: { status: "fail", code: "l3-trajectory-digest-mismatch", message },
        l4,
      },
      reason: message,
      code: "l3-trajectory-digest-mismatch",
    };
  }

  let trajectory;
  try {
    trajectory = parseTrajectory(input.trajectoryRecordBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "trajectory record failed parsing";
    return {
      ok: false,
      failedLayer: 3,
      statement,
      layers: {
        l1: { status: "pass" },
        l2: { status: "pass" },
        l3: { status: "fail", code: "l3-source-mismatch", message },
        l4,
      },
      reason: message,
      code: "l3-source-mismatch",
    };
  }

  const predicate = statement.predicate;
  if (
    trajectory.source.nativeTrace.digest.sha256 !== predicate.nativeTrace.digest.sha256 ||
    trajectory.source.formatIri !== predicate.formatIri ||
    trajectory.derivation.decoderId !== predicate.decoderId ||
    trajectory.derivation.decoderVersion !== predicate.decoderVersion ||
    trajectory.derivation.vocabularyProfile !== predicate.vocabularyProfile ||
    trajectory.timebase !== predicate.timebase
  ) {
    const message = "trajectory record fields do not match attestation predicate";
    return {
      ok: false,
      failedLayer: 3,
      statement,
      layers: {
        l1: { status: "pass" },
        l2: { status: "pass" },
        l3: { status: "fail", code: "l3-source-mismatch", message },
        l4,
      },
      reason: message,
      code: "l3-source-mismatch",
    };
  }

  const forwardLink = findForwardLinkMatches(
    input.executionRecordBytes,
    predicate.nativeTrace.digest.sha256,
    trajectoryDigest,
  );
  if (forwardLink.code) {
    const message = forwardLink.message ?? forwardLink.code;
    return {
      ok: false,
      failedLayer: 3,
      statement,
      layers: {
        l1: { status: "pass" },
        l2: { status: "pass" },
        l3: { status: "fail", code: forwardLink.code, message },
        l4,
      },
      reason: message,
      code: forwardLink.code,
    };
  }

  return {
    ok: true,
    statement,
    envelopeDigest: documentDigest(input.envelopeBytes),
    layers: {
      l1: { status: "pass" },
      l2: { status: "pass" },
      l3: { status: "pass" },
      l4: { status: "not-evaluated", reason: "replay-required" },
    },
    signerKeyIds: authorityResult.signerKeyIds,
  };
}

export {
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
  TRAJECTORY_SUBJECT_NAME,
} from "./identifiers.js";
