import {
  compareCalendarStrictRfc3339Instants,
  isCalendarStrictRfc3339,
  parseRun,
  resolveBenchmarkTaskProvenance as resolveRecordTaskProvenance,
  sealRun,
  type MatrixRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import {
  canonicalJsonBytes,
  parseDsseEnvelope,
  recordDigest,
} from "@jinn-network/trust-core";
import type {
  AnchoredBenchmarkAnnouncementVerifier,
  MethodComputeInput,
  VerdictOutcome,
} from "./method.js";

export type MethodInputErrorCode =
  | "verdict-record-unavailable"
  | "verdict-record-digest-mismatch"
  | "verdict-record-malformed"
  | "run-record-unavailable"
  | "run-record-digest-mismatch"
  | "run-record-malformed"
  | "task-record-unavailable"
  | "task-record-digest-mismatch"
  | "task-record-malformed"
  | "task-provenance-source-missing"
  | "task-provenance-timestamp-missing"
  | "anchored-announcement-unavailable"
  | "anchored-announcement-unverified"
  | "anchored-announcement-malformed"
  | "incompatible-run-replicates"
  | "method-incompatible-cost-unit";

/** Typed, stable fail-closed method-input failure. `digest` always names the exact requested
 * record reference whose bytes were unavailable, malformed, mismatched, or incompatible. */
export class MethodInputError extends Error {
  readonly name = "MethodInputError";

  constructor(
    readonly code: MethodInputErrorCode,
    readonly digest: string,
    detail: string,
  ) {
    super(`${code}: ${digest}: ${detail}`);
  }
}

const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const RESULT_EVALUATION_PREDICATE_TYPE =
  "https://spec.jinn.network/attestations/result-evaluation/v1";
const VERDICT_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const DISCOVERY_ENTRY_PAYLOAD_TYPE = "application/vnd.jinn.discovery.entry.v1+json";
const DISCOVERY_PROTOCOL = "https://spec.jinn.network/record-discovery/v1";
const BENCHMARK_RECORD_KIND = "https://spec.jinn.network/records/benchmark/v1";

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Frozen evidence-issuer JSON spelling: sorted keys, two-space indentation, trailing LF. */
function canonicalAttestationJsonBytes(value: unknown): Uint8Array {
  const stringify = (candidate: unknown, depth = 0): string => {
    if (candidate === null || typeof candidate !== "object") return JSON.stringify(candidate);
    const outerIndent = "  ".repeat(depth);
    const innerIndent = "  ".repeat(depth + 1);
    if (Array.isArray(candidate)) {
      if (candidate.length === 0) return "[]";
      return `[\n${candidate.map((item) => `${innerIndent}${stringify(item, depth + 1)}`).join(",\n")}\n${outerIndent}]`;
    }
    const object = candidate as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((key) =>
      `${innerIndent}${JSON.stringify(key)}: ${stringify(object[key], depth + 1)}`).join(",\n")}\n${outerIndent}}`;
  };
  return new TextEncoder().encode(`${stringify(value)}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertUnicodeScalars(value: unknown, digest: string, code: MethodInputErrorCode): void {
  const assertString = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new MethodInputError(code, digest, "JSON contains an unpaired high surrogate");
        }
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new MethodInputError(code, digest, "JSON contains an unpaired low surrogate");
      }
    }
  };
  if (typeof value === "string") {
    assertString(value);
  } else if (Array.isArray(value)) {
    for (const item of value) assertUnicodeScalars(item, digest, code);
  } else if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      assertString(key);
      assertUnicodeScalars(nested, digest, code);
    }
  }
}

function parseCanonicalJson(
  bytes: Uint8Array,
  code: MethodInputErrorCode,
  digest: string,
  acceptedCanonicalizers: readonly ((value: unknown) => Uint8Array)[] = [canonicalJsonBytes],
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new MethodInputError(code, digest, `bytes are not valid UTF-8 JSON: ${String(cause)}`);
  }
  if (!isObject(value)) {
    throw new MethodInputError(code, digest, "canonical payload must be a JSON object");
  }
  assertUnicodeScalars(value, digest, code);
  let canonicals: Uint8Array[];
  try {
    canonicals = acceptedCanonicalizers.map((canonicalize) => canonicalize(value));
  } catch (cause) {
    throw new MethodInputError(code, digest, `payload is outside canonical I-JSON: ${String(cause)}`);
  }
  if (!canonicals.some((canonical) => bytesEqual(bytes, canonical))) {
    throw new MethodInputError(code, digest, "payload bytes are not the exact canonical encoding");
  }
  return value;
}

function requireResolvedBytes(
  digest: string,
  resolve: (digest: string) => Uint8Array | undefined,
  unavailableCode: MethodInputErrorCode,
  mismatchCode: MethodInputErrorCode,
): Uint8Array {
  const bytes = resolve(digest);
  if (bytes === undefined) {
    throw new MethodInputError(unavailableCode, digest, "resolver returned no bytes");
  }
  const actual = recordDigest(bytes);
  if (actual !== digest) {
    throw new MethodInputError(
      mismatchCode,
      digest,
      `resolved exact bytes hash to ${actual}`,
    );
  }
  return bytes;
}

/**
 * Smallest exact Result Evaluation Statement validator needed by aggregation. It intentionally
 * does not recreate the profiles package: only the frozen identity, outcome, evaluator, and
 * effective-time fields consumed at this boundary are accepted, with no normalization.
 */
export function resolveVerdictOutcome(
  digest: string,
  input: Pick<MethodComputeInput, "resolveVerdictBytes">,
): VerdictOutcome {
  const envelopeBytes = requireResolvedBytes(
    digest,
    input.resolveVerdictBytes,
    "verdict-record-unavailable",
    "verdict-record-digest-mismatch",
  );
  let envelope: ReturnType<typeof parseDsseEnvelope>;
  try {
    envelope = parseDsseEnvelope(envelopeBytes);
  } catch (cause) {
    throw new MethodInputError(
      "verdict-record-malformed",
      digest,
      `invalid DSSE envelope: ${String(cause)}`,
    );
  }
  if (envelope.payloadType !== VERDICT_PAYLOAD_TYPE) {
    throw new MethodInputError(
      "verdict-record-malformed",
      digest,
      `payloadType must be ${VERDICT_PAYLOAD_TYPE}`,
    );
  }
  const statement = parseCanonicalJson(
    envelope.payloadBytes,
    "verdict-record-malformed",
    digest,
    // Historical trust-core producers emitted compact RFC-8785 JSON. The evidence issuer's
    // frozen attestation family emits sorted, indented JSON with a trailing LF. Both are exact,
    // deterministic spellings; accepting only one makes valid replay or live evidence unusable.
    [canonicalJsonBytes, canonicalAttestationJsonBytes],
  );
  if (statement["_type"] !== IN_TOTO_STATEMENT_TYPE) {
    throw new MethodInputError("verdict-record-malformed", digest, "invalid Statement _type");
  }
  if (statement["predicateType"] !== RESULT_EVALUATION_PREDICATE_TYPE) {
    throw new MethodInputError("verdict-record-malformed", digest, "invalid predicateType");
  }
  if (!Array.isArray(statement["subject"]) || statement["subject"].length === 0) {
    throw new MethodInputError("verdict-record-malformed", digest, "subject must be non-empty");
  }
  for (const subject of statement["subject"]) {
    if (!isObject(subject) || typeof subject["name"] !== "string" || subject["name"].length === 0) {
      throw new MethodInputError(
        "verdict-record-malformed",
        digest,
        "every subject must carry a non-empty name",
      );
    }
    const subjectDigest = subject["digest"];
    if (
      !isObject(subjectDigest)
      || typeof subjectDigest["sha256"] !== "string"
      || !/^[a-f0-9]{64}$/.test(subjectDigest["sha256"])
    ) {
      throw new MethodInputError(
        "verdict-record-malformed",
        digest,
        "every subject must carry one exact lowercase sha256 digest",
      );
    }
  }
  const predicate = statement["predicate"];
  if (!isObject(predicate)) {
    throw new MethodInputError("verdict-record-malformed", digest, "predicate must be an object");
  }
  if (!isCalendarStrictRfc3339(predicate["evaluatedAt"])) {
    throw new MethodInputError("verdict-record-malformed", digest, "evaluatedAt must be RFC 3339");
  }
  const evaluator = predicate["evaluator"];
  if (!isObject(evaluator) || typeof evaluator["id"] !== "string" || evaluator["id"].length === 0) {
    throw new MethodInputError("verdict-record-malformed", digest, "evaluator.id is required");
  }
  if (typeof predicate["taskSubject"] !== "string" || predicate["taskSubject"].length === 0) {
    throw new MethodInputError("verdict-record-malformed", digest, "taskSubject is required");
  }
  if (
    !Array.isArray(predicate["resultSubjects"])
    || predicate["resultSubjects"].length === 0
    || predicate["resultSubjects"].some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw new MethodInputError("verdict-record-malformed", digest, "resultSubjects is invalid");
  }
  const verdict = predicate["verdict"];
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    throw new MethodInputError("verdict-record-malformed", digest, "verdict is invalid");
  }
  return { verdict };
}

export function resolveRun(
  digest: string,
  input: Pick<MethodComputeInput, "resolveRunBytes">,
): RunRecord {
  const bytes = requireResolvedBytes(
    digest,
    input.resolveRunBytes,
    "run-record-unavailable",
    "run-record-digest-mismatch",
  );
  try {
    const record = parseRun(bytes);
    if (!bytesEqual(bytes, sealRun(record).bytes)) {
      throw new Error("Run bytes are not canonical");
    }
    return record;
  } catch (cause) {
    throw new MethodInputError("run-record-malformed", digest, String(cause));
  }
}

export function matrixRunDigest(matrix: MatrixRecord): string {
  return `sha256:${matrix.run.digest.sha256}`;
}

export interface ResolvedTaskProvenance {
  readonly timestamp: string;
  /** Deliberately tagged: plaintext `source` and opaque `sourceCommitment` never collide. */
  readonly cluster: { readonly tag: "source" | "sourceCommitment"; readonly value: string };
}

export function resolveTaskProvenance(
  taskDigestHex: string,
  input: Pick<MethodComputeInput, "resolveTaskBytes">,
): ResolvedTaskProvenance {
  const digest = `sha256:${taskDigestHex}`;
  const resolved = resolveRecordTaskProvenance(digest, input.resolveTaskBytes);
  if (resolved.ok) return resolved.provenance;
  const code = resolved.reason === "unavailable" ? "task-record-unavailable"
    : resolved.reason === "digest-mismatch" ? "task-record-digest-mismatch"
      : resolved.reason === "invalid-provenance" ? "task-provenance-source-missing"
        : "task-record-malformed";
  throw new MethodInputError(code, digest, `records Task admission refused: ${resolved.reason}`);
}

export function resolveAnchoredAnnouncementTime(
  benchmarkDigest: string,
  envelopeBytes: Uint8Array | undefined,
  verify: AnchoredBenchmarkAnnouncementVerifier | undefined,
): string {
  if (envelopeBytes === undefined) {
    throw new MethodInputError(
      "anchored-announcement-unavailable",
      benchmarkDigest,
      "resolver returned no exact signed Discovery Entry envelope bytes",
    );
  }
  if (verify === undefined) {
    throw new MethodInputError(
      "anchored-announcement-unverified",
      benchmarkDigest,
      "no proof-bearing Discovery signature/source/chain/anchor verifier was supplied",
    );
  }
  let entryBytes: Uint8Array;
  let entry: Record<string, unknown>;
  try {
    const envelope = parseDsseEnvelope(envelopeBytes);
    if (envelope.payloadType !== DISCOVERY_ENTRY_PAYLOAD_TYPE) {
      throw new Error(`payloadType must be ${DISCOVERY_ENTRY_PAYLOAD_TYPE}`);
    }
    entryBytes = envelope.payloadBytes;
    entry = parseCanonicalJson(
      entryBytes,
      "anchored-announcement-malformed",
      benchmarkDigest,
    );
    if (entry["protocol"] !== DISCOVERY_PROTOCOL) {
      throw new Error(`entry protocol must be ${DISCOVERY_PROTOCOL}`);
    }
    const announcements = entry["announcements"];
    const namesBenchmark = Array.isArray(announcements) && announcements.some((announcement) => {
      if (!isObject(announcement) || announcement["action"] !== "available") return false;
      const record = announcement["record"];
      return isObject(record)
        && record["kind"] === BENCHMARK_RECORD_KIND
        && record["digest"] === benchmarkDigest;
    });
    if (!namesBenchmark) {
      throw new Error("signed entry does not announce the requested Benchmark digest");
    }
    const source = entry["source"];
    if (
      !isObject(source)
      || typeof source["agent"] !== "string"
      || source["agent"].length === 0
      || typeof source["name"] !== "string"
      || source["name"].length === 0
    ) {
      throw new Error("entry source must carry non-empty agent and name");
    }
    if (typeof entry["sequence"] !== "string" || !/^[0-9]{16}$/.test(entry["sequence"])) {
      throw new Error("entry sequence must be an exact 16-digit decimal string");
    }
    const previous = entry["previous"];
    if (previous !== null && (typeof previous !== "string" || !/^sha256:[a-f0-9]{64}$/.test(previous))) {
      throw new Error("entry previous must be null or an exact lowercase sha256 digest");
    }
    if (
      (entry["sequence"] === "0000000000000001" && previous !== null)
      || (entry["sequence"] !== "0000000000000001" && previous === null)
    ) {
      throw new Error("entry genesis sequence/previous linkage is inconsistent");
    }
    if (!isCalendarStrictRfc3339(entry["timestamp"])) {
      throw new Error("entry timestamp must be RFC 3339");
    }
  } catch (cause) {
    if (cause instanceof MethodInputError) throw cause;
    throw new MethodInputError(
      "anchored-announcement-malformed",
      benchmarkDigest,
      String(cause),
    );
  }

  const entryDigest = recordDigest(entryBytes);
  const source = entry["source"] as { agent: string; name: string };
  let verification: ReturnType<AnchoredBenchmarkAnnouncementVerifier>;
  try {
    verification = verify({
      benchmarkDigest,
      envelopeBytes,
      entryBytes,
      entryDigest,
      source,
      sequence: entry["sequence"] as string,
      previous: entry["previous"] as string | null,
      entryTimestamp: entry["timestamp"] as string,
    });
  } catch (cause) {
    throw new MethodInputError(
      "anchored-announcement-unverified",
      benchmarkDigest,
      `Discovery verification port failed: ${String(cause)}`,
    );
  }
  if (!verification.ok) {
    throw new MethodInputError(
      "anchored-announcement-unverified",
      benchmarkDigest,
      verification.reason,
    );
  }

  const exactDigest = (value: string): boolean => /^sha256:[a-f0-9]{64}$/.test(value);
  const chain = verification.verifiedEntryDigests;
  const sourceMatches = verification.source.agent === source.agent
    && verification.source.name === source.name;
  const chainIsExact = chain.length > 0
    && chain.every(exactDigest)
    && new Set(chain).size === chain.length
    && chain.includes(entryDigest)
    && chain[chain.length - 1] === verification.headDigest;
  const anchorOrder = compareCalendarStrictRfc3339Instants(
    verification.anchor.anchorTime,
    entry["timestamp"] as string,
  );
  const anchorIsExact = exactDigest(verification.headDigest)
    && verification.anchor.digest === verification.headDigest
    && anchorOrder !== undefined
    && anchorOrder >= 0;
  if (!sourceMatches || !chainIsExact || !anchorIsExact) {
    throw new MethodInputError(
      "anchored-announcement-unverified",
      benchmarkDigest,
      "verification proof does not bind the exact source, entry chain, head anchor, and derived time",
    );
  }
  return verification.anchor.anchorTime;
}
