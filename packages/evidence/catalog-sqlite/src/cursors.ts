// SPDX-License-Identifier: MIT
import {
  EvidenceCatalogError,
  type EntityRecordQuery,
  type EvaluationCatalogQuery,
  type ExecutionCatalogQuery,
  type VerificationCatalogQuery,
} from "@jinn-network/evidence-discovery";

import { canonicalJsonSnapshot, sha256Text } from "./projection-row.js";

type TimeOrder = readonly [number, string];
type FamilyOrder = readonly [string, string];
export type SqliteCatalogOrder = TimeOrder | FamilyOrder;

export interface PreparedPageQuery {
  readonly limit: number;
  readonly availability: "available" | "any";
  readonly queryHash: string;
  readonly cursorOrder?: SqliteCatalogOrder;
}

export interface PreparedExecutionQuery extends PreparedPageQuery {
  readonly executionId?: string;
  readonly taskId?: string;
  readonly taskDigest?: string;
  readonly resultId?: string;
  readonly resultDigest?: string;
  readonly resultDigestsAll?: readonly string[];
  readonly executorId?: string;
  readonly runtimeDigest?: string;
  readonly identifierScheme?: string;
  readonly identifierValue?: string;
  readonly outcome?: string;
  readonly startedAfterMs?: number;
  readonly startedBeforeMs?: number;
  readonly publishedAfterMs?: number;
  readonly publishedBeforeMs?: number;
}

export interface PreparedEvaluationQuery extends PreparedPageQuery {
  readonly taskDigest?: string;
  readonly resultDigest?: string;
  readonly resultDigestsAll?: readonly string[];
  readonly evaluatorId?: string;
  readonly verdict?: string;
  readonly evaluatedAfterMs?: number;
  readonly evaluatedBeforeMs?: number;
}

export interface PreparedVerificationQuery extends PreparedPageQuery {
  readonly executionId?: string;
  readonly subjectRecordDigest?: string;
  readonly verifierId?: string;
  readonly verdict?: string;
  readonly verifiedAfterMs?: number;
  readonly verifiedBeforeMs?: number;
}

export interface PreparedEntityQuery extends PreparedPageQuery {
  readonly family?: string;
  readonly entityId: string;
}

interface CursorInput {
  readonly cursor?: string;
  readonly limit?: unknown;
  readonly availability?: unknown;
}

function invalid(message: string): never {
  throw new EvidenceCatalogError("INVALID_QUERY", message);
}

function snapshotQuery(
  input: unknown,
  allowed: readonly string[],
  role: string,
): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  ) {
    invalid(`${role} must be a safe plain object.`);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    invalid(`${role} must not contain symbol properties.`);
  }
  const accepted: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(input),
  )) {
    if (
      !allowed.includes(key) ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalid(`${role} contains an unsupported field.`);
    }
    accepted[key] = descriptor.value;
  }
  return accepted;
}

function base(input: CursorInput): {
  readonly limit: number;
  readonly availability: "available" | "any";
  readonly cursor?: string;
} {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    invalid("Catalog query limit must be an integer from 1 through 100.");
  }
  const availability = input.availability ?? "available";
  if (availability !== "available" && availability !== "any") {
    invalid("Catalog availability must be available or any.");
  }
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== "string" || input.cursor.length > 16_384)
  ) {
    invalid("Catalog cursor is invalid.");
  }
  return {
    limit: Number(limit),
    availability,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string.`);
  }
  return value;
}

function digest(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    invalid(`${field} must be a canonical lowercase SHA-256 digest.`);
  }
  return value;
}

function digests(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    invalid(`${field} must be a non-empty array of SHA-256 digests.`);
  }
  const accepted = value.map((item) => digest(item, field)!);
  if (new Set(accepted).size !== accepted.length) {
    invalid(`${field} must not contain duplicate digests.`);
  }
  return Object.freeze([...accepted].sort());
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

function timestamp(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    invalid(`${field} must be a valid RFC 3339 timestamp.`);
  }
  const match = RFC3339.exec(value);
  if (match === null) invalid(`${field} must be a valid RFC 3339 timestamp.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    invalid(`${field} must be a valid RFC 3339 timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) {
    invalid(`${field} must be a valid RFC 3339 timestamp.`);
  }
  return milliseconds;
}

function queryHash(scope: string, filters: Record<string, unknown>): string {
  return sha256Text(canonicalJsonSnapshot({ scope, filters }).json);
}

function cursor(
  encoded: string | undefined,
  expectedHash: string,
  kind: "time" | "family",
): SqliteCatalogOrder | undefined {
  if (encoded === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      invalid("Catalog cursor is malformed.");
    }
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      invalid("Catalog cursor is malformed.");
    }
    const candidate = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !==
        "order,queryHash,version" ||
      candidate.version !== 1 ||
      candidate.queryHash !== expectedHash ||
      !Array.isArray(candidate.order) ||
      candidate.order.length !== 2
    ) {
      invalid("Catalog cursor is invalid for this query.");
    }
    const [first, second] = candidate.order;
    if (
      typeof second !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(second)
    ) {
      invalid("Catalog cursor is invalid for this query.");
    }
    if (
      kind === "time"
        ? !Number.isSafeInteger(first)
        : typeof first !== "string" ||
          ![
            "execution-evidence",
            "result-evaluation",
            "execution-verification",
          ].includes(first)
    ) {
      invalid("Catalog cursor is invalid for this query.");
    }
    return candidate.order as unknown as SqliteCatalogOrder;
  } catch (error) {
    if (error instanceof EvidenceCatalogError) throw error;
    return invalid("Catalog cursor is malformed.");
  }
}

function defined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

export function prepareExecutionQuery(
  input: ExecutionCatalogQuery,
): PreparedExecutionQuery {
  const query = snapshotQuery(input, [
    "limit",
    "cursor",
    "availability",
    "executionId",
    "taskId",
    "taskDigest",
    "resultId",
    "resultDigest",
    "resultDigestsAll",
    "executorId",
    "runtimeDigest",
    "identifierScheme",
    "identifierValue",
    "outcome",
    "startedAfter",
    "startedBefore",
    "publishedAfter",
    "publishedBefore",
  ], "Execution query");
  const prepared = {
    executionId: optionalString(query.executionId, "executionId"),
    taskId: optionalString(query.taskId, "taskId"),
    taskDigest: digest(query.taskDigest, "taskDigest"),
    resultId: optionalString(query.resultId, "resultId"),
    resultDigest: digest(query.resultDigest, "resultDigest"),
    resultDigestsAll: digests(query.resultDigestsAll, "resultDigestsAll"),
    executorId: optionalString(query.executorId, "executorId"),
    runtimeDigest: digest(query.runtimeDigest, "runtimeDigest"),
    identifierScheme: optionalString(query.identifierScheme, "identifierScheme"),
    identifierValue: optionalString(query.identifierValue, "identifierValue"),
    outcome: query.outcome,
    startedAfterMs: timestamp(query.startedAfter, "startedAfter"),
    startedBeforeMs: timestamp(query.startedBefore, "startedBefore"),
    publishedAfterMs: timestamp(query.publishedAfter, "publishedAfter"),
    publishedBeforeMs: timestamp(query.publishedBefore, "publishedBefore"),
  };
  if (
    prepared.outcome !== undefined &&
    !["completed", "failed", "abandoned"].includes(String(prepared.outcome))
  ) {
    invalid("outcome is invalid.");
  }
  const page = base(query);
  const filters = defined({ ...prepared, availability: page.availability });
  const hash = queryHash("executions", filters);
  return {
    ...prepared,
    outcome: prepared.outcome as string | undefined,
    limit: page.limit,
    availability: page.availability,
    queryHash: hash,
    cursorOrder: cursor(page.cursor, hash, "time"),
  };
}

export function prepareEvaluationQuery(
  input: EvaluationCatalogQuery,
): PreparedEvaluationQuery {
  const query = snapshotQuery(input, [
    "limit",
    "cursor",
    "availability",
    "taskDigest",
    "resultDigest",
    "resultDigestsAll",
    "evaluatorId",
    "verdict",
    "evaluatedAfter",
    "evaluatedBefore",
  ], "Evaluation query");
  const prepared = {
    taskDigest: digest(query.taskDigest, "taskDigest"),
    resultDigest: digest(query.resultDigest, "resultDigest"),
    resultDigestsAll: digests(query.resultDigestsAll, "resultDigestsAll"),
    evaluatorId: optionalString(query.evaluatorId, "evaluatorId"),
    verdict: query.verdict,
    evaluatedAfterMs: timestamp(query.evaluatedAfter, "evaluatedAfter"),
    evaluatedBeforeMs: timestamp(query.evaluatedBefore, "evaluatedBefore"),
  };
  if (
    prepared.verdict !== undefined &&
    !["pass", "fail", "inconclusive"].includes(String(prepared.verdict))
  ) {
    invalid("verdict is invalid.");
  }
  const page = base(query);
  const filters = defined({ ...prepared, availability: page.availability });
  const hash = queryHash("evaluations", filters);
  return {
    ...prepared,
    verdict: prepared.verdict as string | undefined,
    limit: page.limit,
    availability: page.availability,
    queryHash: hash,
    cursorOrder: cursor(page.cursor, hash, "time"),
  };
}

export function prepareVerificationQuery(
  input: VerificationCatalogQuery,
): PreparedVerificationQuery {
  const query = snapshotQuery(input, [
    "limit",
    "cursor",
    "availability",
    "executionId",
    "subjectRecordDigest",
    "verifierId",
    "verdict",
    "verifiedAfter",
    "verifiedBefore",
  ], "Verification query");
  const prepared = {
    executionId: optionalString(query.executionId, "executionId"),
    subjectRecordDigest: digest(
      query.subjectRecordDigest,
      "subjectRecordDigest",
    ),
    verifierId: optionalString(query.verifierId, "verifierId"),
    verdict: query.verdict,
    verifiedAfterMs: timestamp(query.verifiedAfter, "verifiedAfter"),
    verifiedBeforeMs: timestamp(query.verifiedBefore, "verifiedBefore"),
  };
  if (
    prepared.verdict !== undefined &&
    !["verified", "rejected", "inconclusive"].includes(String(prepared.verdict))
  ) {
    invalid("verdict is invalid.");
  }
  const page = base(query);
  const filters = defined({ ...prepared, availability: page.availability });
  const hash = queryHash("verifications", filters);
  return {
    ...prepared,
    verdict: prepared.verdict as string | undefined,
    limit: page.limit,
    availability: page.availability,
    queryHash: hash,
    cursorOrder: cursor(page.cursor, hash, "time"),
  };
}

export function prepareEntityQuery(
  entityIdInput: string,
  input: EntityRecordQuery,
): PreparedEntityQuery {
  const entityId = optionalString(entityIdInput, "entityId");
  if (entityId === undefined) invalid("entityId must be a non-empty string.");
  const query = snapshotQuery(input, [
    "limit",
    "cursor",
    "availability",
    "family",
  ], "Entity query");
  if (
    query.family !== undefined &&
    (typeof query.family !== "string" ||
      ![
        "execution-evidence",
        "result-evaluation",
        "execution-verification",
      ].includes(query.family))
  ) {
    invalid("family is invalid.");
  }
  const page = base(query);
  const filters = defined({
    entityId,
    family: query.family,
    availability: page.availability,
  });
  const hash = queryHash("entity-records", filters);
  return {
    entityId,
    family: query.family as string | undefined,
    limit: page.limit,
    availability: page.availability,
    queryHash: hash,
    cursorOrder: cursor(page.cursor, hash, "family"),
  };
}

export function encodeSqliteCatalogCursor(
  queryHashValue: string,
  order: SqliteCatalogOrder,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      queryHash: queryHashValue,
      order,
    }),
    "utf8",
  ).toString("base64url");
}
