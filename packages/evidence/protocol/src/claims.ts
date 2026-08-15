import type { ZodType, z } from "zod";

import { DSSE_PAYLOAD_TYPE } from "./identifiers.js";
import { recordDigest } from "./hashing.js";
import {
  DsseEnvelopeSchema,
  ExecutionVerificationStatementSchema,
  ResultEvaluationStatementSchema,
} from "./schemas.js";
import type {
  ConformanceDiagnostic,
  ConformanceDiagnosticCode,
  DsseSignatureReport,
  DsseSignatureVerifier,
  ExecutionVerificationEvidence,
  ResultEvaluationEvidence,
  ValidationReport,
} from "./types.js";
import { compareCodeUnitStrings } from "./order.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "";
  return `/${path
    .map((part) =>
      String(part)
        .replaceAll("~", "~0")
        .replaceAll("/", "~1"),
    )
    .join("/")}`;
}

function diagnostic(
  code: ConformanceDiagnosticCode,
  path: string,
  message: string,
): ConformanceDiagnostic {
  return { code, path, message };
}

function sortedDiagnostics(
  diagnostics: readonly ConformanceDiagnostic[],
): readonly ConformanceDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      compareCodeUnitStrings(left.path, right.path) ||
      compareCodeUnitStrings(left.code, right.code) ||
      compareCodeUnitStrings((left.entityId ?? ""), right.entityId ?? "") ||
      compareCodeUnitStrings(left.message, right.message),
  );
}

function parseJsonBytes(
  bytes: Uint8Array,
): { value?: unknown; diagnostic?: ConformanceDiagnostic } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      diagnostic: diagnostic(
        "UTF8_INVALID",
        "",
        "Input is not valid UTF-8.",
      ),
    };
  }

  try {
    return { value: JSON.parse(text) };
  } catch {
    return {
      diagnostic: diagnostic("JSON_INVALID", "", "Input is not valid JSON."),
    };
  }
}

function decodeBase64Strict(value: string): Uint8Array | undefined {
  if (value.length === 0 || /\s/.test(value)) return undefined;
  const hasStandard = /[+/]/.test(value);
  const hasUrlSafe = /[-_]/.test(value);
  if (hasStandard && hasUrlSafe) return undefined;
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) return undefined;
  const firstPadding = value.indexOf("=");
  if (firstPadding >= 0 && firstPadding < value.length - 2) return undefined;
  if (firstPadding >= 0 && value.length % 4 !== 0) return undefined;

  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return undefined;
  const normalized = unpadded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function schemaDiagnostics(
  error: z.ZodError,
  code: ConformanceDiagnosticCode,
  prefix = "",
): ConformanceDiagnostic[] {
  return error.issues.map((issue) =>
    diagnostic(
      code,
      `${prefix}${pointer(issue.path)}`,
      issue.message,
    ),
  );
}

function isAbsoluteIri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

interface ParsedEnvelope<TStatement> {
  envelope?: ReturnType<typeof DsseEnvelopeSchema.parse>;
  payloadBytes?: Uint8Array;
  statement?: TStatement;
  diagnostics: ConformanceDiagnostic[];
}

function parseEnvelope<TStatement>(
  envelopeBytes: Uint8Array,
  statementSchema: ZodType<TStatement>,
): ParsedEnvelope<TStatement> {
  const diagnostics: ConformanceDiagnostic[] = [];
  const decodedEnvelope = parseJsonBytes(envelopeBytes);
  if (decodedEnvelope.diagnostic) {
    diagnostics.push(decodedEnvelope.diagnostic);
    return { diagnostics };
  }
  if (!isObject(decodedEnvelope.value)) {
    diagnostics.push(
      diagnostic(
        "ATTESTATION_ENVELOPE_INVALID",
        "",
        "The DSSE envelope must be a JSON object.",
      ),
    );
    return { diagnostics };
  }

  if (decodedEnvelope.value.payloadType !== DSSE_PAYLOAD_TYPE) {
    diagnostics.push(
      diagnostic(
        "ATTESTATION_PAYLOAD_TYPE_INVALID",
        "/payloadType",
        `payloadType must be ${DSSE_PAYLOAD_TYPE}.`,
      ),
    );
  }
  if (
    !Array.isArray(decodedEnvelope.value.signatures) ||
    decodedEnvelope.value.signatures.length === 0
  ) {
    diagnostics.push(
      diagnostic(
        "ATTESTATION_SIGNATURE_MISSING",
        "/signatures",
        "At least one DSSE signature is required.",
      ),
    );
  }

  const envelopeResult = DsseEnvelopeSchema.safeParse(decodedEnvelope.value);
  if (!envelopeResult.success) {
    if (
      diagnostics.length === 0 ||
      envelopeResult.error.issues.some(
        (issue) =>
          issue.path[0] !== "payloadType" && issue.path[0] !== "signatures",
      )
    ) {
      diagnostics.push(
        ...schemaDiagnostics(
          envelopeResult.error,
          "ATTESTATION_ENVELOPE_INVALID",
        ).filter(
          ({ path }) =>
            !(
              path === "/payloadType" &&
              diagnostics.some(
                ({ code }) => code === "ATTESTATION_PAYLOAD_TYPE_INVALID",
              )
            ) &&
            !(
              path === "/signatures" &&
              diagnostics.some(
                ({ code }) => code === "ATTESTATION_SIGNATURE_MISSING",
              )
            ),
        ),
      );
    }
    return { diagnostics };
  }

  for (const [index, signature] of envelopeResult.data.signatures.entries()) {
    if (!decodeBase64Strict(signature.sig)) {
      diagnostics.push(
        diagnostic(
          "ATTESTATION_ENVELOPE_INVALID",
          `/signatures/${index}/sig`,
          "DSSE signature is not strict standard or URL-safe base64.",
        ),
      );
    }
  }

  const payloadBytes = decodeBase64Strict(envelopeResult.data.payload);
  if (!payloadBytes) {
    diagnostics.push(
      diagnostic(
        "ATTESTATION_PAYLOAD_INVALID",
        "/payload",
        "DSSE payload is not strict standard or URL-safe base64.",
      ),
    );
    return { envelope: envelopeResult.data, diagnostics };
  }

  const payload = parseJsonBytes(payloadBytes);
  if (payload.diagnostic) {
    diagnostics.push(
      diagnostic(
        "ATTESTATION_PAYLOAD_INVALID",
        "/payload",
        `Decoded DSSE payload: ${payload.diagnostic.message}`,
      ),
    );
    return { envelope: envelopeResult.data, payloadBytes, diagnostics };
  }

  const statementResult = statementSchema.safeParse(payload.value);
  if (!statementResult.success) {
    const correctionIssue = statementResult.error.issues.some((issue) =>
      issue.path.some(
        (part) => part === "supersedes" || part === "disputes",
      ),
    );
    diagnostics.push(
      ...schemaDiagnostics(
        statementResult.error,
        correctionIssue
          ? "CORRECTION_REFERENCE_INVALID"
          : "ATTESTATION_STATEMENT_INVALID",
        "/payload",
      ),
    );
    return { envelope: envelopeResult.data, payloadBytes, diagnostics };
  }

  return {
    envelope: envelopeResult.data,
    payloadBytes,
    statement: statementResult.data,
    diagnostics,
  };
}

function subjectDiagnostics(
  subjects: readonly { name: string }[],
): ConformanceDiagnostic[] {
  const diagnostics: ConformanceDiagnostic[] = [];
  const names = new Set<string>();
  for (const [index, subject] of subjects.entries()) {
    if (names.has(subject.name)) {
      diagnostics.push(
        diagnostic(
          "ATTESTATION_SUBJECT_INVALID",
          `/payload/subject/${index}/name`,
          `Subject name ${subject.name} is duplicated.`,
        ),
      );
    }
    names.add(subject.name);
  }
  return diagnostics;
}

export function validateResultEvaluation(
  envelopeBytes: Uint8Array,
): ValidationReport<ResultEvaluationEvidence> {
  const parsed = parseEnvelope(envelopeBytes, ResultEvaluationStatementSchema);
  const diagnostics = [...parsed.diagnostics];
  const statement = parsed.statement;

  if (statement) {
    diagnostics.push(...subjectDiagnostics(statement.subject));
    const names = new Set(statement.subject.map(({ name }) => name));
    const boundNames = [
      statement.predicate.taskSubject,
      ...statement.predicate.resultSubjects,
    ];
    const boundSet = new Set(boundNames);
    if (
      boundSet.size !== boundNames.length ||
      boundNames.some((name) => !names.has(name)) ||
      names.size !== boundSet.size ||
      [...names].some((name) => !boundSet.has(name))
    ) {
      diagnostics.push(
        diagnostic(
          "EVALUATION_SUBJECT_BINDING_INVALID",
          "/payload/predicate",
          "taskSubject and resultSubjects must bind every unique Statement subject exactly once.",
        ),
      );
    }
    if (!isAbsoluteIri(statement.predicate.evaluator.id)) {
      diagnostics.push(
        diagnostic(
          "AGENT_IRI_INVALID",
          "/payload/predicate/evaluator/id",
          "Evaluator id must be an absolute IRI.",
        ),
      );
    }
  }

  const ordered = sortedDiagnostics(diagnostics);
  const value =
    parsed.envelope && parsed.payloadBytes && statement
      ? {
          envelope: parsed.envelope,
          payloadBytes: parsed.payloadBytes,
          statement,
        }
      : undefined;
  return {
    conforms: ordered.length === 0,
    recordDigest: recordDigest(envelopeBytes),
    ...(value ? { value } : {}),
    diagnostics: ordered,
  };
}

export function validateExecutionVerification(
  envelopeBytes: Uint8Array,
): ValidationReport<ExecutionVerificationEvidence> {
  const parsed = parseEnvelope(
    envelopeBytes,
    ExecutionVerificationStatementSchema,
  );
  const diagnostics = [...parsed.diagnostics];
  const statement = parsed.statement;

  if (statement) {
    diagnostics.push(...subjectDiagnostics(statement.subject));
    if (
      statement.subject.length !== 1 ||
      statement.subject[0]?.name !== "ro-crate-metadata.json"
    ) {
      diagnostics.push(
        diagnostic(
          "VERIFICATION_SUBJECT_BINDING_INVALID",
          "/payload/subject",
          "Verification must have exactly one ro-crate-metadata.json subject.",
        ),
      );
    }
    if (!isAbsoluteIri(statement.predicate.executionId)) {
      diagnostics.push(
        diagnostic(
          "VERIFICATION_SUBJECT_BINDING_INVALID",
          "/payload/predicate/executionId",
          "executionId must be an absolute IRI.",
        ),
      );
    }
    if (!isAbsoluteIri(statement.predicate.verifier.id)) {
      diagnostics.push(
        diagnostic(
          "AGENT_IRI_INVALID",
          "/payload/predicate/verifier/id",
          "Verifier id must be an absolute IRI.",
        ),
      );
    }
  }

  const ordered = sortedDiagnostics(diagnostics);
  const value =
    parsed.envelope && parsed.payloadBytes && statement
      ? {
          envelope: parsed.envelope,
          payloadBytes: parsed.payloadBytes,
          statement,
        }
      : undefined;
  return {
    conforms: ordered.length === 0,
    recordDigest: recordDigest(envelopeBytes),
    ...(value ? { value } : {}),
    diagnostics: ordered,
  };
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export function dssePreAuthEncoding(
  payloadType: string,
  payloadBytes: Uint8Array,
): Uint8Array {
  const typeBytes = new TextEncoder().encode(payloadType);
  return concatenate([
    ascii("DSSEv1 "),
    ascii(String(typeBytes.length)),
    ascii(" "),
    typeBytes,
    ascii(" "),
    ascii(String(payloadBytes.length)),
    ascii(" "),
    payloadBytes,
  ]);
}

export async function verifyDsseSignatures(
  evidence: ResultEvaluationEvidence | ExecutionVerificationEvidence,
  verifier: DsseSignatureVerifier,
): Promise<DsseSignatureReport> {
  const preAuthEncoding = dssePreAuthEncoding(
    evidence.envelope.payloadType,
    evidence.payloadBytes,
  );
  const signatures = await Promise.all(
    evidence.envelope.signatures.map(async (signature, signatureIndex) => {
      const signatureBytes = decodeBase64Strict(signature.sig);
      if (!signatureBytes) {
        return {
          signatureIndex,
          ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
          verified: false,
          error: "Signature is not valid base64.",
        };
      }
      try {
        const verified = await verifier({
          payloadType: evidence.envelope.payloadType,
          payloadBytes: evidence.payloadBytes,
          preAuthEncoding,
          signature: signatureBytes,
          ...(signature.keyid === undefined
            ? {}
            : { keyid: signature.keyid }),
          signatureIndex,
        });
        return {
          signatureIndex,
          ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
          verified,
        };
      } catch (error) {
        return {
          signatureIndex,
          ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
          verified: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return {
    verified:
      signatures.length > 0 &&
      signatures.every((signature) => signature.verified),
    signatures,
  };
}
