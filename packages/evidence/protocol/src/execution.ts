import { recordDigest } from "./hashing.js";
import {
  ABANDONED_ACTION_STATUS,
  EXECUTION_EVIDENCE_PROFILE_URI,
} from "./identifiers.js";
import {
  ExecutionEvidenceDocumentSchema,
  type ExecutionEvidenceDocument,
} from "./schemas.js";
import type {
  ConformanceDiagnostic,
  ConformanceDiagnosticCode,
  ValidationReport,
} from "./types.js";
import { compareCodeUnitStrings } from "./order.js";

type Entity = ExecutionEvidenceDocument["@graph"][number];
type JsonObject = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const UUID_URN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE_PROPERTIES = new Set([
  "about",
  "agent",
  "conformsTo",
  "creator",
  "environment",
  "hasPart",
  "instrument",
  "jinn:dispositionCount",
  "license",
  "mentions",
  "object",
  "prov:wasDerivedFrom",
  "prov:wasGeneratedBy",
  "provider",
  "resourceUsage",
  "result",
  "softwareRequirements",
  "subjectOf",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function types(entity: Entity | undefined): readonly string[] {
  if (!entity) return [];
  return Array.isArray(entity["@type"])
    ? entity["@type"]
    : [entity["@type"]];
}

function hasType(entity: Entity | undefined, type: string): boolean {
  return types(entity).includes(type);
}

function isAgentEntity(entity: Entity | undefined): boolean {
  return types(entity).some((type) =>
    ["Person", "Organization", "prov:Agent", "prov:SoftwareAgent"].includes(
      type,
    ),
  );
}

function values(value: unknown): readonly unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function rawReferences(value: unknown): readonly string[] | undefined {
  const references: string[] = [];
  for (const candidate of values(value)) {
    if (
      !isObject(candidate) ||
      typeof candidate["@id"] !== "string" ||
      Object.keys(candidate).some((key) => key !== "@id")
    ) {
      return undefined;
    }
    references.push(candidate["@id"]);
  }
  return references;
}

function isAbsoluteIri(value: string): boolean {
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

function issue(
  code: ConformanceDiagnosticCode,
  path: string,
  message: string,
  entityId?: string,
): ConformanceDiagnostic {
  return {
    code,
    path,
    message,
    ...(entityId === undefined ? {} : { entityId }),
  };
}

function ordered(
  diagnostics: readonly ConformanceDiagnostic[],
): readonly ConformanceDiagnostic[] {
  const sorted = [...diagnostics].sort(
    (left, right) =>
      compareCodeUnitStrings(left.path, right.path) ||
      compareCodeUnitStrings(left.code, right.code) ||
      compareCodeUnitStrings((left.entityId ?? ""), right.entityId ?? "") ||
      compareCodeUnitStrings(left.message, right.message),
  );
  const seen = new Set<string>();
  return sorted.filter((diagnostic) => {
    const key = `${diagnostic.code}\0${diagnostic.path}\0${diagnostic.entityId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseJson(
  bytes: Uint8Array,
): { value?: unknown; diagnostic?: ConformanceDiagnostic } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      diagnostic: issue("UTF8_INVALID", "", "Input is not valid UTF-8."),
    };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return {
      diagnostic: issue("JSON_INVALID", "", "Input is not valid JSON."),
    };
  }
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

interface Graph {
  readonly entities: readonly Entity[];
  readonly byId: ReadonlyMap<string, Entity>;
  readonly indexByEntity: ReadonlyMap<Entity, number>;
}

function graphPath(graph: Graph, entity: Entity, property?: string): string {
  const index = graph.indexByEntity.get(entity);
  return `/@graph/${index ?? 0}${property ? `/${property}` : ""}`;
}

function entityRefs(
  graph: Graph,
  entity: Entity,
  property: string,
  diagnostics: ConformanceDiagnostic[],
): readonly string[] {
  const references = rawReferences(entity[property]);
  if (references === undefined) {
    diagnostics.push(
      issue(
        "ROCRATE_REFERENCE_INVALID",
        graphPath(graph, entity, property),
        `${property} must contain only @id reference objects.`,
        entity["@id"],
      ),
    );
    return [];
  }
  return references;
}

function resolved(
  graph: Graph,
  references: readonly string[],
): readonly Entity[] {
  return references
    .map((reference) => graph.byId.get(reference))
    .filter((entity): entity is Entity => entity !== undefined);
}

function isDerived(entity: Entity): boolean {
  return rawReferences(entity["prov:wasDerivedFrom"])?.length
    ? true
    : false;
}

function validDigest(entity: Entity): boolean {
  return typeof entity.sha256 === "string" && SHA256.test(entity.sha256);
}

function contentBound(entity: Entity): boolean {
  return validDigest(entity);
}

function validateContext(
  document: ExecutionEvidenceDocument,
  diagnostics: ConformanceDiagnostic[],
): void {
  const contexts = Array.isArray(document["@context"])
    ? document["@context"]
    : [document["@context"]];
  const strings = new Set(
    contexts.filter((context): context is string => typeof context === "string"),
  );
  const mappings = Object.assign(
    {},
    ...contexts.filter((context): context is JsonObject => isObject(context)),
  ) as JsonObject;

  if (
    !strings.has("https://w3id.org/ro/crate/1.3/context") ||
    !strings.has("https://w3id.org/ro/terms/workflow-run/context") ||
    mappings.prov !== "http://www.w3.org/ns/prov#" ||
    mappings.jinn !== "https://spec.jinn.network/terms/"
  ) {
    diagnostics.push(
      issue(
        "ROCRATE_CONTEXT_INVALID",
        "/@context",
        "Context must declare RO-Crate 1.3, workflow-run, prov, and jinn.",
      ),
    );
  }
}

function validateReferenceShapes(
  graph: Graph,
  diagnostics: ConformanceDiagnostic[],
): void {
  for (const entity of graph.entities) {
    for (const property of REFERENCE_PROPERTIES) {
      if (
        entity[property] !== undefined &&
        rawReferences(entity[property]) === undefined
      ) {
        diagnostics.push(
          issue(
            "ROCRATE_REFERENCE_INVALID",
            graphPath(graph, entity, property),
            `${property} must contain only @id reference objects.`,
            entity["@id"],
          ),
        );
      }
    }
  }
}

function validateArtifacts(
  graph: Graph,
  diagnostics: ConformanceDiagnostic[],
): void {
  for (const entity of graph.entities) {
    const entityPath = graphPath(graph, entity);
    if (hasType(entity, "File")) {
      if (entity.sha256 === undefined) {
        diagnostics.push(
          issue(
            "ARTIFACT_SHA256_MISSING",
            `${entityPath}/sha256`,
            "Byte-bearing File entity must carry SHA-256.",
            entity["@id"],
          ),
        );
      } else if (!validDigest(entity)) {
        diagnostics.push(
          issue(
            "ARTIFACT_SHA256_INVALID",
            `${entityPath}/sha256`,
            "SHA-256 must be 64 lowercase hexadecimal characters.",
            entity["@id"],
          ),
        );
      }
    } else if (entity.sha256 !== undefined && !validDigest(entity)) {
      diagnostics.push(
        issue(
          "ARTIFACT_SHA256_INVALID",
          `${entityPath}/sha256`,
          "SHA-256 must be 64 lowercase hexadecimal characters.",
          entity["@id"],
        ),
      );
    }

    if (
      entity["@id"] !== "./" &&
      (hasType(entity, "Dataset") || hasType(entity, "Collection")) &&
      entity.hasPart !== undefined
    ) {
      const parts = rawReferences(entity.hasPart) ?? [];
      if (
        !validDigest(entity) ||
        parts.length === 0 ||
        parts.some((id) => {
          const part = graph.byId.get(id);
          return !part || !contentBound(part);
        })
      ) {
        diagnostics.push(
          issue(
            "AGGREGATE_MANIFEST_INVALID",
            entityPath,
            "Aggregate artifacts require a content-bound manifest and content-bound members.",
            entity["@id"],
          ),
        );
      }
    }
  }
}

function validateDerivations(
  graph: Graph,
  diagnostics: ConformanceDiagnostic[],
): void {
  for (const entity of graph.entities) {
    const predecessors = rawReferences(entity["prov:wasDerivedFrom"]) ?? [];
    if (predecessors.length === 0) continue;
    const activities = rawReferences(entity["prov:wasGeneratedBy"]) ?? [];
    const activity =
      activities.length === 1 ? graph.byId.get(activities[0]!) : undefined;
    const agents = activity ? rawReferences(activity.agent) ?? [] : [];
    if (
      !activity ||
      !hasType(activity, "prov:Activity") ||
      agents.length !== 1 ||
      typeof activity.endTime !== "string" ||
      !isAbsoluteIri(agents[0] ?? "")
    ) {
      diagnostics.push(
        issue(
          "DERIVATION_PROVENANCE_INVALID",
          graphPath(graph, entity, "prov:wasGeneratedBy"),
          "Derived entity must reference a completed transformation activity and Agent.",
          entity["@id"],
        ),
      );
    }

    if (entity["@id"] === "./" && activity) {
      const source =
        predecessors.length === 1
          ? graph.byId.get(predecessors[0]!)
          : undefined;
      const policyIds = rawReferences(activity.instrument) ?? [];
      const policy =
        policyIds.length === 1 ? graph.byId.get(policyIds[0]!) : undefined;
      const countIds =
        rawReferences(activity["jinn:dispositionCount"]) ?? [];
      const counts = resolved(graph, countIds);
      const mappings = graph.entities.filter((candidate) => {
        if (candidate === entity) return false;
        const generatedBy =
          rawReferences(candidate["prov:wasGeneratedBy"]) ?? [];
        const derivedFrom =
          rawReferences(candidate["prov:wasDerivedFrom"]) ?? [];
        return (
          generatedBy.includes(activity["@id"]) && derivedFrom.length > 0
        );
      });
      const generatedEntities = graph.entities.filter((candidate) =>
        (rawReferences(candidate["prov:wasGeneratedBy"]) ?? []).includes(
          activity["@id"],
        ),
      );
      const circularDigestDeclared = [activity, ...generatedEntities].some(
        (candidate) =>
          candidate.derivedMetadataDigest !== undefined ||
          candidate["jinn:derivedMetadataDigest"] !== undefined,
      );

      if (
        !source ||
        !contentBound(source) ||
        !policy ||
        !contentBound(policy) ||
        countIds.length === 0 ||
        countIds.length !== counts.length ||
        counts.some(
          (count) =>
            !hasType(count, "PropertyValue") ||
            typeof count.name !== "string" ||
            typeof count.value !== "number" ||
            count.value < 0,
        ) ||
        mappings.length === 0 ||
        circularDigestDeclared
      ) {
        diagnostics.push(
          issue(
            "DERIVATION_PROVENANCE_INVALID",
            graphPath(graph, activity),
            "Public derivation requires a private source commitment, content-bound policy, artifact mapping, disposition counts, and no circular derived metadata digest.",
            activity["@id"],
          ),
        );
      }
    }
  }
}

function validateRoot(
  graph: Graph,
  diagnostics: ConformanceDiagnostic[],
): Entity | undefined {
  const roots = graph.entities.filter(
    (entity) => entity["@id"] === "./" && hasType(entity, "Dataset"),
  );
  if (roots.length !== 1) {
    diagnostics.push(
      issue(
        "ROCRATE_ROOT_CARDINALITY",
        "/@graph",
        "Graph must contain exactly one ./ Root Dataset.",
      ),
    );
    return undefined;
  }
  const root = roots[0]!;
  const requiredStrings = ["name", "description", "datePublished"] as const;
  const license = rawReferences(root.license);
  const hasPart = rawReferences(root.hasPart);
  if (
    requiredStrings.some(
      (property) =>
        typeof root[property] !== "string" || root[property].length === 0,
    ) ||
    !license?.length ||
    !hasPart?.length
  ) {
    diagnostics.push(
      issue(
        "ROCRATE_ROOT_FIELDS_INVALID",
        graphPath(graph, root),
        "Root Dataset is missing required descriptive metadata.",
        root["@id"],
      ),
    );
  }

  const conformsTo = rawReferences(root.conformsTo) ?? [];
  if (!conformsTo.includes(EXECUTION_EVIDENCE_PROFILE_URI)) {
    diagnostics.push(
      issue(
        "PROFILE_DECLARATION_MISSING",
        graphPath(graph, root, "conformsTo"),
        "Root Dataset must declare the Execution Evidence profile.",
        root["@id"],
      ),
    );
  }

  const creators = rawReferences(root.creator) ?? [];
  const creator = creators.length === 1 ? graph.byId.get(creators[0]!) : undefined;
  if (
    creators.length !== 1 ||
    !creator ||
    !isAbsoluteIri(creator["@id"]) ||
    !isAgentEntity(creator) ||
    typeof root.datePublished !== "string"
  ) {
    diagnostics.push(
      issue(
        "CAPTURE_PROVENANCE_MISSING",
        graphPath(graph, root, "creator"),
        "Root Dataset must identify its capture Agent and completion time.",
        root["@id"],
      ),
    );
  }
  return root;
}

function validateMetadataDescriptor(
  graph: Graph,
  diagnostics: ConformanceDiagnostic[],
): void {
  const descriptors = graph.entities.filter(
    (entity) =>
      entity["@id"] === "ro-crate-metadata.json" &&
      hasType(entity, "CreativeWork"),
  );
  if (descriptors.length !== 1) {
    diagnostics.push(
      issue(
        "ROCRATE_METADATA_DESCRIPTOR_CARDINALITY",
        "/@graph",
        "Graph must contain exactly one RO-Crate Metadata Descriptor.",
      ),
    );
    return;
  }
  const descriptor = descriptors[0]!;
  if (
    !(rawReferences(descriptor.about) ?? []).includes("./") ||
    !(rawReferences(descriptor.conformsTo) ?? []).includes(
      "https://w3id.org/ro/crate/1.3",
    )
  ) {
    diagnostics.push(
      issue(
        "ROCRATE_GRAPH_INVALID",
        graphPath(graph, descriptor),
        "Metadata Descriptor must describe ./ and conform to RO-Crate 1.3.",
        descriptor["@id"],
      ),
    );
  }
}

function validateProfileEntity(
  graph: Graph,
  diagnostics: ConformanceDiagnostic[],
): void {
  const profile = graph.byId.get(EXECUTION_EVIDENCE_PROFILE_URI);
  if (
    !profile ||
    !hasType(profile, "CreativeWork") ||
    !hasType(profile, "Profile")
  ) {
    diagnostics.push(
      issue(
        "PROFILE_CONTEXTUAL_ENTITY_MISSING",
        "/@graph",
        "Graph must describe the declared profile as CreativeWork and Profile.",
      ),
    );
  }
}

function validateExactRole(
  graph: Graph,
  execution: Entity,
  entity: Entity,
  property: string,
  diagnostics: ConformanceDiagnostic[],
): void {
  if (isDerived(entity)) {
    diagnostics.push(
      issue(
        "DERIVATIVE_ROLE_SUBSTITUTION",
        graphPath(graph, execution, property),
        `Derived entity ${entity["@id"]} cannot occupy the exact ${property} role.`,
        entity["@id"],
      ),
    );
  }
}

function validateExecution(
  graph: Graph,
  root: Entity,
  diagnostics: ConformanceDiagnostic[],
): void {
  const mentioned = entityRefs(graph, root, "mentions", diagnostics);
  const executions = resolved(graph, mentioned).filter(
    (entity) =>
      hasType(entity, "CreateAction") && hasType(entity, "prov:Activity"),
  );
  if (mentioned.length !== 1 || executions.length !== 1) {
    diagnostics.push(
      issue(
        "EXECUTION_CARDINALITY",
        graphPath(graph, root, "mentions"),
        "Root Dataset must mention exactly one primary Execution.",
        root["@id"],
      ),
    );
    return;
  }
  const execution = executions[0]!;
  if (!UUID_URN.test(execution["@id"])) {
    diagnostics.push(
      issue(
        "EXECUTION_RELATION_INVALID",
        graphPath(graph, execution, "@id"),
        "Execution id must be a urn:uuid IRI.",
        execution["@id"],
      ),
    );
  }

  const objectIds = entityRefs(graph, execution, "object", diagnostics);
  const objects = resolved(graph, objectIds);
  const tasks = objects.filter((entity) => hasType(entity, "prov:Plan"));
  if (tasks.length !== 1) {
    diagnostics.push(
      issue(
        "TASK_CARDINALITY",
        graphPath(graph, execution, "object"),
        "Execution object must resolve to exactly one Task.",
        execution["@id"],
      ),
    );
  } else {
    const task = tasks[0]!;
    if (
      !hasType(task, "File") ||
      !hasType(task, "CreativeWork") ||
      typeof task.encodingFormat !== "string"
    ) {
      diagnostics.push(
        issue(
          "EXECUTION_RELATION_INVALID",
          graphPath(graph, execution, "object"),
          "Task must be a content-bound File, CreativeWork, and prov:Plan.",
          task["@id"],
        ),
      );
    }
    validateExactRole(graph, execution, task, "object", diagnostics);
  }
  if (objectIds.length !== objects.length) {
    diagnostics.push(
      issue(
        "EXECUTION_RELATION_INVALID",
        graphPath(graph, execution, "object"),
        "Every Task and input reference must resolve in the graph.",
        execution["@id"],
      ),
    );
  }

  const agentIds = entityRefs(graph, execution, "agent", diagnostics);
  const agents = resolved(graph, agentIds);
  if (agentIds.length !== 1 || agents.length !== 1) {
    diagnostics.push(
      issue(
        "EXECUTOR_AGENT_CARDINALITY",
        graphPath(graph, execution, "agent"),
        "Execution must resolve to exactly one primary Executor Agent.",
        execution["@id"],
      ),
    );
  } else {
    const agent = agents[0]!;
    if (
      !isAbsoluteIri(agent["@id"]) ||
      !isAgentEntity(agent)
    ) {
      diagnostics.push(
        issue(
          "AGENT_IRI_INVALID",
          graphPath(graph, agent, "@id"),
          "Executor Agent must have an absolute IRI and Agent-compatible type.",
          agent["@id"],
        ),
      );
    }
  }

  const runtimeIds = entityRefs(graph, execution, "instrument", diagnostics);
  const runtimes = resolved(graph, runtimeIds).filter((entity) =>
    hasType(entity, "SoftwareApplication"),
  );
  if (runtimeIds.length !== 1 || runtimes.length !== 1) {
    diagnostics.push(
      issue(
        "RUNTIME_SPECIFICATION_CARDINALITY",
        graphPath(graph, execution, "instrument"),
        "Execution must resolve to exactly one Runtime Specification.",
        execution["@id"],
      ),
    );
  } else {
    const runtime = runtimes[0]!;
    validateExactRole(graph, execution, runtime, "instrument", diagnostics);
    const componentIds = entityRefs(
      graph,
      runtime,
      "hasPart",
      diagnostics,
    );
    const components = resolved(graph, componentIds);
    if (
      componentIds.length === 0 ||
      componentIds.length !== components.length ||
      !contentBound(runtime) ||
      components.some((component) => !contentBound(component))
    ) {
      diagnostics.push(
        issue(
          "RUNTIME_COMPONENT_BINDING_MISSING",
          graphPath(graph, execution, "instrument"),
          "Runtime Specification must reference a content-bound controlled component or opaque observation.",
          runtime["@id"],
        ),
      );
    }
  }

  const statusIds = entityRefs(
    graph,
    execution,
    "actionStatus",
    diagnostics,
  );
  const status = statusIds[0];
  const startTime =
    typeof execution.startTime === "string"
      ? Date.parse(execution.startTime)
      : Number.NaN;
  const endTime =
    typeof execution.endTime === "string"
      ? Date.parse(execution.endTime)
      : Number.NaN;
  const statuses = new Set([
    "https://schema.org/CompletedActionStatus",
    "https://schema.org/FailedActionStatus",
    ABANDONED_ACTION_STATUS,
    "jinn:AbandonedActionStatus",
  ]);
  if (
    statusIds.length !== 1 ||
    !status ||
    !statuses.has(status) ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    endTime < startTime
  ) {
    diagnostics.push(
      issue(
        "EXECUTION_STATUS_INVALID",
        graphPath(graph, execution, "actionStatus"),
        "Execution lifecycle status and timestamps are invalid.",
        execution["@id"],
      ),
    );
  }

  const resultIds = entityRefs(graph, execution, "result", diagnostics);
  const results = resolved(graph, resultIds);
  if (
    status === "https://schema.org/CompletedActionStatus" &&
    results.length === 0
  ) {
    diagnostics.push(
      issue(
        "EXECUTION_COMPLETED_RESULT_MISSING",
        graphPath(graph, execution, "result"),
        "Completed Execution must have at least one Result.",
        execution["@id"],
      ),
    );
  }
  for (const result of results) {
    validateExactRole(graph, execution, result, "result", diagnostics);
    const generatedBy = rawReferences(result["prov:wasGeneratedBy"]) ?? [];
    if (
      !contentBound(result) ||
      !generatedBy.includes(execution["@id"]) ||
      (hasType(result, "File") && typeof result.encodingFormat !== "string")
    ) {
      diagnostics.push(
        issue(
          "EXECUTION_RELATION_INVALID",
          graphPath(graph, execution, "result"),
          "Result must be content-bound and generated by the Execution.",
          result["@id"],
        ),
      );
    }
  }

  const traceIds = entityRefs(graph, execution, "subjectOf", diagnostics);
  const traces = resolved(graph, traceIds);
  if (traceIds.length !== 1 || traces.length !== 1) {
    diagnostics.push(
      issue(
        "TRACE_CARDINALITY",
        graphPath(graph, execution, "subjectOf"),
        "Execution must select exactly one primary native trace with subjectOf.",
        execution["@id"],
      ),
    );
  } else {
    const trace = traces[0]!;
    validateExactRole(graph, execution, trace, "subjectOf", diagnostics);
    const about = rawReferences(trace.about) ?? [];
    const conformsTo = rawReferences(trace.conformsTo) ?? [];
    if (
      !types(trace).some((type) =>
        ["File", "Dataset", "Collection"].includes(type),
      ) ||
      !contentBound(trace) ||
      !about.includes(execution["@id"]) ||
      conformsTo.length === 0
    ) {
      diagnostics.push(
        issue(
          "EXECUTION_RELATION_INVALID",
          graphPath(graph, execution, "subjectOf"),
          "Native trace must be content-bound, formatted, and about the Execution.",
          trace["@id"],
        ),
      );
    }
  }

  const usageIds = entityRefs(graph, execution, "resourceUsage", diagnostics);
  const duration = resolved(graph, usageIds).filter(
    (entity) =>
      hasType(entity, "PropertyValue") &&
      (entity.name === "durationMs" ||
        (typeof entity.propertyID === "string" &&
          entity.propertyID.endsWith("/durationMs"))),
  );
  if (
    duration.length !== 1 ||
    typeof duration[0]?.value !== "number" ||
    (typeof duration[0]?.unitCode !== "string" &&
      typeof duration[0]?.unitText !== "string")
  ) {
    diagnostics.push(
      issue(
        "DURATION_MISSING",
        graphPath(graph, execution, "resourceUsage"),
        "Execution must reference exactly one numeric duration PropertyValue with a unit.",
        execution["@id"],
      ),
    );
  } else if (
    Number.isFinite(startTime) &&
    Number.isFinite(endTime)
  ) {
    const observed = endTime - startTime;
    if (Number.isFinite(observed) && observed !== duration[0].value) {
      diagnostics.push(
        issue(
          "EXECUTION_RELATION_INVALID",
          graphPath(graph, execution, "resourceUsage"),
          "Duration does not match Execution timestamps.",
          duration[0]["@id"],
        ),
      );
    }
  }
}

export function validateExecutionEvidence(
  metadataBytes: Uint8Array,
): ValidationReport<ExecutionEvidenceDocument> {
  const digest = recordDigest(metadataBytes);
  const parsed = parseJson(metadataBytes);
  if (parsed.diagnostic) {
    return {
      conforms: false,
      recordDigest: digest,
      diagnostics: [parsed.diagnostic],
    };
  }

  const schema = ExecutionEvidenceDocumentSchema.safeParse(parsed.value);
  if (!schema.success) {
    const diagnostics = schema.error.issues.map((schemaIssue) => {
      const path = pointer(schemaIssue.path);
      const code: ConformanceDiagnosticCode = schemaIssue.path.includes("@type")
        ? "ROCRATE_ENTITY_TYPE_MISSING"
        : schemaIssue.path.includes("@id")
          ? "ROCRATE_ENTITY_ID_MISSING"
          : "SCHEMA_INVALID";
      return issue(code, path, schemaIssue.message);
    });
    return {
      conforms: false,
      recordDigest: digest,
      diagnostics: ordered(diagnostics),
    };
  }

  const index = new Map<string, Entity>();
  const duplicates = new Set<string>();
  const indexByEntity = new Map<Entity, number>();
  for (const [entityIndex, entity] of schema.data["@graph"].entries()) {
    indexByEntity.set(entity, entityIndex);
    if (index.has(entity["@id"])) duplicates.add(entity["@id"]);
    else index.set(entity["@id"], entity);
  }
  const graph: Graph = Object.freeze({
    entities: Object.freeze([...schema.data["@graph"]]),
    byId: index,
    indexByEntity,
  });
  const diagnostics: ConformanceDiagnostic[] = [];

  validateContext(schema.data, diagnostics);
  validateReferenceShapes(graph, diagnostics);
  for (const duplicate of duplicates) {
    const duplicateEntity = graph.entities.find(
      (entity) => entity["@id"] === duplicate,
    );
    diagnostics.push(
      issue(
        "ROCRATE_ENTITY_ID_DUPLICATE",
        duplicateEntity ? graphPath(graph, duplicateEntity, "@id") : "/@graph",
        `Graph entity id ${duplicate} is duplicated.`,
        duplicate,
      ),
    );
  }

  if (duplicates.size === 0) {
    validateMetadataDescriptor(graph, diagnostics);
    const root = validateRoot(graph, diagnostics);
    validateProfileEntity(graph, diagnostics);
    validateArtifacts(graph, diagnostics);
    validateDerivations(graph, diagnostics);
    for (const entity of graph.entities.filter(isAgentEntity)) {
      if (!isAbsoluteIri(entity["@id"])) {
        diagnostics.push(
          issue(
            "AGENT_IRI_INVALID",
            graphPath(graph, entity, "@id"),
            "Agent id must be an absolute IRI.",
            entity["@id"],
          ),
        );
      }
    }
    if (root) validateExecution(graph, root, diagnostics);
  }

  const result = ordered(diagnostics);
  return {
    conforms: result.length === 0,
    recordDigest: digest,
    value: schema.data,
    diagnostics: result,
  };
}
