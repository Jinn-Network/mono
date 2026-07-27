import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  EXECUTION_EVIDENCE_PROFILE_URI,
  recordDigest,
  validateExecutionEvidence,
} from "./index.js";

type Entity = Record<string, any> & { "@id": string; "@type": any };
type Document = {
  "@context": any[];
  "@graph": Entity[];
  [key: string]: unknown;
};

const fixtureUrl = (path: string) =>
  new URL(`../fixtures/${path}`, import.meta.url);

let golden: Document;
let candidateBytes: Uint8Array;

function bytes(document: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

function clone(): Document {
  return structuredClone(golden);
}

function entity(document: Document, id: string): Entity {
  const value = document["@graph"].find((candidate) => candidate["@id"] === id);
  if (!value) throw new Error(`Missing test entity ${id}`);
  return value;
}

function remove(document: Document, id: string): void {
  document["@graph"] = document["@graph"].filter(
    (candidate) => candidate["@id"] !== id,
  );
}

function codes(document: Document): string[] {
  return validateExecutionEvidence(bytes(document)).diagnostics.map(
    ({ code }) => code,
  );
}

beforeAll(async () => {
  golden = JSON.parse(
    await readFile(
      fixtureUrl(
        "golden-execution-evidence-v1/execution/ro-crate-metadata.json",
      ),
      "utf8",
    ),
  );
  golden["@context"].push({ jinn: "https://jinn.network/terms/" });
  entity(
    golden,
    "urn:uuid:22222222-2222-4222-8222-222222222222",
  ).subjectOf = { "@id": "trace/trajectory.jsonl" };
  candidateBytes = await readFile(
    fixtureUrl("autopilot-issue-1697/candidate-execution-graph.json"),
  );
});

describe("Execution Evidence validation", () => {
  it("accepts the constrained golden graph and binds its exact bytes", () => {
    const metadataBytes = bytes(golden);
    const report = validateExecutionEvidence(metadataBytes);

    expect(report).toMatchObject({
      conforms: true,
      recordDigest: recordDigest(metadataBytes),
      diagnostics: [],
    });
    expect(report.value?.["x-extension"]).toBeUndefined();
  });

  it("preserves unknown JSON-LD extension fields", () => {
    const document = clone();
    document["x-extension"] = { retained: true };
    entity(document, "./")["x-root-extension"] = 42;

    const report = validateExecutionEvidence(bytes(document));

    expect(report.conforms).toBe(true);
    expect(report.value?.["x-extension"]).toEqual({ retained: true });
    expect(report.value?.["@graph"][1]?.["x-root-extension"]).toBe(42);
  });

  it.each([
    ["task/task.md", "TASK_CARDINALITY"],
    [
      "urn:uuid:33333333-3333-4333-8333-333333333333",
      "EXECUTOR_AGENT_CARDINALITY",
    ],
    ["runtime/runtime-specification.json", "RUNTIME_SPECIFICATION_CARDINALITY"],
    ["trace/trajectory.jsonl", "TRACE_CARDINALITY"],
    ["#duration-ms", "DURATION_MISSING"],
    ["./", "ROCRATE_ROOT_CARDINALITY"],
  ])("rejects a missing required %s entity", (id, code) => {
    const document = clone();
    remove(document, id);
    expect(codes(document)).toContain(code);
  });

  it("rejects duplicate graph IDs without cascading role errors", () => {
    const document = clone();
    document["@graph"].push(structuredClone(entity(document, "task/task.md")));

    const report = validateExecutionEvidence(bytes(document));

    expect(report.diagnostics.map(({ code }) => code)).toContain(
      "ROCRATE_ENTITY_ID_DUPLICATE",
    );
    expect(
      report.diagnostics.filter(({ code }) => code === "TASK_CARDINALITY"),
    ).toHaveLength(0);
  });

  it("requires Results only for completed executions", () => {
    const completed = clone();
    const completedExecution = entity(
      completed,
      "urn:uuid:22222222-2222-4222-8222-222222222222",
    );
    delete completedExecution.result;

    expect(codes(completed)).toContain("EXECUTION_COMPLETED_RESULT_MISSING");

    const failed = structuredClone(completed);
    entity(
      failed,
      "urn:uuid:22222222-2222-4222-8222-222222222222",
    ).actionStatus = { "@id": "https://schema.org/FailedActionStatus" };
    expect(validateExecutionEvidence(bytes(failed)).conforms).toBe(true);

    const abandoned = structuredClone(completed);
    entity(
      abandoned,
      "urn:uuid:22222222-2222-4222-8222-222222222222",
    ).actionStatus = { "@id": "jinn:AbandonedActionStatus" };
    expect(validateExecutionEvidence(bytes(abandoned)).conforms).toBe(true);
  });

  it("rejects invalid identity, digest, and unresolved role relationships", () => {
    const document = clone();
    entity(
      document,
      "urn:uuid:33333333-3333-4333-8333-333333333333",
    )["@id"] = "relative-agent";
    entity(document, "task/task.md").sha256 = "not-a-digest";
    entity(
      document,
      "urn:uuid:22222222-2222-4222-8222-222222222222",
    ).instrument = { "@id": "missing-runtime.json" };

    const reportCodes = codes(document);
    expect(reportCodes).toContain("AGENT_IRI_INVALID");
    expect(reportCodes).toContain("ARTIFACT_SHA256_INVALID");
    expect(reportCodes).toContain("RUNTIME_SPECIFICATION_CARDINALITY");
  });

  it("requires absolute IRIs for every Agent-compatible entity", () => {
    const document = clone();
    document["@graph"].push({
      "@id": "relative-person",
      "@type": "Person",
      name: "Relative person",
    });

    expect(codes(document)).toContain("AGENT_IRI_INVALID");
  });

  it.each([
    ["task/task.md", "object"],
    ["runtime/runtime-specification.json", "instrument"],
    ["trace/trajectory.jsonl", "subjectOf"],
    ["results/slug-normalization.patch", "result"],
  ])("rejects a derived entity in the exact %s role", (id) => {
    const document = clone();
    entity(document, id)["prov:wasDerivedFrom"] = {
      "@id": "urn:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    expect(codes(document)).toContain("DERIVATIVE_ROLE_SUBSTITUTION");
  });

  it("validates runtime components, aggregate manifests, and capture provenance", () => {
    const noComponents = clone();
    delete entity(noComponents, "runtime/runtime-specification.json").hasPart;
    expect(codes(noComponents)).toContain(
      "RUNTIME_COMPONENT_BINDING_MISSING",
    );

    const brokenAggregate = clone();
    delete entity(brokenAggregate, "inputs/repository-tree.json").sha256;
    expect(codes(brokenAggregate)).toContain("AGGREGATE_MANIFEST_INVALID");

    const noCapture = clone();
    delete entity(noCapture, "./").creator;
    expect(codes(noCapture)).toContain("CAPTURE_PROVENANCE_MISSING");

    const nonAgentCapture = clone();
    entity(
      nonAgentCapture,
      "urn:uuid:44444444-4444-4444-8444-444444444444",
    )["@type"] = "CreativeWork";
    expect(codes(nonAgentCapture)).toContain("CAPTURE_PROVENANCE_MISSING");
  });

  it("requires every declared runtime component to be content-bound", () => {
    const document = clone();
    delete entity(document, "runtime/runner.mjs").sha256;

    expect(codes(document)).toContain("RUNTIME_COMPONENT_BINDING_MISSING");
  });

  it("validates timestamps, duration, and native trace relationships", () => {
    const timestamps = clone();
    entity(
      timestamps,
      "urn:uuid:22222222-2222-4222-8222-222222222222",
    ).endTime = "not-a-time";
    expect(codes(timestamps)).toContain("EXECUTION_STATUS_INVALID");

    const duration = clone();
    entity(duration, "#duration-ms").value = 1;
    expect(codes(duration)).toContain("EXECUTION_RELATION_INVALID");

    const trace = clone();
    entity(trace, "trace/trajectory.jsonl").about = {
      "@id": "urn:uuid:99999999-9999-4999-8999-999999999999",
    };
    expect(codes(trace)).toContain("EXECUTION_RELATION_INVALID");
  });

  it("detects duplicate core roles with distinct entity IDs", () => {
    const taskDocument = clone();
    const secondTask = structuredClone(entity(taskDocument, "task/task.md"));
    secondTask["@id"] = "task/second.md";
    taskDocument["@graph"].push(secondTask);
    entity(
      taskDocument,
      "urn:uuid:22222222-2222-4222-8222-222222222222",
    ).object.push({ "@id": secondTask["@id"] });
    expect(codes(taskDocument)).toContain("TASK_CARDINALITY");

    const executionDocument = clone();
    entity(executionDocument, "./").mentions = [
      {
        "@id": "urn:uuid:22222222-2222-4222-8222-222222222222",
      },
      {
        "@id": "urn:uuid:22222222-2222-4222-8222-222222222222",
      },
    ];
    expect(codes(executionDocument)).toContain("EXECUTION_CARDINALITY");
  });

  it("suppresses duplicate diagnostics for one malformed relationship", () => {
    const document = clone();
    entity(
      document,
      "urn:uuid:22222222-2222-4222-8222-222222222222",
    ).instrument = {
      "@id": "runtime/runtime-specification.json",
      nestedDefinition: true,
    };

    const diagnostics = validateExecutionEvidence(bytes(document)).diagnostics;
    expect(
      diagnostics.filter(
        ({ code, entityId }) =>
          code === "ROCRATE_REFERENCE_INVALID" &&
          entityId === "urn:uuid:22222222-2222-4222-8222-222222222222",
      ),
    ).toHaveLength(1);
  });

  it("reports stable machine-detectable failures for the Autopilot candidate", () => {
    const report = validateExecutionEvidence(candidateBytes);

    expect(report.conforms).toBe(false);
    expect(
      report.diagnostics.map(({ code, path, entityId }) => ({
        code,
        path,
        ...(entityId ? { entityId } : {}),
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "code": "PROFILE_CONTEXTUAL_ENTITY_MISSING",
          "path": "/@graph",
        },
        {
          "code": "ROCRATE_METADATA_DESCRIPTOR_CARDINALITY",
          "path": "/@graph",
        },
        {
          "code": "PROFILE_DECLARATION_MISSING",
          "entityId": "./",
          "path": "/@graph/0/conformsTo",
        },
        {
          "code": "RUNTIME_COMPONENT_BINDING_MISSING",
          "entityId": "artifacts/executor.observed.json",
          "path": "/@graph/2/instrument",
        },
        {
          "code": "DERIVATIVE_ROLE_SUBSTITUTION",
          "entityId": "artifacts/task.public.md",
          "path": "/@graph/2/object",
        },
        {
          "code": "TRACE_CARDINALITY",
          "entityId": "urn:uuid:1b110a92-0095-4cd5-b230-847c7f0d6ba2",
          "path": "/@graph/2/subjectOf",
        },
      ]
    `);
  });

  it("requires the exact declared profile", () => {
    const document = clone();
    entity(document, "./").conformsTo = {
      "@id": `${EXECUTION_EVIDENCE_PROFILE_URI}/other`,
    };
    expect(codes(document)).toContain("PROFILE_DECLARATION_MISSING");
  });
});
