// SPDX-License-Identifier: MIT
import { EvidenceCatalogError } from "./errors.js";
import { deterministicJson } from "./keys.js";
import type {
  CatalogPage,
  CatalogPageQuery,
  CatalogRecordProjection,
  EntityRecordQuery,
  EvaluationCatalogQuery,
  ExecutionCatalogQuery,
  ExecutionEvidenceProjection,
  ExecutionVerificationProjection,
  JsonValue,
  ResultEvaluationProjection,
  VerificationCatalogQuery,
} from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

interface Cursor {
  readonly v: 1;
  readonly f: string;
  readonly t: readonly (string | number)[];
}

function invalid(message: string): never {
  throw new EvidenceCatalogError("INVALID_QUERY", message);
}

export function parseCatalogTimestamp(value: string, field: string): number {
  if (typeof value !== "string") {
    invalid(`${field} must be a valid RFC 3339 timestamp.`);
  }
  const match = RFC3339.exec(value);
  if (match === null) invalid(`${field} must be a valid RFC 3339 timestamp.`);
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
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
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute =
    offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
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
  if (!Number.isFinite(milliseconds)) {
    invalid(`${field} must be a valid RFC 3339 timestamp.`);
  }
  return milliseconds;
}

function snapshotQueryObject(
  value: unknown,
  allowed: readonly string[],
  role: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalid(`${role} must be a safe plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid(`${role} must not contain symbol properties.`);
  }
  const accepted: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
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

export function snapshotExecutionCatalogQuery(
  query: unknown,
): ExecutionCatalogQuery {
  return snapshotQueryObject(query, [
    "limit",
    "cursor",
    "availability",
    "executionId",
    "taskId",
    "taskDigest",
    "resultId",
    "resultDigest",
    "executorId",
    "outcome",
    "startedAfter",
    "startedBefore",
  ], "Execution query") as unknown as ExecutionCatalogQuery;
}

export function snapshotEvaluationCatalogQuery(
  query: unknown,
): EvaluationCatalogQuery {
  return snapshotQueryObject(query, [
    "limit",
    "cursor",
    "availability",
    "taskDigest",
    "resultDigest",
    "evaluatorId",
    "verdict",
    "evaluatedAfter",
    "evaluatedBefore",
  ], "Evaluation query") as unknown as EvaluationCatalogQuery;
}

export function snapshotVerificationCatalogQuery(
  query: unknown,
): VerificationCatalogQuery {
  return snapshotQueryObject(query, [
    "limit",
    "cursor",
    "availability",
    "executionId",
    "subjectRecordDigest",
    "verifierId",
    "verdict",
    "verifiedAfter",
    "verifiedBefore",
  ], "Verification query") as unknown as VerificationCatalogQuery;
}

export function snapshotEntityRecordQuery(query: unknown): EntityRecordQuery {
  return snapshotQueryObject(query, [
    "limit",
    "cursor",
    "availability",
    "family",
  ], "Entity query") as unknown as EntityRecordQuery;
}

function validateBaseQuery(query: CatalogPageQuery): number {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    invalid("Catalog query limit must be an integer from 1 through 100.");
  }
  if (
    query.availability !== undefined &&
    query.availability !== "available" &&
    query.availability !== "any"
  ) {
    invalid("Catalog availability must be available or any.");
  }
  if (
    query.cursor !== undefined &&
    (typeof query.cursor !== "string" || query.cursor.length > 16_384)
  ) {
    invalid("Catalog cursor is invalid.");
  }
  return limit;
}

function validateDigest(value: string | undefined, field: string): void {
  if (value !== undefined && !DIGEST.test(value)) {
    invalid(`${field} must be a canonical lowercase SHA-256 digest.`);
  }
}

function validateOptionalString(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || value.trim().length === 0)
  ) {
    invalid(`${field} must be a non-empty string.`);
  }
}

function fingerprint(query: CatalogPageQuery, scope: JsonValue): string {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  return deterministicJson({ scope, filters });
}

function decodeCursor(
  value: string | undefined,
  expected: string,
  tupleKind: "time-digest" | "family-digest",
): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
      invalid("Catalog cursor is malformed.");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      invalid("Catalog cursor is malformed.");
    }
    const candidate = JSON.parse(bytes.toString("utf8")) as
      Partial<Cursor>;
    if (
      candidate.v !== 1 ||
      candidate.f !== expected ||
      !Array.isArray(candidate.t) ||
      candidate.t.length !== 2 ||
      (
        tupleKind === "time-digest"
          ? (
              typeof candidate.t[0] !== "number" ||
              !Number.isFinite(candidate.t[0]) ||
              typeof candidate.t[1] !== "string" ||
              !DIGEST.test(candidate.t[1])
            )
          : (
              typeof candidate.t[0] !== "string" ||
              ![
                "execution-evidence",
                "result-evaluation",
                "execution-verification",
              ].includes(candidate.t[0]) ||
              typeof candidate.t[1] !== "string" ||
              !DIGEST.test(candidate.t[1])
            )
      )
    ) {
      invalid("Catalog cursor is invalid for this query.");
    }
    return candidate as Cursor;
  } catch (error) {
    if (error instanceof EvidenceCatalogError) throw error;
    return invalid("Catalog cursor is malformed.");
  }
}

function encodeCursor(f: string, t: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify({ v: 1, f, t }), "utf8").toString(
    "base64url",
  );
}

function compareTuples(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function page<T>(
  values: readonly T[],
  query: CatalogPageQuery,
  tuple: (value: T) => readonly (string | number)[],
  scope: JsonValue,
  tupleKind: "time-digest" | "family-digest",
): CatalogPage<T> {
  const limit = validateBaseQuery(query);
  const queryFingerprint = fingerprint(query, scope);
  const cursor = decodeCursor(query.cursor, queryFingerprint, tupleKind);
  const sorted = [...values].sort((left, right) =>
    compareTuples(tuple(left), tuple(right)),
  );
  const start =
    cursor === undefined
      ? 0
      : Math.max(
          0,
          sorted.findIndex(
            (item) => compareTuples(tuple(item), cursor.t) > 0,
          ),
        );
  if (cursor !== undefined && start === 0) {
    const hasAfter = sorted.some(
      (item) => compareTuples(tuple(item), cursor.t) > 0,
    );
    if (!hasAfter) {
      return { items: [] };
    }
  }
  const items = sorted.slice(start, start + limit);
  return {
    items,
    ...(items.length === 0
      ? {}
      : {
          nextCursor: encodeCursor(
            queryFingerprint,
            tuple(items[items.length - 1]!),
          ),
        }),
  };
}

function normalizedTime(
  value: string | undefined,
  field: string,
): number | undefined {
  return value === undefined ? undefined : parseCatalogTimestamp(value, field);
}

export function paginateExecutions(
  values: readonly ExecutionEvidenceProjection[],
  query: ExecutionCatalogQuery,
): CatalogPage<ExecutionEvidenceProjection> {
  query = snapshotExecutionCatalogQuery(query);
  for (const [field, value] of [
    ["executionId", query.executionId],
    ["taskId", query.taskId],
    ["resultId", query.resultId],
    ["executorId", query.executorId],
  ] as const) validateOptionalString(value, field);
  if (
    query.outcome !== undefined &&
    !["completed", "failed", "abandoned"].includes(query.outcome)
  ) {
    invalid("outcome is invalid.");
  }
  validateDigest(query.taskDigest, "taskDigest");
  validateDigest(query.resultDigest, "resultDigest");
  const after = normalizedTime(query.startedAfter, "startedAfter");
  const before = normalizedTime(query.startedBefore, "startedBefore");
  const filtered = values.filter(
    (value) =>
      (query.executionId === undefined || value.executionId === query.executionId) &&
      (query.taskId === undefined || value.task.entityId === query.taskId) &&
      (query.taskDigest === undefined || value.task.digest === query.taskDigest) &&
      (
        (query.resultId === undefined && query.resultDigest === undefined) ||
        value.results.some(
          ({ entityId, digest }) =>
            (query.resultId === undefined || entityId === query.resultId) &&
            (query.resultDigest === undefined || digest === query.resultDigest),
        )
      ) &&
      (query.executorId === undefined || value.executorId === query.executorId) &&
      (query.outcome === undefined || value.outcome === query.outcome) &&
      (after === undefined ||
        parseCatalogTimestamp(value.startedAt, "startedAt") > after) &&
      (before === undefined ||
        parseCatalogTimestamp(value.startedAt, "startedAt") < before),
  );
  return page(filtered, query, (value) => [
    -parseCatalogTimestamp(value.startedAt, "startedAt"),
    value.reference.digest,
  ], "executions", "time-digest");
}

export function paginateEvaluations(
  values: readonly ResultEvaluationProjection[],
  query: EvaluationCatalogQuery,
): CatalogPage<ResultEvaluationProjection> {
  query = snapshotEvaluationCatalogQuery(query);
  validateOptionalString(query.evaluatorId, "evaluatorId");
  if (
    query.verdict !== undefined &&
    !["pass", "fail", "inconclusive"].includes(query.verdict)
  ) {
    invalid("verdict is invalid.");
  }
  validateDigest(query.taskDigest, "taskDigest");
  validateDigest(query.resultDigest, "resultDigest");
  const after = normalizedTime(query.evaluatedAfter, "evaluatedAfter");
  const before = normalizedTime(query.evaluatedBefore, "evaluatedBefore");
  const filtered = values.filter(
    (value) =>
      (query.taskDigest === undefined ||
        value.taskSubject.digest === query.taskDigest) &&
      (query.resultDigest === undefined ||
        value.resultSubjects.some(({ digest }) => digest === query.resultDigest)) &&
      (query.evaluatorId === undefined ||
        value.evaluatorId === query.evaluatorId) &&
      (query.verdict === undefined || value.verdict === query.verdict) &&
      (after === undefined ||
        parseCatalogTimestamp(value.evaluatedAt, "evaluatedAt") > after) &&
      (before === undefined ||
        parseCatalogTimestamp(value.evaluatedAt, "evaluatedAt") < before),
  );
  return page(filtered, query, (value) => [
    -parseCatalogTimestamp(value.evaluatedAt, "evaluatedAt"),
    value.reference.digest,
  ], "evaluations", "time-digest");
}

export function paginateVerifications(
  values: readonly ExecutionVerificationProjection[],
  query: VerificationCatalogQuery,
): CatalogPage<ExecutionVerificationProjection> {
  query = snapshotVerificationCatalogQuery(query);
  validateOptionalString(query.executionId, "executionId");
  validateOptionalString(query.verifierId, "verifierId");
  if (
    query.verdict !== undefined &&
    !["verified", "rejected", "inconclusive"].includes(query.verdict)
  ) {
    invalid("verdict is invalid.");
  }
  validateDigest(query.subjectRecordDigest, "subjectRecordDigest");
  const after = normalizedTime(query.verifiedAfter, "verifiedAfter");
  const before = normalizedTime(query.verifiedBefore, "verifiedBefore");
  const filtered = values.filter(
    (value) =>
      (query.executionId === undefined || value.executionId === query.executionId) &&
      (query.subjectRecordDigest === undefined ||
        value.subjectRecord.digest === query.subjectRecordDigest) &&
      (query.verifierId === undefined || value.verifierId === query.verifierId) &&
      (query.verdict === undefined || value.verdict === query.verdict) &&
      (after === undefined ||
        parseCatalogTimestamp(value.verifiedAt, "verifiedAt") > after) &&
      (before === undefined ||
        parseCatalogTimestamp(value.verifiedAt, "verifiedAt") < before),
  );
  return page(filtered, query, (value) => [
    -parseCatalogTimestamp(value.verifiedAt, "verifiedAt"),
    value.reference.digest,
  ], "verifications", "time-digest");
}

export function paginateEntityRecords(
  values: readonly CatalogRecordProjection[],
  query: EntityRecordQuery,
  entityId: string,
): CatalogPage<CatalogRecordProjection> {
  query = snapshotEntityRecordQuery(query);
  if (
    query.family !== undefined &&
    ![
      "execution-evidence",
      "result-evaluation",
      "execution-verification",
    ].includes(query.family)
  ) {
    invalid("family is invalid.");
  }
  validateOptionalString(entityId, "entityId");
  const filtered =
    query.family === undefined
      ? values
      : values.filter(({ family }) => family === query.family);
  return page(filtered, query, (value) => [
    value.family,
    value.reference.digest,
  ], { kind: "entity-records", entityId }, "family-digest");
}
