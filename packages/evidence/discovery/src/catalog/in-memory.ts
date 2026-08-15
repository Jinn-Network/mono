// SPDX-License-Identifier: MIT
import {
  assertCatalogOperationActive,
  EvidenceCatalogError,
} from "./errors.js";
import {
  deterministicJson,
  observationKey,
  projectionKey,
  recordKey,
} from "./keys.js";
import {
  paginateEntityRecords,
  paginateEvaluations,
  paginateExecutions,
  paginateVerifications,
  parseCatalogTimestamp,
  snapshotEntityRecordQuery,
  snapshotEvaluationCatalogQuery,
  snapshotExecutionCatalogQuery,
  snapshotVerificationCatalogQuery,
} from "./query.js";
import type {
  CatalogLocationReceipt,
  CatalogOperationOptions,
  CatalogPage,
  CatalogRecordProjection,
  CatalogWriteReceipt,
  EntityRecordQuery,
  EvaluationCatalogQuery,
  EvidenceCatalogReader,
  EvidenceCatalogWriter,
  EvidenceRecordLocation,
  EvidenceRecordReference,
  ExecutionCatalogQuery,
  ExecutionEvidenceProjection,
  ExecutionVerificationProjection,
  JsonValue,
  RecordLocationObservation,
  RecordLocationWithdrawal,
  ResultEvaluationProjection,
  VerificationCatalogQuery,
} from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BASE_PROJECTION_KEYS = [
  "family",
  "reference",
  "byteSize",
  "declaredEntities",
  "declaredRelationships",
] as const;

interface StoredProjection {
  readonly projection: CatalogRecordProjection;
  readonly normalized: string;
}

interface StoredObservation {
  readonly reference: EvidenceRecordReference;
  readonly observation: RecordLocationObservation;
  active: boolean;
}

interface StoredWithdrawal {
  readonly withdrawal: RecordLocationWithdrawal;
  readonly initialStatus: "withdrawn" | "absent";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function invalid(message: string): never {
  throw new EvidenceCatalogError("INVALID_PROJECTION", message);
}

function nonEmpty(value: unknown, role: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${role} must be a non-empty string.`);
  }
}

function stringValue(value: unknown, role: string): asserts value is string {
  if (typeof value !== "string") invalid(`${role} must be a string.`);
}

function plainObject(
  value: unknown,
  role: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${role} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${role} must be a plain JSON object.`);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  role: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    invalid(`${role} contains unsupported field ${unexpected.sort()[0]}.`);
  }
}

function digest(value: unknown, role: string): void {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    invalid(`${role} must be a canonical lowercase SHA-256 digest.`);
  }
}

function snapshotReference(
  value: unknown,
  role: string,
): EvidenceRecordReference {
  validateJson(value, role);
  plainObject(value, role);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    Object.keys(descriptors).some(
      (key) => key !== "family" && key !== "digest",
    ) ||
    descriptors.family === undefined ||
    descriptors.digest === undefined ||
    !("value" in descriptors.family) ||
    !("value" in descriptors.digest)
  ) {
    invalid(`${role} must contain exactly family and digest data properties.`);
  }
  const family = descriptors.family.value;
  const acceptedDigest = descriptors.digest.value;
  if (
    family !== "execution-evidence" &&
    family !== "result-evaluation" &&
    family !== "execution-verification"
  ) {
    invalid(`${role}.family is unsupported.`);
  }
  digest(acceptedDigest, `${role}.digest`);
  return {
    family,
    digest: acceptedDigest as EvidenceRecordReference["digest"],
  };
}

function timestamp(value: unknown, role: string): void {
  if (typeof value !== "string") invalid(`${role} must be an RFC 3339 timestamp.`);
  try {
    parseCatalogTimestamp(value, role);
  } catch {
    invalid(`${role} must be an RFC 3339 timestamp.`);
  }
}

function artifact(
  value: unknown,
  role: string,
): void {
  plainObject(value, role);
  exactKeys(value, ["entityId", "digest", "name", "mediaType"], role);
  nonEmpty(value.entityId, `${role}.entityId`);
  digest(value.digest, `${role}.digest`);
  if (value.name !== undefined) stringValue(value.name, `${role}.name`);
  if (value.mediaType !== undefined) {
    stringValue(value.mediaType, `${role}.mediaType`);
  }
}

function subject(
  value: unknown,
  role: string,
): void {
  plainObject(value, role);
  exactKeys(value, ["name", "digest", "uri", "mediaType"], role);
  nonEmpty(value.name, `${role}.name`);
  digest(value.digest, `${role}.digest`);
  if (value.uri !== undefined) stringValue(value.uri, `${role}.uri`);
  if (value.mediaType !== undefined) {
    stringValue(value.mediaType, `${role}.mediaType`);
  }
}

function validateProjection(projection: CatalogRecordProjection): void {
  validateJson(projection, "projection");
  plainObject(projection, "projection");
  plainObject(projection.reference, "reference");
  if (
    projection.family !== "execution-evidence" &&
    projection.family !== "result-evaluation" &&
    projection.family !== "execution-verification"
  ) {
    invalid("Projection family is unsupported.");
  }
  if (projection.reference.family !== projection.family) {
    invalid("Projection family must equal its record-reference family.");
  }
  exactKeys(projection.reference, ["family", "digest"], "reference");
  digest(projection.reference.digest, "reference.digest");
  if (!Number.isSafeInteger(projection.byteSize) || projection.byteSize < 0) {
    invalid("Projection byteSize must be a non-negative safe integer.");
  }
  if (!Array.isArray(projection.declaredEntities)) {
    invalid("declaredEntities must be an array.");
  }
  if (!Array.isArray(projection.declaredRelationships)) {
    invalid("declaredRelationships must be an array.");
  }
  for (const [index, entity] of projection.declaredEntities.entries()) {
    plainObject(entity, `declaredEntities[${index}]`);
    exactKeys(
      entity,
      ["entityId", "types", "name"],
      `declaredEntities[${index}]`,
    );
    nonEmpty(entity.entityId, `declaredEntities[${index}].entityId`);
    if (!Array.isArray(entity.types)) invalid("Entity types must be an array.");
    for (const type of entity.types) nonEmpty(type, "declared entity type");
    if (entity.name !== undefined) {
      stringValue(entity.name, `declaredEntities[${index}].name`);
    }
  }
  for (const [index, relationship] of projection.declaredRelationships.entries()) {
    plainObject(relationship, `declaredRelationships[${index}]`);
    exactKeys(
      relationship,
      ["sourceEntityId", "predicate", "targetEntityId"],
      `declaredRelationships[${index}]`,
    );
    nonEmpty(relationship.sourceEntityId, "relationship source");
    nonEmpty(relationship.predicate, "relationship predicate");
    nonEmpty(relationship.targetEntityId, "relationship target");
  }

  if (projection.family === "execution-evidence") {
    exactKeys(
      projection,
      [
        ...BASE_PROJECTION_KEYS,
        "executionId",
        "task",
        "executorId",
        "runtime",
        "results",
        "nativeTrace",
        "outcome",
        "startedAt",
        "endedAt",
        "publishedAt",
      ],
      "projection",
    );
    nonEmpty(projection.executionId, "executionId");
    nonEmpty(projection.executorId, "executorId");
    artifact(projection.task, "task");
    artifact(projection.runtime, "runtime");
    artifact(projection.nativeTrace, "nativeTrace");
    if (!Array.isArray(projection.results)) {
      invalid("Execution results must be an array.");
    }
    if (projection.outcome === "completed" && projection.results.length === 0) {
      invalid("A completed Execution must declare at least one Result.");
    }
    projection.results.forEach((value, index) => artifact(value, `results[${index}]`));
    if (!["completed", "failed", "abandoned"].includes(projection.outcome)) {
      invalid("Execution outcome is invalid.");
    }
    timestamp(projection.startedAt, "startedAt");
    timestamp(projection.endedAt, "endedAt");
    timestamp(projection.publishedAt, "publishedAt");
    return;
  }

  if (projection.family === "result-evaluation") {
    exactKeys(
      projection,
      [
        ...BASE_PROJECTION_KEYS,
        "taskSubject",
        "resultSubjects",
        "evaluatorId",
        "verdict",
        "evaluatedAt",
        "supersedes",
        "disputes",
      ],
      "projection",
    );
    subject(projection.taskSubject, "taskSubject");
    if (
      !Array.isArray(projection.resultSubjects) ||
      projection.resultSubjects.length === 0
    ) {
      invalid("Evaluation resultSubjects cannot be empty.");
    }
    projection.resultSubjects.forEach((value, index) =>
      subject(value, `resultSubjects[${index}]`),
    );
    if (!Array.isArray(projection.supersedes)) {
      invalid("Evaluation supersedes must be an array.");
    }
    if (!Array.isArray(projection.disputes)) {
      invalid("Evaluation disputes must be an array.");
    }
    projection.supersedes.forEach((value, index) =>
      subject(value, `supersedes[${index}]`),
    );
    projection.disputes.forEach((value, index) =>
      subject(value, `disputes[${index}]`),
    );
    nonEmpty(projection.evaluatorId, "evaluatorId");
    if (!["pass", "fail", "inconclusive"].includes(projection.verdict)) {
      invalid("Evaluation verdict is invalid.");
    }
    timestamp(projection.evaluatedAt, "evaluatedAt");
    return;
  }

  plainObject(projection.subjectRecord, "subjectRecord");
  exactKeys(projection, [
    ...BASE_PROJECTION_KEYS,
    "subjectRecord",
    "executionId",
    "verifierId",
    "verdict",
    "verifiedAt",
    "supersedes",
    "disputes",
  ], "projection");
  exactKeys(projection.subjectRecord, ["family", "digest"], "subjectRecord");
  digest(projection.subjectRecord.digest, "subjectRecord.digest");
  if (projection.subjectRecord.family !== "execution-evidence") {
    invalid("Verification subject record must be Execution Evidence.");
  }
  nonEmpty(projection.executionId, "executionId");
  nonEmpty(projection.verifierId, "verifierId");
  if (!["verified", "rejected", "inconclusive"].includes(projection.verdict)) {
    invalid("Verification verdict is invalid.");
  }
  timestamp(projection.verifiedAt, "verifiedAt");
  if (!Array.isArray(projection.supersedes)) {
    invalid("Verification supersedes must be an array.");
  }
  if (!Array.isArray(projection.disputes)) {
    invalid("Verification disputes must be an array.");
  }
  projection.supersedes.forEach((value, index) =>
    subject(value, `supersedes[${index}]`),
  );
  projection.disputes.forEach((value, index) =>
    subject(value, `disputes[${index}]`),
  );
}

function validateJson(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} must contain finite JSON values.`);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      invalid(`${path} must contain only standard JSON arrays.`);
    }
    if (ancestors.has(value)) invalid(`${path} must not contain cycles.`);
    ancestors.add(value);
    if (
      Reflect.ownKeys(value).some((key) =>
        typeof key !== "string" ||
        (
          key !== "length" &&
          (
            !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= value.length ||
            Number(key) > 0xffff_fffe
          )
        ))
    ) {
      invalid(`${path} must not contain non-index array properties.`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalid(`${path} must contain dense enumerable data-property arrays.`);
      }
      validateJson(descriptor.value, `${path}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(`${path} must contain only plain JSON objects.`);
    }
    if (ancestors.has(value)) invalid(`${path} must not contain cycles.`);
    ancestors.add(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      invalid(`${path} must not contain symbol properties.`);
    }
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        invalid(`${path}.${key} must be an enumerable JSON data property.`);
      }
      validateJson(descriptor.value, `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  invalid(`${path} must contain only JSON values.`);
}

function validateLocation(observation: RecordLocationObservation): void {
  validateJson(observation, "observation");
  plainObject(observation, "observation");
  exactKeys(
    observation,
    [
      "sourceId",
      "announcementId",
      "repositoryId",
      "publishedLocation",
    ],
    "observation",
  );
  nonEmpty(observation.sourceId, "sourceId");
  nonEmpty(observation.announcementId, "announcementId");
  nonEmpty(observation.repositoryId, "repositoryId");
  if (observation.publishedLocation !== undefined) {
    plainObject(observation.publishedLocation, "publishedLocation");
    exactKeys(
      observation.publishedLocation,
      ["bindingProfile", "locator"],
      "publishedLocation",
    );
    nonEmpty(observation.publishedLocation.bindingProfile, "bindingProfile");
    try {
      new URL(observation.publishedLocation.bindingProfile);
    } catch {
      invalid("bindingProfile must be an absolute identifier.");
    }
    plainObject(observation.publishedLocation.locator, "locator");
    validateJson(observation.publishedLocation.locator, "locator");
  }
}

function locationKey(location: EvidenceRecordLocation): string {
  return location.publishedLocation === undefined
    ? deterministicJson(["local", location.repositoryId])
    : deterministicJson([
        "published",
        location.publishedLocation.bindingProfile,
        location.publishedLocation.locator,
      ]);
}

function mentionsEntity(
  projection: CatalogRecordProjection,
  entityId: string,
): boolean {
  if (projection.declaredEntities.some((entity) => entity.entityId === entityId)) {
    return true;
  }
  if (projection.family === "execution-evidence") {
    return [
      projection.executionId,
      projection.task.entityId,
      projection.executorId,
      projection.runtime.entityId,
      projection.nativeTrace.entityId,
      ...projection.results.map(({ entityId: id }) => id),
    ].includes(entityId);
  }
  if (projection.family === "result-evaluation") {
    return (
      projection.evaluatorId === entityId ||
      [projection.taskSubject, ...projection.resultSubjects]
        .map(({ uri }) => uri)
        .includes(entityId)
    );
  }
  return (
    projection.verifierId === entityId || projection.executionId === entityId
  );
}

export class InMemoryEvidenceCatalog
  implements EvidenceCatalogReader, EvidenceCatalogWriter
{
  readonly #records = new Map<string, StoredProjection>();
  readonly #observations = new Map<string, StoredObservation>();
  readonly #withdrawals = new Map<string, StoredWithdrawal>();

  async putRecordProjection(
    projection: CatalogRecordProjection,
    options?: CatalogOperationOptions,
  ): Promise<CatalogWriteReceipt> {
    assertCatalogOperationActive(options);
    validateProjection(projection);
    const key = recordKey(projection.reference);
    const normalized = projectionKey(projection);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.normalized !== normalized) {
        throw new EvidenceCatalogError(
          "PROJECTION_CONFLICT",
          "An unequal projection already exists for this record reference.",
        );
      }
      return { reference: clone(projection.reference), status: "existing" };
    }
    this.#records.set(key, {
      projection: clone(projection),
      normalized,
    });
    return { reference: clone(projection.reference), status: "created" };
  }

  async observeRecordLocation(
    reference: EvidenceRecordReference,
    observation: RecordLocationObservation,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt> {
    assertCatalogOperationActive(options);
    validateLocation(observation);
    const acceptedReference = snapshotReference(reference, "reference");
    if (!this.#records.has(recordKey(acceptedReference))) {
      invalid("A location cannot be observed before its projection exists.");
    }
    const key = observationKey(observation);
    if (this.#withdrawals.has(key)) {
      throw new EvidenceCatalogError(
        "LOCATION_CONFLICT",
        "The announcement identifier was already used by a withdrawal.",
      );
    }
    const existing = this.#observations.get(key);
    const candidate = deterministicJson({
      reference: acceptedReference,
      observation,
    });
    if (existing !== undefined) {
      if (
        deterministicJson({
          reference: existing.reference,
          observation: existing.observation,
        }) !== candidate
      ) {
        throw new EvidenceCatalogError(
          "LOCATION_CONFLICT",
          "The source announcement identifies another record or location.",
        );
      }
      return { status: "existing" };
    }
    this.#observations.set(key, {
      reference: acceptedReference,
      observation: clone(observation),
      active: true,
    });
    return { status: "created" };
  }

  async withdrawRecordLocationObservation(
    withdrawal: RecordLocationWithdrawal,
    options?: CatalogOperationOptions,
  ): Promise<CatalogLocationReceipt> {
    assertCatalogOperationActive(options);
    validateJson(withdrawal, "withdrawal");
    plainObject(withdrawal, "withdrawal");
    exactKeys(
      withdrawal,
      ["sourceId", "announcementId", "retractsAnnouncementId"],
      "withdrawal",
    );
    nonEmpty(withdrawal.sourceId, "sourceId");
    nonEmpty(withdrawal.announcementId, "announcementId");
    nonEmpty(withdrawal.retractsAnnouncementId, "retractsAnnouncementId");
    const withdrawalKey = observationKey(withdrawal);
    const prior = this.#withdrawals.get(withdrawalKey);
    if (prior !== undefined) {
      if (
        deterministicJson(prior.withdrawal) !== deterministicJson(withdrawal)
      ) {
        throw new EvidenceCatalogError(
          "LOCATION_CONFLICT",
          "The withdrawal announcement identifier targets another event.",
        );
      }
      return { status: "existing" };
    }
    if (this.#observations.has(withdrawalKey)) {
      throw new EvidenceCatalogError(
        "LOCATION_CONFLICT",
        "The announcement identifier was already used by an availability event.",
      );
    }
    const targetKey = observationKey({
      sourceId: withdrawal.sourceId,
      announcementId: withdrawal.retractsAnnouncementId,
    });
    const target = this.#observations.get(targetKey);
    if (target === undefined) {
      const foreign = [...this.#observations.values()].some(
        ({ observation }) =>
          observation.announcementId === withdrawal.retractsAnnouncementId &&
          observation.sourceId !== withdrawal.sourceId,
      );
      if (foreign) {
        throw new EvidenceCatalogError(
          "LOCATION_CONFLICT",
          "A source cannot withdraw another source's observation.",
        );
      }
      this.#withdrawals.set(withdrawalKey, {
        withdrawal: clone(withdrawal),
        initialStatus: "absent",
      });
      return { status: "absent" };
    }
    const initialStatus = target.active ? "withdrawn" : "absent";
    target.active = false;
    this.#withdrawals.set(withdrawalKey, {
      withdrawal: clone(withdrawal),
      initialStatus,
    });
    return { status: initialStatus };
  }

  async getRecord(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<CatalogRecordProjection | null> {
    assertCatalogOperationActive(options);
    const acceptedReference = snapshotReference(reference, "reference");
    const stored = this.#records.get(recordKey(acceptedReference));
    return stored === undefined ? null : clone(stored.projection);
  }

  #hasActiveLocation(reference: EvidenceRecordReference): boolean {
    const key = recordKey(reference);
    return [...this.#observations.values()].some(
      (stored) => stored.active && recordKey(stored.reference) === key,
    );
  }

  #available<T extends CatalogRecordProjection>(
    values: readonly T[],
    availability: "available" | "any" | undefined,
  ): T[] {
    return availability === "any"
      ? [...values]
      : values.filter((projection) =>
          this.#hasActiveLocation(projection.reference),
        );
  }

  async findRecordsForEntity(
    entityId: string,
    query: EntityRecordQuery = {},
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<CatalogRecordProjection>> {
    assertCatalogOperationActive(options);
    query = snapshotEntityRecordQuery(query);
    const values = [...this.#records.values()]
      .map(({ projection }) => projection)
      .filter((projection) => mentionsEntity(projection, entityId));
    return clone(
      paginateEntityRecords(
        this.#available(values, query.availability),
        query,
        entityId,
      ),
    );
  }

  async findExecutions(
    query: ExecutionCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionEvidenceProjection>> {
    assertCatalogOperationActive(options);
    query = snapshotExecutionCatalogQuery(query);
    const values = [...this.#records.values()]
      .map(({ projection }) => projection)
      .filter(
        (projection): projection is ExecutionEvidenceProjection =>
          projection.family === "execution-evidence",
      );
    return clone(
      paginateExecutions(this.#available(values, query.availability), query),
    );
  }

  async findEvaluations(
    query: EvaluationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ResultEvaluationProjection>> {
    assertCatalogOperationActive(options);
    query = snapshotEvaluationCatalogQuery(query);
    const values = [...this.#records.values()]
      .map(({ projection }) => projection)
      .filter(
        (projection): projection is ResultEvaluationProjection =>
          projection.family === "result-evaluation",
      );
    return clone(
      paginateEvaluations(this.#available(values, query.availability), query),
    );
  }

  async findVerifications(
    query: VerificationCatalogQuery,
    options?: CatalogOperationOptions,
  ): Promise<CatalogPage<ExecutionVerificationProjection>> {
    assertCatalogOperationActive(options);
    query = snapshotVerificationCatalogQuery(query);
    const values = [...this.#records.values()]
      .map(({ projection }) => projection)
      .filter(
        (projection): projection is ExecutionVerificationProjection =>
          projection.family === "execution-verification",
      );
    return clone(
      paginateVerifications(this.#available(values, query.availability), query),
    );
  }

  async getRecordLocations(
    reference: EvidenceRecordReference,
    options?: CatalogOperationOptions,
  ): Promise<readonly EvidenceRecordLocation[]> {
    assertCatalogOperationActive(options);
    const acceptedReference = snapshotReference(reference, "reference");
    const key = recordKey(acceptedReference);
    const locations = new Map<string, EvidenceRecordLocation>();
    for (const stored of this.#observations.values()) {
      if (!stored.active || recordKey(stored.reference) !== key) continue;
      const location: EvidenceRecordLocation = {
        repositoryId: stored.observation.repositoryId,
        ...(stored.observation.publishedLocation === undefined
          ? {}
          : { publishedLocation: stored.observation.publishedLocation }),
      };
      const identity = locationKey(location);
      const existing = locations.get(identity);
      if (
        existing === undefined ||
        location.repositoryId < existing.repositoryId
      ) {
        locations.set(identity, location);
      }
    }
    return clone(
      [...locations.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, location]) => location),
    );
  }
}
