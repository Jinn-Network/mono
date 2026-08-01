// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

import {
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from "@jinn-network/evidence-protocol";
import {
  type DsseSigner,
  dssePreAuthEncoding,
  isCalendarStrictRfc3339,
  parseExactDsseEnvelope,
  sealSignedRecord,
} from "@jinn-network/trust-core";
import { z } from "zod";

import { validateAuthorityResult } from "./authority-validation.js";
import { defensiveCopy } from "./bytes.js";
import {
  type BareSha256Hex,
  type RepositorySha256Digest,
  toBareSha256Hex,
  toRepositorySha256Digest,
} from "./digests.js";
import { type JsonValue, serializeCanonicalJson } from "./canonical.js";
import { documentDigest } from "./hashing.js";
import { verifyExecutionLinkage } from "./execution-linkage.js";
import {
  isAbortLikeError,
  isGenuineAbortSignal,
  normalizeThrownError,
  readAbortSignalAborted,
} from "./hostile-reflection.js";
import {
  LINKAGE_MODES,
  TRAJECTORY_DERIVATION_PREDICATE_TYPE,
  TRAJECTORY_MEDIA_TYPE,
  TRAJECTORY_SUBJECT_NAME,
  TRAJECTORY_VOCABULARY_PROFILE,
} from "./identifiers.js";
import type { LinkageMode } from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { parseTrajectory } from "./schema.js";
import { preflightCanonicalInput } from "./preflight.js";
import { snapshotBuildPort, snapshotSealPort, snapshotVerifyPort } from "./port-snapshot.js";
import { hardenedSchema } from "./schema-facade.js";
import { snapshotSignerOutput } from "./signer-output-snapshot.js";
import {
  TrajectoryDerivationCancelledError,
  TrajectoryDerivationSigningError,
} from "./derivation-errors.js";
import { type Timebase, TIMEBASES } from "./timebase.js";

export {
  TrajectoryDerivationCancelledError,
  TrajectoryDerivationSigningError,
} from "./derivation-errors.js";

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal === undefined) return;
  if (!isGenuineAbortSignal(signal)) {
    invalidInput("signal must be a genuine AbortSignal when present");
  }
  if (readAbortSignalAborted(signal)) throw new TrajectoryDerivationCancelledError();
}

function isTrajectoryDerivationCancelled(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (isProxy(error)) return false;
  return error instanceof TrajectoryDerivationCancelledError;
}

function preflightAttestationJson(value: unknown, context: string): void {
  try {
    preflightCanonicalInput(value);
  } catch (error) {
    invalidInput(
      error instanceof Error
        ? `${context}: ${error.message}`
        : `${context}: document failed canonical preflight`,
    );
  }
}

function envelopeSignerKeyIds(
  signatures: readonly { readonly keyid?: string }[],
): readonly string[] {
  return signatures.flatMap((signature) =>
    typeof signature.keyid === "string" && signature.keyid.length > 0 ? [signature.keyid] : [],
  );
}

function statementPayloadMatchesCanonical(
  statement: TrajectoryDerivationStatement,
  payloadBytes: Uint8Array,
): boolean {
  const canonical = serializeCanonicalJson(statement as unknown as JsonValue);
  if (canonical.length !== payloadBytes.length) return false;
  for (let index = 0; index < canonical.length; index += 1) {
    if (canonical[index] !== payloadBytes[index]) return false;
  }
  return true;
}


const AbsoluteIri = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u, "must be an absolute IRI");

const BareSha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

const TrajectoryDerivationPredicateSchema = z.strictObject({
  derivedAt: z
    .string()
    .refine(isCalendarStrictRfc3339, { message: "derivedAt must be calendar-strict RFC 3339" }),
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
  linkageMode: z.enum(LINKAGE_MODES),
});

const TrajectoryDerivationStatementCoreSchema = z.strictObject({
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

/** Public facade for derivation-statement structural validation. */
export const TrajectoryDerivationStatementSchema = hardenedSchema(
  TrajectoryDerivationStatementCoreSchema,
);

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
  readonly linkageMode: LinkageMode;
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
  readonly linkageMode: LinkageMode;
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
  const parsed = TrajectoryDerivationStatementCoreSchema.safeParse(decoded);
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
  const port = snapshotBuildPort(input);
  preflightAttestationJson(port, "derivation statement input");
  if (!port.producerId) invalidInput("producerId must be non-empty");
  if (!isCalendarStrictRfc3339(port.derivedAt)) {
    invalidInput("derivedAt must be calendar-strict RFC 3339");
  }
  if (port.vocabularyProfile !== TRAJECTORY_VOCABULARY_PROFILE) {
    invalidInput("vocabularyProfile must equal TRAJECTORY_VOCABULARY_PROFILE");
  }

  const executionHex = toBareSha256Hex(port.executionDigest);
  const trajectoryHex = toBareSha256Hex(port.trajectoryDigest);
  const nativeTraceHex = toBareSha256Hex(port.nativeTraceDigest);

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
      derivedAt: port.derivedAt,
      producer: { id: port.producerId },
      trajectorySubject: TRAJECTORY_SUBJECT_NAME,
      execution: {
        name: "execution.json",
        digest: { sha256: executionHex },
      },
      nativeTrace: {
        name: "native-trace.bin",
        digest: { sha256: nativeTraceHex },
      },
      formatIri: port.formatIri,
      decoderId: port.decoderId,
      decoderVersion: port.decoderVersion,
      vocabularyProfile: port.vocabularyProfile as typeof TRAJECTORY_VOCABULARY_PROFILE,
      timebase: port.timebase,
      linkageMode: port.linkageMode,
    },
  };

  const validated = TrajectoryDerivationStatementCoreSchema.safeParse(statement);
  if (!validated.success) invalidInput("built statement failed structural validation");
  return validated.data;
}

export async function sealTrajectoryDerivationAttestation(
  input: SealTrajectoryDerivationAttestationInput,
): Promise<SealedTrajectoryDerivationAttestation> {
  const port = snapshotSealPort(input);
  assertNotCancelled(port.signal);
  preflightAttestationJson(port.statement, "derivation attestation statement");
  const validated = TrajectoryDerivationStatementCoreSchema.safeParse(port.statement);
  if (!validated.success) invalidInput("statement failed structural validation");
  if (!isCalendarStrictRfc3339(validated.data.predicate.derivedAt)) {
    invalidInput("predicate.derivedAt must be calendar-strict RFC 3339");
  }

  const guardedSigner: DsseSigner = async (request) => {
    assertNotCancelled(port.signal);
    try {
      const signatures = await port.signer({
        payloadType: request.payloadType,
        payloadBytes: defensiveCopy(request.payloadBytes),
        preAuthEncoding: defensiveCopy(request.preAuthEncoding),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      assertNotCancelled(port.signal);
      return snapshotSignerOutput(signatures);
    } catch (error) {
      if (isTrajectoryDerivationCancelled(error)) throw error;
      if (port.signal !== undefined && readAbortSignalAborted(port.signal)) {
        throw new TrajectoryDerivationCancelledError();
      }
      if (isAbortLikeError(error)) throw new TrajectoryDerivationCancelledError();
      throw new TrajectoryDerivationSigningError();
    }
  };

  assertNotCancelled(port.signal);
  const sealed = await sealSignedRecord({
    record: validated.data,
    payloadType: DSSE_PAYLOAD_TYPE,
    signer: guardedSigner,
    ...(port.signal === undefined ? {} : { signal: port.signal }),
  });

  return {
    envelopeBytes: sealed.envelopeBytes,
    payloadBytes: sealed.payloadBytes,
    statement: validated.data,
    digest: sealed.recordDigest as RepositorySha256Digest,
  };
}

type JsonObject = Record<string, unknown>;

function authorityMalformedResult(
  statement: TrajectoryDerivationStatement,
  message: string,
  l4: TrajectoryDerivationLayerOutcome,
): TrajectoryDerivationVerificationResult {
  return {
    ok: false,
    failedLayer: 2,
    statement,
    layers: {
      l1: { status: "pass" },
      l2: { status: "fail", code: "l2-authority-malformed", message },
      l3: { status: "not-evaluated", reason: "l2-failed" },
      l4,
    },
    reason: message,
    code: "l2-authority-malformed",
  };
}

function isRevokedProxyDeliveryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || isProxy(error)) {
    return false;
  }
  return (
    error instanceof Error &&
    /proxy that has been revoked|revoked Proxy/u.test(error.message)
  );
}

function l4NotEvaluated(): TrajectoryDerivationLayerOutcome {
  return { status: "not-evaluated", reason: "replay-required" };
}

export async function verifyTrajectoryDerivationAttestation(
  input: VerifyTrajectoryDerivationAttestationInput,
): Promise<TrajectoryDerivationVerificationResult> {
  const port = snapshotVerifyPort(input);
  const l4 = l4NotEvaluated();
  let statement: TrajectoryDerivationStatement | undefined;

  let parsedEnvelope;
  try {
    parsedEnvelope = parseExactDsseEnvelope(port.envelopeBytes);
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

  const privatePayloadBytes = defensiveCopy(parsedEnvelope.payloadBytes);

  if (!statementPayloadMatchesCanonical(statement, privatePayloadBytes)) {
    const message = "attestation payload is not the canonical encoding of the validated statement";
    return {
      ok: false,
      failedLayer: 1,
      statement,
      layers: {
        l1: { status: "fail", code: "l1-payload-noncanonical", message },
        l2: { status: "not-evaluated", reason: "l1-failed" },
        l3: { status: "not-evaluated", reason: "l1-failed" },
        l4,
      },
      reason: message,
      code: "l1-payload-noncanonical",
    };
  }

  const preAuthEncoding = dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, privatePayloadBytes);
  const envelopeKeyIds = envelopeSignerKeyIds(parsedEnvelope.signatures);
  let authorityResult: TrajectoryDerivationAuthorityVerifierResult;
  try {
    assertNotCancelled(port.signal);
    let rawAuthorityResult: unknown;
    try {
      rawAuthorityResult = await port.verifyAuthority({
        envelopeBytes: defensiveCopy(port.envelopeBytes),
        payloadType: DSSE_PAYLOAD_TYPE,
        payloadBytes: defensiveCopy(privatePayloadBytes),
        preAuthEncoding: defensiveCopy(preAuthEncoding),
        producerId: statement.predicate.producer.id,
        derivedAt: statement.predicate.derivedAt,
        ...(port.signal === undefined ? {} : { signal: port.signal }),
      });
    } catch (error) {
      if (isRevokedProxyDeliveryError(error)) {
        return authorityMalformedResult(
          statement,
          "authority result must be a plain object",
          l4,
        );
      }
      throw error;
    }
    assertNotCancelled(port.signal);
    const validated = validateAuthorityResult(rawAuthorityResult, envelopeKeyIds);
    if (!validated.ok) {
      return authorityMalformedResult(statement, validated.message, l4);
    }
    authorityResult = validated.value;
  } catch (error) {
    if (isTrajectoryDerivationCancelled(error)) throw error;
    if (port.signal !== undefined && readAbortSignalAborted(port.signal)) {
      throw new TrajectoryDerivationCancelledError();
    }
    if (isAbortLikeError(error)) throw new TrajectoryDerivationCancelledError();
    const message = normalizeThrownError(error);
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

  if (authorityResult.verified !== true) {
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

  const executionDigest = documentDigest(port.executionRecordBytes);
  const trajectoryDigest = documentDigest(port.trajectoryRecordBytes);
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
    trajectory = parseTrajectory(port.trajectoryRecordBytes);
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

  const linkage = verifyExecutionLinkage(
    port.executionRecordBytes,
    predicate.nativeTrace.digest.sha256,
    trajectoryDigest,
    predicate.linkageMode,
  );
  if (linkage.code) {
    const message = linkage.message ?? linkage.code;
    return {
      ok: false,
      failedLayer: 3,
      statement,
      layers: {
        l1: { status: "pass" },
        l2: { status: "pass" },
        l3: { status: "fail", code: linkage.code, message },
        l4,
      },
      reason: message,
      code: linkage.code,
    };
  }

  return {
    ok: true,
    statement,
    envelopeDigest: documentDigest(port.envelopeBytes),
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
