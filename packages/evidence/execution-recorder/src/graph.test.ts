// SPDX-License-Identifier: Apache-2.0

import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import { ExecutionRecorderError } from "./errors.js";
import {
  buildExecutionEvidence,
  type ExecutionEvidenceMapperInput,
} from "./graph.js";
import type {
  PersistedAggregateArtifactCapture,
  PersistedArtifactSource,
  PersistedFileArtifactCapture,
} from "./journal-types.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const producerOrigin = {
  kind: "producer-observed" as const,
  observer: "urn:agent:producer" as const,
};

function source(
  hex: string,
  mediaType: string,
  name?: string,
): PersistedArtifactSource {
  return {
    digest: `sha256:${hex.repeat(64)}`,
    size: 4,
    mediaType,
    ...(name === undefined ? {} : { name }),
  };
}

function file(
  entityId: string,
  hex: string,
  mediaType: string,
  name?: string,
): PersistedFileArtifactCapture {
  return {
    kind: "file",
    entityId,
    source: source(hex, mediaType, name),
    origin: producerOrigin,
  };
}

function minimalInput(
  outcome: ExecutionEvidenceMapperInput["outcome"] = "completed",
): ExecutionEvidenceMapperInput {
  return {
    recording: {
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      startedAt: "2026-07-24T10:00:00Z",
      record: {
        name: "Recorder fixture",
        description: "A literal mapper fixture.",
        license: "https://example.test/license",
        executionName: "Fixture execution",
      },
      task: {
        entityId: "task/task.md",
        name: "Perform the fixture task",
        source: source("a", "text/markdown"),
        origin: producerOrigin,
      },
      initialInputs: [file("inputs/value.txt", "b", "text/plain")],
      executor: {
        entityId: "urn:agent:executor",
        kind: "software",
        name: "Fixture executor",
        softwareVersion: "2.0.0",
        origin: producerOrigin,
      },
      runtime: {
        entityId: "runtime/specification.json",
        specification: source("c", "application/json"),
        name: "Fixture runtime",
        softwareVersion: "1.0.0",
        origin: producerOrigin,
        components: [
          {
            kind: "controlled",
            artifact: file("runtime/runner.mjs", "d", "text/javascript"),
          },
        ],
      },
      producer: {
        entityId: "urn:agent:producer",
        kind: "software",
        name: "Fixture producer",
        softwareVersion: "1.2.3",
        origin: producerOrigin,
      },
    },
    additionalInputs: [],
    runtimeObservations: [],
    outcome,
    endedAt: "2026-07-24T10:00:01.250Z",
    finalizedAt: "2026-07-24T10:00:02Z",
    results:
      outcome === "completed"
        ? [file("results/result.txt", "e", "text/plain", "Fixture result")]
        : [],
    nativeTrace: {
      artifact: file(
        "trace/native.jsonl",
        "f",
        "application/x-ndjson",
        "Native trace",
      ),
      format: {
        entityId: "https://example.test/formats/native-trace/v1",
        name: "Fixture native trace format",
      },
    },
  };
}

function graph(bytes: Uint8Array): Record<string, unknown>[] {
  return JSON.parse(decode(bytes))["@graph"] as Record<string, unknown>[];
}

function entity(
  entities: readonly Record<string, unknown>[],
  id: string,
): Record<string, unknown> {
  const match = entities.find((candidate) => candidate["@id"] === id);
  expect(match, `missing graph entity ${id}`).toBeDefined();
  return match!;
}

describe("execution evidence graph", () => {
  test("maps a completed recording to the exact protocol roles", () => {
    const bytes = buildExecutionEvidence(minimalInput());
    const entities = graph(bytes);

    expect(validateExecutionEvidence(bytes)).toMatchObject({
      conforms: true,
      diagnostics: [],
    });
    expect(decode(bytes).endsWith("\n")).toBe(true);
    expect(entities.map((candidate) => candidate["@id"])).toEqual([
      "ro-crate-metadata.json",
      "./",
      "https://spec.jinn.network/profiles/execution-evidence/v1",
      "https://example.test/license",
      "task/task.md",
      "inputs/value.txt",
      "runtime/specification.json",
      "runtime/runner.mjs",
      "urn:uuid:11111111-1111-4111-8111-111111111111",
      "urn:agent:executor",
      "results/result.txt",
      "trace/native.jsonl",
      "https://example.test/formats/native-trace/v1",
      "urn:agent:producer",
      "#capture",
      "#duration-ms",
      "#attribution-1",
      "#attribution-2",
      "#attribution-3",
      "#attribution-4",
      "#attribution-5",
      "#attribution-6",
      "#attribution-7",
      "#attribution-8",
      "urn:jinn:execution-recorder:role:producer-observer",
    ]);
    expect(entity(entities, "./")).toEqual({
      "@id": "./",
      "@type": "Dataset",
      name: "Recorder fixture",
      description: "A literal mapper fixture.",
      dateCreated: "2026-07-24T10:00:02Z",
      datePublished: "2026-07-24T10:00:02Z",
      license: { "@id": "https://example.test/license" },
      conformsTo: {
        "@id": "https://spec.jinn.network/profiles/execution-evidence/v1",
      },
      creator: { "@id": "urn:agent:producer" },
      hasPart: [
        { "@id": "task/task.md" },
        { "@id": "inputs/value.txt" },
        { "@id": "runtime/specification.json" },
        { "@id": "runtime/runner.mjs" },
        { "@id": "results/result.txt" },
        { "@id": "trace/native.jsonl" },
      ],
      mentions: {
        "@id": "urn:uuid:11111111-1111-4111-8111-111111111111",
      },
      "prov:wasGeneratedBy": { "@id": "#capture" },
    });
    expect(entity(entities, "task/task.md")).toMatchObject({
      "@type": ["File", "CreativeWork", "prov:Plan"],
      name: "Perform the fixture task",
      encodingFormat: "text/markdown",
      contentSize: 4,
      sha256: "a".repeat(64),
    });
    expect(entity(entities, "runtime/specification.json")).toMatchObject({
      "@type": ["File", "SoftwareApplication"],
      name: "Fixture runtime",
      softwareVersion: "1.0.0",
      encodingFormat: "application/json",
      contentSize: 4,
      sha256: "c".repeat(64),
      hasPart: [{ "@id": "runtime/runner.mjs" }],
    });
    expect(
      entity(
        entities,
        "urn:uuid:11111111-1111-4111-8111-111111111111",
      ),
    ).toEqual({
      "@id": "urn:uuid:11111111-1111-4111-8111-111111111111",
      "@type": ["CreateAction", "prov:Activity"],
      name: "Fixture execution",
      instrument: { "@id": "runtime/specification.json" },
      object: [
        { "@id": "task/task.md" },
        { "@id": "inputs/value.txt" },
      ],
      result: { "@id": "results/result.txt" },
      startTime: "2026-07-24T10:00:00Z",
      endTime: "2026-07-24T10:00:01.250Z",
      actionStatus: {
        "@id": "https://schema.org/CompletedActionStatus",
      },
      agent: { "@id": "urn:agent:executor" },
      resourceUsage: { "@id": "#duration-ms" },
      subjectOf: { "@id": "trace/native.jsonl" },
    });
    expect(entity(entities, "results/result.txt")).toMatchObject({
      "@type": "File",
      name: "Fixture result",
      "prov:wasGeneratedBy": {
        "@id": "urn:uuid:11111111-1111-4111-8111-111111111111",
      },
    });
    expect(entity(entities, "trace/native.jsonl")).toMatchObject({
      "@type": "File",
      name: "Native trace",
      about: {
        "@id": "urn:uuid:11111111-1111-4111-8111-111111111111",
      },
      conformsTo: {
        "@id": "https://example.test/formats/native-trace/v1",
      },
    });
    expect(entity(entities, "#duration-ms")).toEqual({
      "@id": "#duration-ms",
      "@type": "PropertyValue",
      name: "durationMs",
      propertyID: "https://spec.jinn.network/terms/durationMs",
      value: 1250,
      unitCode: "ms",
    });
    expect(entity(entities, "#capture")).toEqual({
      "@id": "#capture",
      "@type": "prov:Activity",
      name: "Execution Recorder capture and sealing",
      endTime: "2026-07-24T10:00:02Z",
      agent: { "@id": "urn:agent:producer" },
    });
  });

  test.each([
    ["failed", "https://schema.org/FailedActionStatus"],
    [
      "abandoned",
      "https://spec.jinn.network/terms/AbandonedActionStatus",
    ],
  ] as const)("maps a resultless %s terminal state", (outcome, actionStatus) => {
    const bytes = buildExecutionEvidence(minimalInput(outcome));
    const entities = graph(bytes);
    const execution = entity(
      entities,
      "urn:uuid:11111111-1111-4111-8111-111111111111",
    );

    expect(execution.actionStatus).toEqual({ "@id": actionStatus });
    expect(execution).not.toHaveProperty("result");
    expect(validateExecutionEvidence(bytes)).toMatchObject({
      conforms: true,
      diagnostics: [],
    });
  });

  test("maps every capture origin through qualified PROV attribution roles", () => {
    const baseline = minimalInput();
    const bytes = buildExecutionEvidence({
      ...baseline,
      recording: {
        ...baseline.recording,
        initialInputs: [
          {
            ...baseline.recording.initialInputs[0]!,
            origin: {
              kind: "executor-reported",
              reporter: "urn:agent:executor",
              capturedBy: "urn:agent:producer",
            },
          },
        ],
        runtime: {
          ...baseline.recording.runtime,
          origin: {
            kind: "external-observed",
            observer: "urn:observer:runtime-api",
            capturedBy: "urn:agent:producer",
          },
        },
      },
    });
    const entities = graph(bytes);

    expect(
      entity(entities, "inputs/value.txt")["prov:qualifiedAttribution"],
    ).toEqual([
      { "@id": "#attribution-2" },
      { "@id": "#attribution-3" },
    ]);
    expect(entity(entities, "#attribution-2")).toEqual({
      "@id": "#attribution-2",
      "@type": "prov:Attribution",
      "prov:agent": { "@id": "urn:agent:executor" },
      "prov:hadRole": {
        "@id": "urn:jinn:execution-recorder:role:executor-reporter",
      },
    });
    expect(entity(entities, "#attribution-3")).toEqual({
      "@id": "#attribution-3",
      "@type": "prov:Attribution",
      "prov:agent": { "@id": "urn:agent:producer" },
      "prov:hadRole": {
        "@id": "urn:jinn:execution-recorder:role:capture-agent",
      },
    });
    expect(
      entity(
        entities,
        "runtime/specification.json",
      )["prov:qualifiedAttribution"],
    ).toEqual([
      { "@id": "#attribution-5" },
      { "@id": "#attribution-6" },
    ]);
    expect(entity(entities, "#attribution-5")).toMatchObject({
      "prov:agent": { "@id": "urn:observer:runtime-api" },
      "prov:hadRole": {
        "@id": "urn:jinn:execution-recorder:role:external-observer",
      },
    });
    expect(entity(entities, "#attribution-6")).toMatchObject({
      "prov:agent": { "@id": "urn:agent:producer" },
      "prov:hadRole": {
        "@id": "urn:jinn:execution-recorder:role:capture-agent",
      },
    });
    expect(
      entity(
        entities,
        "urn:jinn:execution-recorder:role:producer-observer",
      ),
    ).toEqual({
      "@id": "urn:jinn:execution-recorder:role:producer-observer",
      "@type": "prov:Role",
      name: "Producer observer",
    });
    expect(
      entity(
        entities,
        "urn:jinn:execution-recorder:role:executor-reporter",
      ),
    ).toEqual({
      "@id": "urn:jinn:execution-recorder:role:executor-reporter",
      "@type": "prov:Role",
      name: "Executor reporter",
    });
    expect(
      entity(
        entities,
        "urn:jinn:execution-recorder:role:external-observer",
      ),
    ).toEqual({
      "@id": "urn:jinn:execution-recorder:role:external-observer",
      "@type": "prov:Role",
      name: "External observer",
    });
    expect(decode(bytes)).not.toMatch(/trust|confidence|score/i);
  });

  test("maps aggregates and runtime observations and preserves extensions", () => {
    const baseline = minimalInput();
    const repository: PersistedAggregateArtifactCapture = {
      kind: "dataset",
      entityId: "inputs/repository.json",
      manifest: source("1", "application/json", "Repository manifest"),
      members: [
        file("inputs/repository/z.ts", "2", "text/typescript"),
        file("inputs/repository/a.ts", "3", "text/typescript"),
      ],
      origin: producerOrigin,
      additionalTypes: ["SoftwareSourceCode"],
    };
    const bytes = buildExecutionEvidence({
      ...baseline,
      recording: {
        ...baseline.recording,
        record: {
          ...baseline.recording.record,
          documentExtensions: { "x-document": { retained: true } },
          rootExtensions: { "x-root": "retained" },
          executionExtensions: { "x-execution": 42 },
          executionIdentifiers: [
            {
              propertyId: "https://example.test/attempt-id",
              value: "attempt-7",
            },
          ],
        },
        repositoryState: {
          artifact: repository,
          identifiers: [
            {
              propertyId: "https://example.test/git-commit",
              value: "abc123",
            },
          ],
          repository: "https://example.test/repository",
          extensions: { "x-repository-state": true },
        },
        runtime: {
          ...baseline.recording.runtime,
          components: [
            ...baseline.recording.runtime.components,
            {
              kind: "opaque",
              descriptor: file(
                "runtime/model-observation.json",
                "4",
                "application/json",
              ),
              component: {
                entityId: "urn:component:model",
                name: "Hosted model",
                softwareVersion: "model-2026-07",
                provider: "urn:organization:model-provider",
                extensions: { "x-model": "retained" },
              },
            },
          ],
        },
      },
      runtimeObservations: [
        {
          kind: "resource",
          entityId: "#output-tokens",
          name: "outputTokens",
          value: 17,
          propertyId: "https://example.test/outputTokens",
          unitCode: "count",
          origin: {
            kind: "executor-reported",
            reporter: "urn:agent:executor",
            capturedBy: "urn:agent:producer",
          },
          extensions: { "x-observation": true },
        },
        {
          kind: "environment",
          artifact: file(
            "runtime/environment.json",
            "5",
            "application/json",
          ),
        },
      ],
    });
    const document = JSON.parse(decode(bytes)) as Record<string, unknown>;
    const entities = document["@graph"] as Record<string, unknown>[];

    expect(document["x-document"]).toEqual({ retained: true });
    expect(entity(entities, "./")["x-root"]).toBe("retained");
    expect(
      entity(
        entities,
        "urn:uuid:11111111-1111-4111-8111-111111111111",
      ),
    ).toMatchObject({
      "x-execution": 42,
      environment: { "@id": "runtime/environment.json" },
      resourceUsage: [
        { "@id": "#duration-ms" },
        { "@id": "#output-tokens" },
      ],
      identifier: {
        "@type": "PropertyValue",
        propertyID: "https://example.test/attempt-id",
        value: "attempt-7",
      },
    });
    expect(entity(entities, "inputs/repository.json")).toMatchObject({
      "@type": ["File", "Dataset", "SoftwareSourceCode"],
      codeRepository: "https://example.test/repository",
      "x-repository-state": true,
      hasPart: [
        { "@id": "inputs/repository/a.ts" },
        { "@id": "inputs/repository/z.ts" },
      ],
      identifier: {
        "@type": "PropertyValue",
        propertyID: "https://example.test/git-commit",
        value: "abc123",
      },
    });
    expect(entity(entities, "runtime/specification.json")).toMatchObject({
      hasPart: [
        { "@id": "runtime/model-observation.json" },
        { "@id": "runtime/runner.mjs" },
      ],
      softwareRequirements: { "@id": "urn:component:model" },
    });
    expect(entity(entities, "runtime/model-observation.json")).toMatchObject({
      about: { "@id": "urn:component:model" },
    });
    expect(entity(entities, "urn:component:model")).toEqual({
      "@id": "urn:component:model",
      "@type": "SoftwareApplication",
      name: "Hosted model",
      softwareVersion: "model-2026-07",
      provider: { "@id": "urn:organization:model-provider" },
      "x-model": "retained",
    });
    expect(entity(entities, "#output-tokens")).toMatchObject({
      "@type": "PropertyValue",
      name: "outputTokens",
      value: 17,
      propertyID: "https://example.test/outputTokens",
      unitCode: "count",
      "x-observation": true,
    });
    expect(validateExecutionEvidence(bytes)).toMatchObject({
      conforms: true,
      diagnostics: [],
    });
  });

  test("merges compatible repository and artifact metadata without loss", () => {
    const baseline = minimalInput();
    const repository: PersistedAggregateArtifactCapture = {
      kind: "dataset",
      entityId: "inputs/repository.json",
      manifest: source("1", "application/json", "Repository manifest"),
      members: [],
      origin: producerOrigin,
      identifiers: [
        {
          propertyId: "https://example.test/shared-id",
          value: "same",
        },
        {
          propertyId: "https://example.test/content-id",
          value: "tree123",
        },
      ],
      extensions: {
        "x-artifact": { retained: true },
        "x-shared": ["same"],
      },
    };
    const bytes = buildExecutionEvidence({
      ...baseline,
      recording: {
        ...baseline.recording,
        repositoryState: {
          artifact: repository,
          identifiers: [
            {
              propertyId: "https://example.test/shared-id",
              value: "same",
            },
            {
              propertyId: "https://example.test/revision-id",
              value: "abc123",
            },
          ],
          repository: "https://example.test/repository",
          extensions: {
            "x-repository-state": true,
            "x-shared": ["same"],
          },
        },
      },
    });

    expect(entity(graph(bytes), repository.entityId)).toMatchObject({
      codeRepository: "https://example.test/repository",
      "x-artifact": { retained: true },
      "x-repository-state": true,
      "x-shared": ["same"],
      identifier: [
        {
          "@type": "PropertyValue",
          propertyID: "https://example.test/content-id",
          value: "tree123",
        },
        {
          "@type": "PropertyValue",
          propertyID: "https://example.test/revision-id",
          value: "abc123",
        },
        {
          "@type": "PropertyValue",
          propertyID: "https://example.test/shared-id",
          value: "same",
        },
      ],
    });
    expect(validateExecutionEvidence(bytes)).toMatchObject({
      conforms: true,
      diagnostics: [],
    });
  });

  test("rejects conflicting repository and artifact extensions", () => {
    const baseline = minimalInput();
    const repository = {
      kind: "dataset" as const,
      entityId: "inputs/repository.json",
      manifest: source("1", "application/json", "Repository manifest"),
      members: [],
      origin: producerOrigin,
      extensions: {
        "x-repository-metadata": { source: "artifact" },
      },
    };

    expect(() =>
      buildExecutionEvidence({
        ...baseline,
        recording: {
          ...baseline.recording,
          repositoryState: {
            artifact: repository,
            identifiers: [],
            extensions: {
              "x-repository-metadata": { source: "repository-state" },
            },
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ExecutionRecorderError>>({
        code: "RECORDING_CONFLICT",
        details: {
          entityId: repository.entityId,
        },
      }),
    );
  });

  test("merges extension keys that shadow Object prototype properties", () => {
    const baseline = minimalInput();
    const extensions = JSON.parse(
      '{"constructor":{"retained":true},"toString":"retained","__proto__":["retained"]}',
    ) as NonNullable<PersistedAggregateArtifactCapture["extensions"]>;
    const repository: PersistedAggregateArtifactCapture = {
      kind: "dataset",
      entityId: "inputs/repository.json",
      manifest: source("1", "application/json", "Repository manifest"),
      members: [],
      origin: producerOrigin,
    };
    const mapped = entity(
      graph(
        buildExecutionEvidence({
          ...baseline,
          recording: {
            ...baseline.recording,
            repositoryState: {
              artifact: repository,
              identifiers: [],
              extensions,
            },
          },
        }),
      ),
      repository.entityId,
    );

    expect(Object.hasOwn(mapped, "constructor")).toBe(true);
    expect(mapped["constructor"]).toEqual({ retained: true });
    expect(Object.hasOwn(mapped, "toString")).toBe(true);
    expect(mapped["toString"]).toBe("retained");
    expect(Object.hasOwn(mapped, "__proto__")).toBe(true);
    expect(mapped["__proto__"]).toEqual(["retained"]);
  });

  test("emits identical bytes when unordered captures are permuted", () => {
    const baseline = minimalInput();
    const left = file("inputs/a.txt", "1", "text/plain");
    const right = file("inputs/z.txt", "2", "text/plain");
    const first = {
      ...baseline,
      additionalInputs: [right, left],
      runtimeObservations: [
        {
          kind: "resource" as const,
          entityId: "#z-observation",
          name: "z",
          value: 2,
          origin: producerOrigin,
        },
        {
          kind: "resource" as const,
          entityId: "#a-observation",
          name: "a",
          value: 1,
          origin: producerOrigin,
        },
      ],
    };
    const second = {
      ...first,
      additionalInputs: [left, right],
      runtimeObservations: [...first.runtimeObservations].reverse(),
    };

    expect(buildExecutionEvidence(first)).toEqual(
      buildExecutionEvidence(second),
    );
  });

  test("preserves direct membership for nested aggregates", () => {
    const baseline = minimalInput();
    const nested: PersistedAggregateArtifactCapture = {
      kind: "dataset",
      entityId: "inputs/outer.json",
      manifest: source("1", "application/json"),
      origin: producerOrigin,
      members: [
        {
          kind: "collection",
          entityId: "inputs/inner.json",
          manifest: source("2", "application/json"),
          origin: producerOrigin,
          members: [file("inputs/leaf.txt", "3", "text/plain")],
        },
      ],
    };
    const entities = graph(
      buildExecutionEvidence({
        ...baseline,
        additionalInputs: [nested],
      }),
    );

    expect(entity(entities, "inputs/outer.json").hasPart).toEqual([
      { "@id": "inputs/inner.json" },
    ]);
    expect(entity(entities, "inputs/inner.json").hasPart).toEqual([
      { "@id": "inputs/leaf.txt" },
    ]);
    expect(entity(entities, "./").hasPart).toEqual([
      { "@id": "task/task.md" },
      { "@id": "inputs/outer.json" },
      { "@id": "inputs/inner.json" },
      { "@id": "inputs/leaf.txt" },
      { "@id": "inputs/value.txt" },
      { "@id": "runtime/specification.json" },
      { "@id": "runtime/runner.mjs" },
      { "@id": "results/result.txt" },
      { "@id": "trace/native.jsonl" },
    ]);
  });

  test("rejects exact bytes that fail reference-validator conformance", () => {
    expect(() =>
      buildExecutionEvidence({
        ...minimalInput(),
        results: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ExecutionRecorderError>>({
        code: "PROTOCOL_CONFORMANCE_FAILED",
        details: expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "EXECUTION_COMPLETED_RESULT_MISSING",
            }),
          ]),
        }),
      }),
    );
  });

  test("rejects incompatible declarations that reuse one graph entity ID", () => {
    const baseline = minimalInput();

    expect(() =>
      buildExecutionEvidence({
        ...baseline,
        recording: {
          ...baseline.recording,
          producer: {
            ...baseline.recording.producer,
            entityId: baseline.recording.executor.entityId,
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ExecutionRecorderError>>({
        code: "RECORDING_CONFLICT",
        details: {
          entityId: baseline.recording.executor.entityId,
        },
      }),
    );

    expect(() =>
      buildExecutionEvidence({
        ...baseline,
        results: [
          {
            ...baseline.results[0]!,
            entityId: baseline.recording.initialInputs[0]!.entityId,
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ExecutionRecorderError>>({
        code: "RECORDING_CONFLICT",
        details: {
          entityId: baseline.recording.initialInputs[0]!.entityId,
        },
      }),
    );

    expect(() =>
      buildExecutionEvidence({
        ...baseline,
        recording: {
          ...baseline.recording,
          runtime: {
            ...baseline.recording.runtime,
            components: [
              {
                kind: "opaque",
                descriptor: file(
                  "runtime/provider.json",
                  "9",
                  "application/json",
                ),
                component: {
                  entityId: "urn:component:hosted",
                  name: "Hosted component",
                  provider:
                    baseline.recording.initialInputs[0]!.entityId as `urn:${string}`,
                },
              },
            ],
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ExecutionRecorderError>>({
        code: "RECORDING_CONFLICT",
        details: {
          entityId: baseline.recording.initialInputs[0]!.entityId,
        },
      }),
    );
  });

  test("rejects an identical artifact reused across capture roles", () => {
    const cases: readonly {
      readonly role: string;
      readonly reuse: (
        baseline: ExecutionEvidenceMapperInput,
      ) => ExecutionEvidenceMapperInput;
    }[] = [
      {
        role: "result",
        reuse: (baseline) => ({
          ...baseline,
          results: [baseline.recording.initialInputs[0]!],
        }),
      },
      {
        role: "runtime",
        reuse: (baseline) => ({
          ...baseline,
          recording: {
            ...baseline.recording,
            runtime: {
              ...baseline.recording.runtime,
              components: [
                {
                  kind: "controlled",
                  artifact: baseline.recording.initialInputs[0]!,
                },
              ],
            },
          },
        }),
      },
      {
        role: "environment",
        reuse: (baseline) => ({
          ...baseline,
          runtimeObservations: [
            {
              kind: "environment",
              artifact: baseline.recording.initialInputs[0]!,
            },
          ],
        }),
      },
      {
        role: "native trace",
        reuse: (baseline) => ({
          ...baseline,
          nativeTrace: {
            ...baseline.nativeTrace,
            artifact: baseline.recording.initialInputs[0]!,
          },
        }),
      },
    ];

    for (const { role, reuse } of cases) {
      const baseline = minimalInput();
      expect(
        () => buildExecutionEvidence(reuse(baseline)),
        role,
      ).toThrowError(
        expect.objectContaining<Partial<ExecutionRecorderError>>({
          code: "RECORDING_CONFLICT",
          details: {
            entityId: baseline.recording.initialInputs[0]!.entityId,
          },
        }),
      );
    }
  });

  test("emits identical bytes when an artifact repeats in one capture role", () => {
    const baseline = minimalInput();

    expect(
      buildExecutionEvidence({
        ...baseline,
        additionalInputs: [baseline.recording.initialInputs[0]!],
      }),
    ).toEqual(buildExecutionEvidence(baseline));
  });

  test("deduplicates repeated relationship IDs within one capture role", () => {
    const baseline = minimalInput();
    const member = file("inputs/archive/member.txt", "1", "text/plain");
    const aggregate: PersistedAggregateArtifactCapture = {
      kind: "dataset",
      entityId: "inputs/archive.json",
      manifest: source("2", "application/json"),
      members: [member],
      origin: producerOrigin,
    };

    expect(
      buildExecutionEvidence({
        ...baseline,
        additionalInputs: [
          {
            ...aggregate,
            members: [member, member],
          },
        ],
      }),
    ).toEqual(
      buildExecutionEvidence({
        ...baseline,
        additionalInputs: [aggregate],
      }),
    );
  });

  test("deduplicates identical declarations that reuse one graph entity ID", () => {
    const baseline = minimalInput();
    const bytes = buildExecutionEvidence({
      ...baseline,
      recording: {
        ...baseline.recording,
        producer: baseline.recording.executor,
      },
    });
    const entities = graph(bytes);

    expect(
      entities.filter(
        (candidate) =>
          candidate["@id"] === baseline.recording.executor.entityId,
      ),
    ).toHaveLength(1);
    expect(validateExecutionEvidence(bytes)).toMatchObject({
      conforms: true,
      diagnostics: [],
    });
  });
});
