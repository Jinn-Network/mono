// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";

import {
  ABANDONED_ACTION_STATUS,
  type ExecutionEvidenceDocument,
  validateExecutionEvidence,
} from "@jinn-network/evidence-protocol";
import type {
  DeclaredRelationshipOccurrence,
  EvidenceRecordReference,
  ExecutionEvidenceProjection,
} from "../catalog/index.js";
import { describe, expect, it } from "vitest";

import { projectExecutionEvidence } from "./project-execution.js";
import { compareCodeUnits } from "./graph.js";
import { EVIDENCE_PROJECTOR_VERSION } from "./projection-terms.js";

const fixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

const PRIVATE_DIGEST =
  "sha256:7c55e8e528cf5760508093141a3d859218bca33a436347a7f719667ed2ad46bf";
const PUBLIC_DIGEST =
  "sha256:d31b6017ef4e4a23d61d510a51a13c6fff39ca344e87436cdc4c3360b69de8ed";
const EXECUTION_ID = "urn:uuid:22222222-2222-4222-8222-222222222222";

const expectedPrivateRelationships = [
  ["#capture", "agent", "urn:uuid:44444444-4444-4444-8444-444444444444"],
  ["./", "conformsTo", "https://spec.jinn.network/profiles/execution-evidence/v1"],
  ["./", "creator", "urn:uuid:44444444-4444-4444-8444-444444444444"],
  ["./", "hasPart", "evidence/in-run-tests.json"],
  ["./", "hasPart", "external/marketplace-reference.json"],
  ["./", "hasPart", "inputs/knowledge.md"],
  ["./", "hasPart", "inputs/repository-tree.json"],
  ["./", "hasPart", "inputs/repository/src/slug.ts"],
  ["./", "hasPart", "inputs/repository/test/slug.test.ts"],
  ["./", "hasPart", "results/slug-normalization.patch"],
  ["./", "hasPart", "runtime/hosted-model.json"],
  ["./", "hasPart", "runtime/runner.mjs"],
  ["./", "hasPart", "runtime/runtime-lock.json"],
  ["./", "hasPart", "runtime/runtime-specification.json"],
  ["./", "hasPart", "runtime/system-prompt.md"],
  ["./", "hasPart", "runtime/tool-policy.json"],
  ["./", "hasPart", "runtime/workflow.json"],
  ["./", "hasPart", "task/task.md"],
  ["./", "hasPart", "trace/trace.jsonl"],
  ["./", "license", "https://creativecommons.org/publicdomain/zero/1.0/"],
  ["./", "mentions", EXECUTION_ID],
  ["./", "prov:wasGeneratedBy", "#capture"],
  ["evidence/in-run-tests.json", "about", EXECUTION_ID],
  ["evidence/in-run-tests.json", "prov:wasGeneratedBy", EXECUTION_ID],
  ["external/marketplace-reference.json", "about", "task/task.md"],
  ["external/marketplace-reference.json", "about", EXECUTION_ID],
  [
    "inputs/repository-tree.json",
    "hasPart",
    "inputs/repository/src/slug.ts",
  ],
  [
    "inputs/repository-tree.json",
    "hasPart",
    "inputs/repository/test/slug.test.ts",
  ],
  ["results/slug-normalization.patch", "prov:wasGeneratedBy", EXECUTION_ID],
  ["ro-crate-metadata.json", "about", "./"],
  [
    "ro-crate-metadata.json",
    "conformsTo",
    "https://w3id.org/ro/crate/1.3",
  ],
  [
    "runtime/hosted-model.json",
    "about",
    "urn:uuid:77777777-7777-4777-8777-777777777777",
  ],
  [
    "urn:uuid:77777777-7777-4777-8777-777777777777",
    "provider",
    "https://www.anthropic.com/",
  ],
  [
    "runtime/runtime-specification.json",
    "hasPart",
    "runtime/hosted-model.json",
  ],
  [
    "runtime/runtime-specification.json",
    "hasPart",
    "runtime/runner.mjs",
  ],
  [
    "runtime/runtime-specification.json",
    "hasPart",
    "runtime/runtime-lock.json",
  ],
  [
    "runtime/runtime-specification.json",
    "hasPart",
    "runtime/system-prompt.md",
  ],
  [
    "runtime/runtime-specification.json",
    "hasPart",
    "runtime/tool-policy.json",
  ],
  [
    "runtime/runtime-specification.json",
    "hasPart",
    "runtime/workflow.json",
  ],
  [
    "runtime/runtime-specification.json",
    "softwareRequirements",
    "runtime/runtime-lock.json",
  ],
  [
    "runtime/runtime-specification.json",
    "softwareRequirements",
    "urn:uuid:77777777-7777-4777-8777-777777777777",
  ],
  ["trace/trace.jsonl", "about", EXECUTION_ID],
  [
    "trace/trace.jsonl",
    "conformsTo",
    "https://spec.jinn.network/formats/fixture-trace/v1",
  ],
  [
    EXECUTION_ID,
    "agent",
    "urn:uuid:33333333-3333-4333-8333-333333333333",
  ],
  [EXECUTION_ID, "environment", "runtime/runtime-lock.json"],
  [EXECUTION_ID, "instrument", "runtime/runtime-specification.json"],
  [EXECUTION_ID, "object", "inputs/knowledge.md"],
  [EXECUTION_ID, "object", "inputs/repository-tree.json"],
  [EXECUTION_ID, "object", "task/task.md"],
  [EXECUTION_ID, "resourceUsage", "#duration-ms"],
  [EXECUTION_ID, "resourceUsage", "#input-tokens"],
  [EXECUTION_ID, "resourceUsage", "#output-tokens"],
  [EXECUTION_ID, "result", "results/slug-normalization.patch"],
  [EXECUTION_ID, "subjectOf", "trace/trace.jsonl"],
] as const;

const expectedPrivateEntities = [
  {
    entityId: "#capture",
    types: ["prov:Activity"],
    name: "Direct evidence capture and sealing",
  },
  { entityId: "#duration-ms", types: ["PropertyValue"], name: "durationMs" },
  {
    entityId: "#input-tokens",
    types: ["PropertyValue"],
    name: "inputTokens",
  },
  {
    entityId: "#output-tokens",
    types: ["PropertyValue"],
    name: "outputTokens",
  },
  {
    entityId: "./",
    types: ["Dataset"],
    name: "Golden synthetic Execution Evidence v1 record",
  },
  {
    entityId: "evidence/in-run-tests.json",
    types: ["File"],
    name: "In-run test observation",
  },
  {
    entityId: "external/marketplace-reference.json",
    types: ["CreativeWork", "File"],
    name: "External marketplace lifecycle references",
  },
  {
    entityId: "https://creativecommons.org/publicdomain/zero/1.0/",
    types: ["CreativeWork"],
    name: "CC0 1.0 Universal",
  },
  {
    entityId: "https://spec.jinn.network/formats/fixture-trace/v1",
    types: ["CreativeWork", "Profile"],
    name: "Synthetic fixture trace format 1.0",
  },
  {
    entityId: "https://spec.jinn.network/profiles/execution-evidence/v1",
    types: ["CreativeWork", "Profile"],
    name: "Jinn Execution Evidence Profile 1.0",
  },
  {
    entityId: "inputs/knowledge.md",
    types: ["CreativeWork", "File"],
    name: "Repository guidance supplied to the executor",
  },
  {
    entityId: "inputs/repository-tree.json",
    types: ["Dataset", "File"],
    name: "Exact repository snapshot consumed by the execution",
  },
  {
    entityId: "inputs/repository/src/slug.ts",
    types: ["File"],
    name: "Base slug implementation",
  },
  {
    entityId: "inputs/repository/test/slug.test.ts",
    types: ["File"],
    name: "Base slug tests",
  },
  {
    entityId: "results/slug-normalization.patch",
    types: ["File"],
    name: "Slug normalization implementation patch",
  },
  { entityId: "ro-crate-metadata.json", types: ["CreativeWork"] },
  {
    entityId: "runtime/hosted-model.json",
    types: ["CreativeWork", "File"],
    name: "Opaque hosted-model invocation descriptor",
  },
  {
    entityId: "runtime/runner.mjs",
    types: ["File", "SoftwareSourceCode"],
    name: "Executor entrypoint source",
  },
  {
    entityId: "runtime/runtime-lock.json",
    types: ["File"],
    name: "Observed runtime lock",
  },
  {
    entityId: "runtime/runtime-specification.json",
    types: ["File", "SoftwareApplication"],
    name: "Synthetic Autopilot coding runtime",
  },
  {
    entityId: "runtime/system-prompt.md",
    types: ["CreativeWork", "File"],
    name: "Effective system prompt",
  },
  {
    entityId: "runtime/tool-policy.json",
    types: ["File"],
    name: "Effective tool policy",
  },
  {
    entityId: "runtime/workflow.json",
    types: ["File"],
    name: "Effective workflow",
  },
  {
    entityId: "task/task.md",
    types: ["CreativeWork", "File", "prov:Plan"],
    name: "Implement deterministic slug normalization",
  },
  {
    entityId: "trace/trace.jsonl",
    types: ["File"],
    name: "Native synthetic execution trace",
  },
  {
    entityId: EXECUTION_ID,
    types: ["CreateAction", "prov:Activity"],
    name: "Synthetic slug-normalization execution",
  },
  {
    entityId: "urn:uuid:33333333-3333-4333-8333-333333333333",
    types: ["SoftwareApplication", "prov:Agent"],
    name: "Synthetic Autopilot operator agent",
  },
  {
    entityId: "urn:uuid:44444444-4444-4444-8444-444444444444",
    types: ["SoftwareApplication", "prov:Agent"],
    name: "Synthetic direct-capture producer",
  },
  {
    entityId: "urn:uuid:77777777-7777-4777-8777-777777777777",
    types: ["SoftwareApplication"],
    name: "Synthetic opaque hosted Claude deployment",
  },
] as const;

const publicOnlyEntityIds = [
  "#disposition-absolute-path-redact",
  "#disposition-credential-redact",
  "#disposition-reject",
  "#public-scrub",
  "private/ro-crate-metadata.json",
  "scrub/public-execution-policy.json",
  "scrub/scrub-receipt.json",
  "trace/trace.public.jsonl",
  "urn:uuid:88888888-8888-4888-8888-888888888888",
] as const;

const publicOnlyRelationships = [
  [
    "#public-scrub",
    "agent",
    "urn:uuid:88888888-8888-4888-8888-888888888888",
  ],
  [
    "#public-scrub",
    "instrument",
    "scrub/public-execution-policy.json",
  ],
  [
    "#public-scrub",
    "jinn:dispositionCount",
    "#disposition-absolute-path-redact",
  ],
  [
    "#public-scrub",
    "jinn:dispositionCount",
    "#disposition-credential-redact",
  ],
  ["#public-scrub", "jinn:dispositionCount", "#disposition-reject"],
  [
    "./",
    "creator",
    "urn:uuid:88888888-8888-4888-8888-888888888888",
  ],
  ["./", "hasPart", "private/ro-crate-metadata.json"],
  ["./", "hasPart", "scrub/public-execution-policy.json"],
  ["./", "hasPart", "scrub/scrub-receipt.json"],
  ["./", "hasPart", "trace/trace.public.jsonl"],
  ["./", "prov:wasDerivedFrom", "private/ro-crate-metadata.json"],
  ["./", "prov:wasGeneratedBy", "#public-scrub"],
  ["scrub/scrub-receipt.json", "prov:wasGeneratedBy", "#public-scrub"],
  ["trace/trace.public.jsonl", "about", EXECUTION_ID],
  [
    "trace/trace.public.jsonl",
    "conformsTo",
    "https://spec.jinn.network/formats/fixture-trace/v1",
  ],
  [
    "trace/trace.public.jsonl",
    "prov:wasDerivedFrom",
    "trace/trace.jsonl",
  ],
  [
    "trace/trace.public.jsonl",
    "prov:wasGeneratedBy",
    "#public-scrub",
  ],
] as const;

async function loadValidated(
  relativePath: string,
): Promise<{
  bytes: Uint8Array;
  document: ExecutionEvidenceDocument;
  recordDigest: string;
}> {
  const bytes = await readFile(new URL(relativePath, fixtureRoot));
  const report = validateExecutionEvidence(bytes);
  expect(report.conforms).toBe(true);
  expect(report.value).toBeDefined();
  return {
    bytes,
    document: report.value!,
    recordDigest: report.recordDigest,
  };
}

function reference(digest: string): EvidenceRecordReference & {
  readonly family: "execution-evidence";
} {
  return {
    family: "execution-evidence",
    digest: digest as EvidenceRecordReference["digest"],
  };
}

function relationshipTuples(
  relationships: readonly DeclaredRelationshipOccurrence[],
): readonly (readonly [string, string, string])[] {
  return relationships.map(
    ({ sourceEntityId, predicate, targetEntityId }) =>
      [sourceEntityId, predicate, targetEntityId] as const,
  );
}

function mutableDocument(
  document: ExecutionEvidenceDocument,
): ExecutionEvidenceDocument {
  return structuredClone(document);
}

function findExecution(document: ExecutionEvidenceDocument) {
  const execution = document["@graph"].find(
    (entity) => entity["@id"] === EXECUTION_ID,
  );
  if (!execution) throw new Error("Fixture Execution is missing.");
  return execution;
}

describe("projectExecutionEvidence", () => {
  it("exports the frozen projector version", () => {
    expect(EVIDENCE_PROJECTOR_VERSION).toBe("1.0.0");
  });

  it("projects the private golden record exactly", async () => {
    const { bytes, document, recordDigest } = await loadValidated(
      "execution/ro-crate-metadata.json",
    );
    expect(recordDigest).toBe(PRIVATE_DIGEST);
    const projection = projectExecutionEvidence(
      reference(PRIVATE_DIGEST),
      bytes.byteLength,
      document,
    );

    expect(projection).toMatchObject({
      reference: reference(PRIVATE_DIGEST),
      byteSize: 12232,
      family: "execution-evidence",
      executionId: EXECUTION_ID,
      task: {
        entityId: "task/task.md",
        digest:
          "sha256:1f42fd35cecf09d1bdf953fe4c7a1c8d25fd0bcf415a6b39aa7b61f1e982ef93",
        name: "Implement deterministic slug normalization",
        mediaType: "text/markdown",
      },
      executorId: "urn:uuid:33333333-3333-4333-8333-333333333333",
      identifiers: [
        {
          entityId: "urn:uuid:33333333-3333-4333-8333-333333333333",
          scheme: "https://marketplace.example.invalid/schemes/agent-id",
          value: "operator-agent-3",
        },
        {
          entityId: EXECUTION_ID,
          scheme: "https://marketplace.example.invalid/schemes/attempt-id",
          value: "attempt-42",
        },
        {
          entityId: "task/task.md",
          scheme: "https://marketplace.example.invalid/schemes/task-id",
          value: "slug-normalization-17",
        },
      ],
      runtime: {
        entityId: "runtime/runtime-specification.json",
        digest:
          "sha256:b1563a6db13e9214ca716653fc9862fa7fffc4e03c6a3b7ffde11b6922ba981a",
        name: "Synthetic Autopilot coding runtime",
        mediaType: "application/json",
      },
      results: [
        {
          entityId: "results/slug-normalization.patch",
          digest:
            "sha256:c43b406505b8c53ff9bf0a1c57442080d99a14b9f278739cb426313cf3238b07",
          name: "Slug normalization implementation patch",
          mediaType: "text/x-diff",
        },
      ],
      nativeTrace: {
        entityId: "trace/trace.jsonl",
        digest:
          "sha256:49db69574d82af9133e1b37ab2c1b28e32067642f9fb92d45b58a789d958ff2a",
        name: "Native synthetic execution trace",
        mediaType: "application/x-ndjson",
      },
      outcome: "completed",
      startedAt: "2026-07-23T15:00:00Z",
      endedAt: "2026-07-23T15:02:07Z",
      publishedAt: "2026-07-23T15:02:08Z",
    });
    expect(projection.declaredEntities).toEqual(
      [...expectedPrivateEntities].sort((left, right) =>
        compareCodeUnits(left.entityId, right.entityId),
      ),
    );
    expect(relationshipTuples(projection.declaredRelationships)).toEqual(
      [...expectedPrivateRelationships].sort(
        (left, right) =>
          compareCodeUnits(left[0], right[0]) ||
          compareCodeUnits(left[1], right[1]) ||
          compareCodeUnits(left[2], right[2]),
      ),
    );
  });

  it("projects graph input order deterministically", async () => {
    const { bytes, document } = await loadValidated(
      "execution/ro-crate-metadata.json",
    );
    const reordered = mutableDocument(document);
    reordered["@graph"].reverse();

    expect(
      projectExecutionEvidence(
        reference(PRIVATE_DIGEST),
        bytes.byteLength,
        reordered,
      ),
    ).toEqual(
      projectExecutionEvidence(
        reference(PRIVATE_DIGEST),
        bytes.byteLength,
        document,
      ),
    );
  });

  it("projects referenced PropertyValue identifiers as well as inline identifiers", async () => {
    const { bytes, document } = await loadValidated(
      "execution/ro-crate-metadata.json",
    );
    const referenced = mutableDocument(document);
    const task = referenced["@graph"].find(({ "@id": id }) => id === "task/task.md");
    if (task === undefined || typeof task.identifier !== "object" ||
      task.identifier === null || Array.isArray(task.identifier)) {
      throw new Error("Fixture Task identifier is missing.");
    }
    const identifier = structuredClone(task.identifier);
    Object.assign(identifier, { "@id": "#task-identifier" });
    referenced["@graph"].push(identifier as ExecutionEvidenceDocument["@graph"][number]);
    task.identifier = { "@id": "#task-identifier" };

    const report = validateExecutionEvidence(
      new TextEncoder().encode(JSON.stringify(referenced)),
    );
    expect(report.conforms).toBe(true);
    expect(
      projectExecutionEvidence(
        reference(PRIVATE_DIGEST),
        bytes.byteLength,
        report.value!,
      ).identifiers,
    ).toContainEqual({
      entityId: "task/task.md",
      scheme: "https://marketplace.example.invalid/schemes/task-id",
      value: "slug-normalization-17",
    });
  });

  it("rejects Protocol-conforming timestamps outside the Catalog contract", async () => {
    const { bytes, document } = await loadValidated(
      "execution/ro-crate-metadata.json",
    );
    const malformed = mutableDocument(document);
    const root = malformed["@graph"].find(({ "@id": id }) => id === "./");
    if (root === undefined) throw new Error("Fixture root is missing.");
    root.datePublished = "not-a-timestamp";
    const report = validateExecutionEvidence(
      new TextEncoder().encode(JSON.stringify(malformed)),
    );
    expect(report.conforms).toBe(true);
    expect(() =>
      projectExecutionEvidence(
        reference(PRIVATE_DIGEST),
        bytes.byteLength,
        report.value!,
      ),
    ).toThrowError(expect.objectContaining({
      code: "VALIDATED_RECORD_INCONSISTENT",
    }));
  });

  it("does not share mutable values with the validated document", async () => {
    const { bytes, document } = await loadValidated(
      "execution/ro-crate-metadata.json",
    );
    const before = structuredClone(document);
    const projection = projectExecutionEvidence(
      reference(PRIVATE_DIGEST),
      bytes.byteLength,
      document,
    ) as ExecutionEvidenceProjection & {
      declaredEntities: Array<{ types: string[] }>;
      results: Array<{ entityId: string }>;
    };

    projection.declaredEntities[0]!.types.push("ExtensionType");
    projection.results[0]!.entityId = "changed-result";

    expect(document).toEqual(before);
  });

  it("does not promote extension-only entities or relationships", async () => {
    const { bytes, document } = await loadValidated(
      "execution/ro-crate-metadata.json",
    );
    const extended = mutableDocument(document);
    extended["@graph"].push({
      "@id": "#extension-only",
      "@type": "Thing",
      name: "Not a Catalog field",
    });
    Object.assign(findExecution(extended), {
      "https://example.invalid/related": { "@id": "#extension-only" },
    });
    const report = validateExecutionEvidence(
      new TextEncoder().encode(JSON.stringify(extended)),
    );
    expect(report.conforms).toBe(true);

    const projection = projectExecutionEvidence(
      reference(PRIVATE_DIGEST),
      bytes.byteLength,
      report.value!,
    );
    expect(
      projection.declaredEntities.some(
        (entity) => entity.entityId === "#extension-only",
      ),
    ).toBe(false);
    expect(
      projection.declaredRelationships.some(
        (relationship) => relationship.targetEntityId === "#extension-only",
      ),
    ).toBe(false);
  });

  it("keeps private and public derivatives record-scoped", async () => {
    const privateFixture = await loadValidated(
      "execution/ro-crate-metadata.json",
    );
    const publicFixture = await loadValidated("public/ro-crate-metadata.json");
    expect(privateFixture.recordDigest).toBe(PRIVATE_DIGEST);
    expect(publicFixture.recordDigest).toBe(PUBLIC_DIGEST);
    const privateProjection = projectExecutionEvidence(
      reference(PRIVATE_DIGEST),
      privateFixture.bytes.byteLength,
      privateFixture.document,
    );
    const publicProjection = projectExecutionEvidence(
      reference(PUBLIC_DIGEST),
      publicFixture.bytes.byteLength,
      publicFixture.document,
    );

    expect(publicProjection).toMatchObject({
      reference: reference(PUBLIC_DIGEST),
      byteSize: 15777,
      family: "execution-evidence",
      executionId: EXECUTION_ID,
      task: {
        entityId: "task/task.md",
        digest:
          "sha256:1f42fd35cecf09d1bdf953fe4c7a1c8d25fd0bcf415a6b39aa7b61f1e982ef93",
        name: "Implement deterministic slug normalization",
        mediaType: "text/markdown",
      },
      executorId: "urn:uuid:33333333-3333-4333-8333-333333333333",
      runtime: {
        entityId: "runtime/runtime-specification.json",
        digest:
          "sha256:b1563a6db13e9214ca716653fc9862fa7fffc4e03c6a3b7ffde11b6922ba981a",
        name: "Synthetic Autopilot coding runtime",
        mediaType: "application/json",
      },
      results: [
        {
          entityId: "results/slug-normalization.patch",
          digest:
            "sha256:c43b406505b8c53ff9bf0a1c57442080d99a14b9f278739cb426313cf3238b07",
          name: "Slug normalization implementation patch",
          mediaType: "text/x-diff",
        },
      ],
      nativeTrace: {
        entityId: "trace/trace.jsonl",
        digest:
          "sha256:49db69574d82af9133e1b37ab2c1b28e32067642f9fb92d45b58a789d958ff2a",
        name: "Native synthetic execution trace",
        mediaType: "application/x-ndjson",
      },
      outcome: "completed",
      startedAt: "2026-07-23T15:00:00Z",
      endedAt: "2026-07-23T15:02:07Z",
      publishedAt: "2026-07-23T16:10:00Z",
    });
    expect(publicProjection.executionId).toBe(privateProjection.executionId);
    expect(publicProjection.reference).not.toEqual(privateProjection.reference);
    expect(publicProjection.declaredEntities.map(({ entityId }) => entityId)).toEqual(
      [...expectedPrivateEntities.map(({ entityId }) => entityId), ...publicOnlyEntityIds]
        .sort(compareCodeUnits),
    );
    expect(
      relationshipTuples(publicProjection.declaredRelationships),
    ).toEqual(
      [
        ...expectedPrivateRelationships.filter(
          ([source, predicate]) =>
            !(
              source === "./" &&
              (predicate === "creator" ||
                predicate === "prov:wasGeneratedBy")
            ),
        ),
        ...publicOnlyRelationships,
      ].sort(
        (left, right) =>
          compareCodeUnits(left[0], right[0]) ||
          compareCodeUnits(left[1], right[1]) ||
          compareCodeUnits(left[2], right[2]),
      ),
    );
    expect(
      publicProjection.declaredEntities.filter(({ entityId }) =>
        publicOnlyEntityIds.includes(
          entityId as (typeof publicOnlyEntityIds)[number],
        ),
      ),
    ).toEqual([
      {
        entityId: "#disposition-absolute-path-redact",
        types: ["PropertyValue"],
        name: "absolute-path:redact",
      },
      {
        entityId: "#disposition-credential-redact",
        types: ["PropertyValue"],
        name: "credential:redact",
      },
      {
        entityId: "#disposition-reject",
        types: ["PropertyValue"],
        name: "reject",
      },
      {
        entityId: "#public-scrub",
        types: ["prov:Activity"],
        name: "Structure-aware public derivation",
      },
      {
        entityId: "private/ro-crate-metadata.json",
        types: ["CreativeWork", "File"],
        name: "Unavailable exact private Execution Evidence metadata commitment",
      },
      {
        entityId: "scrub/public-execution-policy.json",
        types: ["CreativeWork", "File"],
        name: "Structure-aware public execution policy",
      },
      {
        entityId: "scrub/scrub-receipt.json",
        types: ["CreativeWork", "File"],
        name: "Public derivation scrub receipt",
      },
      {
        entityId: "trace/trace.public.jsonl",
        types: ["File"],
        name: "Structure-aware scrubbed trace projection",
      },
      {
        entityId: "urn:uuid:88888888-8888-4888-8888-888888888888",
        types: ["SoftwareApplication", "prov:Agent"],
        name: "Synthetic structure-aware scrubber",
      },
    ]);
  });

  it.each([
    ["https://schema.org/CompletedActionStatus", "completed"],
    ["https://schema.org/FailedActionStatus", "failed"],
    [ABANDONED_ACTION_STATUS, "abandoned"],
    ["jinn:AbandonedActionStatus", "abandoned"],
  ] as const)("maps %s to %s", async (status, outcome) => {
    const { document } = await loadValidated(
      "execution/ro-crate-metadata.json",
    );
    const variant = mutableDocument(document);
    Object.assign(findExecution(variant), { actionStatus: { "@id": status } });
    const bytes = new TextEncoder().encode(JSON.stringify(variant));
    const report = validateExecutionEvidence(bytes);
    expect(report.conforms).toBe(true);

    expect(
      projectExecutionEvidence(
        reference(report.recordDigest),
        bytes.byteLength,
        report.value!,
      ).outcome,
    ).toBe(outcome);
  });
});
