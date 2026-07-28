import { recordDigest } from "@jinn-network/evidence-protocol";

import type {
  CandidateSourceIdentity,
  CandidateSourceReport,
  CreateSavedEvidenceQueryInput,
  JsonValue,
  ProviderQueryCodec,
  QuerySnapshotReceipt,
  SavedEvidenceQuery,
  Sha256Digest,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";

export const RETRIEVAL_SCHEMA_VERSION = "1.0.0" as const;
const encoder = new TextEncoder();
const SECRET_KEYS = new Set([
  "credentials",
  "password",
  "secret",
  "token",
  "privateendpoint",
  "signedurl",
  "privatekey",
]);
const LOGICAL_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as { readonly [k: string]: JsonValue })[key]!)}`,
  ).join(",")}}`;
}

function assertJsonValue(value: unknown, path = "$"): asserts value is JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase())) {
        throw new EvidenceRetrievalError(
          "INVALID_INPUT",
          `Saved provider query contains reserved key at ${path}.${key}.`,
        );
      }
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new EvidenceRetrievalError(
    "INVALID_INPUT",
    `Saved provider query is not JSON at ${path}.`,
  );
}

function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJson));
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, freezeJson(child)]),
  ));
}

function assertLogicalComponent(value: string, name: string): void {
  if (!LOGICAL_COMPONENT.test(value)) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `${name} must use a bounded logical component.`,
    );
  }
}

function assertCandidateSourceIdentity(identity: CandidateSourceIdentity): void {
  assertLogicalComponent(identity.id, "candidateSourceSet.id");
  assertLogicalComponent(identity.version, "candidateSourceSet.version");
}

function assertLogicalLimits(resultLimit: number, candidateBudget: number): void {
  if (!Number.isSafeInteger(resultLimit) || resultLimit <= 0) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "resultLimit must be a positive safe integer.",
    );
  }
  if (!Number.isSafeInteger(candidateBudget) || candidateBudget <= 0) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "candidateBudget must be a positive safe integer.",
    );
  }
  if (candidateBudget < resultLimit) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "candidateBudget must be greater than or equal to resultLimit.",
    );
  }
}

function validateSavedEnvelope(saved: SavedEvidenceQuery): void {
  if (saved.retrievalSchemaVersion !== RETRIEVAL_SCHEMA_VERSION) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `Saved query retrievalSchemaVersion must be ${RETRIEVAL_SCHEMA_VERSION}.`,
    );
  }
  assertCandidateSourceIdentity(saved.candidateSourceSet);
  assertLogicalComponent(saved.providerQuery.kind, "providerQuery.kind");
  assertLogicalComponent(
    saved.providerQuery.schemaVersion,
    "providerQuery.schemaVersion",
  );
  assertLogicalLimits(saved.resultLimit, saved.candidateBudget);
  assertJsonValue(saved.providerQuery.value, "$.providerQuery.value");
  if (saved.acceptancePolicy !== undefined) {
    assertLogicalComponent(saved.acceptancePolicy.id, "acceptancePolicy.id");
    assertLogicalComponent(
      saved.acceptancePolicy.version,
      "acceptancePolicy.version",
    );
    if (saved.acceptancePolicy.configuration !== undefined) {
      assertJsonValue(
        saved.acceptancePolicy.configuration,
        "$.acceptancePolicy.configuration",
      );
    }
  }
}

function assertExactSource(
  saved: CandidateSourceIdentity,
  expected: CandidateSourceIdentity,
): void {
  if (saved.id !== expected.id || saved.version !== expected.version) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "Saved query candidate source-set does not match the configured candidate source.",
    );
  }
}

function assertAcceptanceMatch(
  saved: SavedEvidenceQuery["acceptancePolicy"],
  expected: { readonly id: string; readonly version: string } | undefined,
): void {
  if (saved === undefined && expected === undefined) return;
  if (
    saved === undefined
    || expected === undefined
    || saved.id !== expected.id
    || saved.version !== expected.version
  ) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "Saved query acceptance policy identity does not match the live invocation.",
    );
  }
}

export function createSavedEvidenceQuery<Query>(
  input: CreateSavedEvidenceQueryInput<Query>,
): SavedEvidenceQuery {
  assertCandidateSourceIdentity(input.candidateSourceSet);
  assertLogicalLimits(input.resultLimit, input.candidateBudget);
  const value: unknown = input.codec.encode(input.sourceQuery);
  assertJsonValue(value);
  if (input.acceptancePolicy?.configuration !== undefined) {
    assertJsonValue(input.acceptancePolicy.configuration);
  }
  const savedValue = freezeJson(structuredClone(value));
  return Object.freeze({
    retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
    candidateSourceSet: Object.freeze({ ...input.candidateSourceSet }),
    providerQuery: Object.freeze({
      kind: input.codec.kind,
      schemaVersion: input.codec.schemaVersion,
      value: savedValue,
    }),
    resultLimit: input.resultLimit,
    candidateBudget: input.candidateBudget,
    ...(input.acceptancePolicy === undefined
      ? {}
      : {
          acceptancePolicy: Object.freeze({
            ...input.acceptancePolicy,
            ...(input.acceptancePolicy.configuration === undefined
              ? {}
              : {
                  configuration: freezeJson(structuredClone(
                    input.acceptancePolicy.configuration,
                  )),
                }),
          }),
        }),
  });
}

export function savedEvidenceQueryDigest(
  query: SavedEvidenceQuery,
): Sha256Digest {
  validateSavedEnvelope(query);
  return recordDigest(encoder.encode(canonicalJson(query as unknown as JsonValue)));
}

export function decodeSavedEvidenceQuery<Query>(
  saved: SavedEvidenceQuery,
  expected: {
    readonly source: CandidateSourceIdentity;
    readonly codec: ProviderQueryCodec<Query>;
    readonly acceptance?: { readonly id: string; readonly version: string };
  },
): Query {
  validateSavedEnvelope(saved);
  assertExactSource(saved.candidateSourceSet, expected.source);
  if (
    saved.providerQuery.kind !== expected.codec.kind
    || saved.providerQuery.schemaVersion !== expected.codec.schemaVersion
  ) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "Saved query does not match the provider query codec.",
    );
  }
  assertAcceptanceMatch(saved.acceptancePolicy, expected.acceptance);
  try {
    return expected.codec.decode(saved.providerQuery.value);
  } catch {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "Provider query codec rejected the saved query value.",
    );
  }
}

export function createQuerySnapshotReceipt(
  saved: SavedEvidenceQuery,
  reports: readonly CandidateSourceReport[],
  evaluatedAt: string,
): QuerySnapshotReceipt {
  validateSavedEnvelope(saved);
  if (!Number.isFinite(Date.parse(evaluatedAt))) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "evaluatedAt must be an ISO-8601 timestamp.",
    );
  }
  const completed = reports.filter(({ status }) => status === "complete");
  const checkpointed = completed.flatMap(({ source, checkpoint }) =>
    checkpoint === undefined ? [] : [{ source, checkpoint }],
  );
  const reproducibility =
    completed.length > 0
    && checkpointed.length === completed.length
    && checkpointed.every(({ checkpoint }) => checkpoint.replayable)
      ? "replayable"
      : "not-replayable";
  return Object.freeze({
    savedQueryDigest: savedEvidenceQueryDigest(saved),
    sourceSet: Object.freeze({ ...saved.candidateSourceSet }),
    sources: checkpointed,
    evaluatedAt,
    reproducibility,
  });
}
