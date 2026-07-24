// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import {
  createArtifactReference,
  EvidenceRepositoryError,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { afterEach, describe, expect, test } from "vitest";

import {
  finalizeWorkspaceState,
  resumePendingFinalization,
} from "./finalization.js";
import { readStoredObject } from "./object-store.js";
import { captureFingerprint, persistStartRecording } from "./persist-capture.js";
import {
  appendWorkspaceEvent,
  createWorkspaceState,
  openWorkspaceState,
  type WorkspaceState,
} from "./state.js";
import type {
  FileArtifactCapture,
  FinalizeExecutionInput,
  NativeTraceCapture,
  StartExecutionRecordingInput,
} from "./types.js";

const EXECUTION_ID =
  "urn:uuid:11111111-1111-4111-8111-111111111111" as const;
const ORIGIN = {
  kind: "producer-observed" as const,
  observer: "urn:agent:producer" as const,
};
const temporaryDirectories: string[] = [];

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function file(
  entityId: string,
  value: string,
  mediaType = "application/octet-stream",
): FileArtifactCapture {
  return {
    kind: "file",
    entityId,
    source: {
      bytes: bytes(value),
      mediaType,
    },
    origin: ORIGIN,
  };
}

function startInput(workspaceDir: string): StartExecutionRecordingInput {
  return {
    workspaceDir,
    executionId: EXECUTION_ID,
    startedAt: "2026-07-24T10:00:00Z",
    record: {
      name: "Finalization fixture",
      description: "A fixture for finalization orchestration.",
      license: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    task: {
      entityId: "task/task.md",
      name: "Perform the finalization fixture",
      source: {
        bytes: bytes("fixture task"),
        mediaType: "text/markdown",
      },
      origin: ORIGIN,
    },
    initialInputs: [file("inputs/value.txt", "fixture input", "text/plain")],
    executor: {
      entityId: "urn:agent:executor",
      kind: "software",
      name: "Fixture executor",
      origin: ORIGIN,
    },
    runtime: {
      entityId: "runtime/specification.json",
      specification: {
        bytes: bytes('{"runtime":"fixture"}'),
        mediaType: "application/json",
      },
      name: "Fixture runtime",
      origin: ORIGIN,
      components: [
        {
          kind: "controlled",
          artifact: file(
            "runtime/runner.mjs",
            "export default 'fixture';",
            "text/javascript",
          ),
        },
      ],
    },
    producer: {
      entityId: ORIGIN.observer,
      kind: "software",
      name: "Fixture producer",
      origin: ORIGIN,
    },
  };
}

function nativeTrace(value = "fixture trace"): NativeTraceCapture {
  return {
    artifact: file(
      "trace/native.jsonl",
      value,
      "application/x-ndjson",
    ),
    format: {
      entityId: "https://example.test/formats/native-trace/v1",
      name: "Fixture native trace format",
    },
  };
}

class FinalizationFaultRepository implements EvidenceRepository {
  readonly delegate = new InMemoryEvidenceRepository();
  readonly events: string[] = [];

  constructor(
    private fault?: {
      readonly point: string;
      readonly error: Error;
    },
  ) {}

  clearFault(): void {
    this.fault = undefined;
  }

  setFault(point: string, error: Error): void {
    this.fault = { point, error };
  }

  private visit(point: string): void {
    this.events.push(point);
    if (
      this.fault !== undefined &&
      (this.fault.point === "*" || this.fault.point === point)
    ) {
      const error = this.fault.error;
      this.fault = undefined;
      throw error;
    }
  }

  async putRecord(
    family: EvidenceRecordFamily,
    value: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    this.visit(`before:record:${family}`);
    const receipt = await this.delegate.putRecord(family, value, options);
    this.visit(`after:record:${family}`);
    return receipt;
  }

  getRecord(
    reference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getRecord(reference, options);
  }

  async putArtifact(
    value: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
    const digest = createArtifactReference(value).digest;
    this.visit(`before:artifact:${digest}`);
    const receipt = await this.delegate.putArtifact(value, options);
    this.visit(`after:artifact:${digest}`);
    return receipt;
  }

  getArtifact(
    reference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getArtifact(reference, options);
  }
}

class ReceiptMutatingRepository implements EvidenceRepository {
  readonly delegate = new FinalizationFaultRepository();

  constructor(
    private readonly mutateArtifact?: (
      receipt: RepositoryWriteReceipt<EvidenceArtifactReference>,
    ) => RepositoryWriteReceipt<EvidenceArtifactReference>,
    private readonly mutateRecord?: (
      receipt: RepositoryWriteReceipt<EvidenceRecordReference>,
    ) => RepositoryWriteReceipt<EvidenceRecordReference>,
  ) {}

  async putRecord(
    family: EvidenceRecordFamily,
    value: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    const receipt = await this.delegate.putRecord(
      family,
      value,
      options,
    );
    return this.mutateRecord?.(receipt) ?? receipt;
  }

  getRecord(
    reference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getRecord(reference, options);
  }

  async putArtifact(
    value: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
    const receipt = await this.delegate.putArtifact(value, options);
    return this.mutateArtifact?.(receipt) ?? receipt;
  }

  getArtifact(
    reference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getArtifact(reference, options);
  }
}

class ByteMutatingRepository implements EvidenceRepository {
  readonly delegate = new FinalizationFaultRepository();

  constructor(
    private readonly target: "artifact" | "record",
  ) {}

  async putRecord(
    family: EvidenceRecordFamily,
    value: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    if (this.target === "record") {
      value[0] = value[0]! ^ 0xff;
    }
    return this.delegate.putRecord(family, value, options);
  }

  getRecord(
    reference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getRecord(reference, options);
  }

  async putArtifact(
    value: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
    if (this.target === "artifact") {
      value[0] = value[0]! ^ 0xff;
    }
    return this.delegate.putArtifact(value, options);
  }

  getArtifact(
    reference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getArtifact(reference, options);
  }
}

async function initializedState(): Promise<WorkspaceState> {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "jinn-recorder-finalization-")),
  );
  temporaryDirectories.push(parent);
  const workspaceDir = join(parent, "recording");
  let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
  const recording = await persistStartRecording(
    state.paths,
    startInput(workspaceDir),
    EXECUTION_ID,
  );
  state = await appendWorkspaceEvent(
    state,
    {
      type: "initialized",
      recording,
      declarationFingerprint: captureFingerprint(
        "initialized",
        recording,
      ),
    },
    "2026-07-24T10:00:00Z",
  );
  return state;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("execution finalization", () => {
  test("returns sorted missing diagnostics and leaves the recording open", async () => {
    const state = await initializedState();

    const outcome = await finalizeWorkspaceState(
      new InMemoryEvidenceRepository(),
      state,
      {
        outcome: "completed",
        endedAt: "2026-07-24T10:00:01Z",
      },
    );

    expect(outcome.result).toEqual({
      finalized: false,
      diagnostics: [
        {
          code: "COMPLETED_RESULT_MISSING",
          path: "/results",
          message: "Completed execution requires at least one Result.",
          entityId: EXECUTION_ID,
        },
        {
          code: "NATIVE_TRACE_MISSING",
          path: "/nativeTrace",
          message: "Execution recording requires a primary native trace.",
          entityId: EXECUTION_ID,
        },
      ],
    });
    expect(outcome.state).toBe(state);
    expect(outcome.state).toMatchObject({
      status: "open",
      head: state.head,
    });
  });

  test("commits a complete finalization artifact-first and persists its exact receipt", async () => {
    const repository = new FinalizationFaultRepository();
    const state = await initializedState();

    const outcome = await finalizeWorkspaceState(
      repository,
      state,
      {
        outcome: "completed",
        endedAt: "2026-07-24T10:00:01Z",
        results: [
          file("results/result.txt", "fixture result", "text/plain"),
        ],
        nativeTrace: nativeTrace(),
      },
      {
        now: () => new Date("2026-07-24T10:00:02Z"),
      },
    );

    expect(outcome.result.finalized).toBe(true);
    if (!outcome.result.finalized) {
      throw new Error("Expected finalization to succeed.");
    }
    const { receipt } = outcome.result;
    const artifactDigests = receipt.artifacts.map(({ digest }) => digest);
    expect(artifactDigests).toEqual([...artifactDigests].sort());
    expect(repository.events).toEqual([
      ...artifactDigests.flatMap((digest) => [
        `before:artifact:${digest}`,
        `after:artifact:${digest}`,
      ]),
      "before:record:execution-evidence",
      "after:record:execution-evidence",
    ]);

    expect(outcome.state).toMatchObject({
      status: "finalized",
      finalization: {
        finalizedAt: "2026-07-24T10:00:02.000Z",
        artifactDigests,
        metadata: {
          digest: receipt.record.digest,
        },
      },
      repositoryArtifactDigests: artifactDigests,
      repositoryRecord: receipt.record,
      receipt,
    });
    expect(receipt).toEqual({
      executionId: EXECUTION_ID,
      record: outcome.state.repositoryRecord,
      artifacts: artifactDigests.map((digest) => ({ digest })),
      finalizedAt: "2026-07-24T10:00:02.000Z",
    });

    const metadata = await repository.getRecord(receipt.record);
    expect(metadata).not.toBeNull();
    expect(validateExecutionEvidence(metadata!)).toMatchObject({
      conforms: true,
      diagnostics: [],
    });
    expect(
      await readStoredObject(
        outcome.state.paths,
        outcome.state.finalization!.metadata,
      ),
    ).toEqual(metadata);
    await Promise.all(
      receipt.artifacts.map(async (reference) => {
        expect(await repository.getArtifact(reference)).not.toBeNull();
      }),
    );
  });

  test("returns the same receipt for an identical repeated finalization", async () => {
    const repository = new FinalizationFaultRepository();
    const state = await initializedState();
    const input = {
      outcome: "completed" as const,
      endedAt: "2026-07-24T10:00:01Z",
      results: [
        file("results/result.txt", "fixture result", "text/plain"),
      ],
      nativeTrace: nativeTrace(),
    };
    const first = await finalizeWorkspaceState(
      repository,
      state,
      input,
      {
        now: () => new Date("2026-07-24T10:00:02Z"),
      },
    );
    const repositoryEvents = [...repository.events];
    let clockCalls = 0;

    const repeated = await finalizeWorkspaceState(
      repository,
      first.state,
      input,
      {
        now: () => {
          clockCalls += 1;
          return new Date("2030-01-01T00:00:00Z");
        },
      },
    );

    expect(repeated).toEqual(first);
    expect(repeated.state).toBe(first.state);
    expect(repository.events).toEqual(repositoryEvents);
    expect(clockCalls).toBe(0);
  });

  test("binds repeated finalization to the complete persisted intent and exact candidate metadata", async () => {
    const repository = new FinalizationFaultRepository();
    const state = await initializedState();
    const input: FinalizeExecutionInput = {
      outcome: "completed",
      endedAt: "2026-07-24T10:00:01Z",
      results: [
        file("results/result.txt", "fixture result", "text/plain"),
      ],
      nativeTrace: nativeTrace(),
    };
    const finalized = await finalizeWorkspaceState(
      repository,
      state,
      input,
      {
        now: () => new Date("2026-07-24T10:00:02Z"),
      },
    );
    const repositoryEvents = [...repository.events];
    const cases: readonly {
      readonly name: string;
      readonly expectedCode:
        | "RECORDING_CONFLICT"
        | "WORKSPACE_CORRUPT";
      readonly mutate: (value: WorkspaceState) => WorkspaceState;
    }[] = [
      {
        name: "candidate metadata bytes",
        expectedCode: "RECORDING_CONFLICT",
        mutate: (value) => ({
          ...value,
          recording: {
            ...value.recording!,
            record: {
              ...value.recording!.record,
              description: "Changed after intent persistence.",
            },
          },
        }),
      },
      {
        name: "persisted finalizedAt",
        expectedCode: "WORKSPACE_CORRUPT",
        mutate: (value) => ({
          ...value,
          finalization: {
            ...value.finalization!,
            finalizedAt: "2026-07-24T10:00:03.000Z",
          },
        }),
      },
      {
        name: "persisted metadata digest",
        expectedCode: "WORKSPACE_CORRUPT",
        mutate: (value) => ({
          ...value,
          finalization: {
            ...value.finalization!,
            metadata: {
              ...value.finalization!.metadata,
              digest: `sha256:${"0".repeat(64)}`,
            },
          },
        }),
      },
      {
        name: "persisted metadata size",
        expectedCode: "WORKSPACE_CORRUPT",
        mutate: (value) => ({
          ...value,
          finalization: {
            ...value.finalization!,
            metadata: {
              ...value.finalization!.metadata,
              size: value.finalization!.metadata.size + 1,
            },
          },
        }),
      },
      {
        name: "persisted artifact digests",
        expectedCode: "WORKSPACE_CORRUPT",
        mutate: (value) => ({
          ...value,
          finalization: {
            ...value.finalization!,
            artifactDigests:
              value.finalization!.artifactDigests.slice(1),
          },
        }),
      },
    ];

    for (const candidate of cases) {
      let clockCalls = 0;
      await expect(
        finalizeWorkspaceState(
          repository,
          candidate.mutate(finalized.state),
          input,
          {
            now: () => {
              clockCalls += 1;
              return new Date("2030-01-01T00:00:00Z");
            },
          },
        ),
        candidate.name,
      ).rejects.toMatchObject({
        code: candidate.expectedCode,
      });
      expect(clockCalls, candidate.name).toBe(0);
    }
    expect(repository.events).toEqual(repositoryEvents);
  });

  test("resumes matching pending intent and rejects changed material before repository writes", async () => {
    const interrupted = new EvidenceRepositoryError(
      "DEPENDENCY_UNAVAILABLE",
      "Injected interruption after preparing finalization.",
    );
    const repository = new FinalizationFaultRepository({
      point: "*",
      error: interrupted,
    });
    const state = await initializedState();
    const input: FinalizeExecutionInput = {
      outcome: "completed",
      endedAt: "2026-07-24T10:00:01Z",
      results: [
        file("results/result.txt", "fixture result", "text/plain"),
      ],
      nativeTrace: nativeTrace(),
    };

    await expect(
      finalizeWorkspaceState(repository, state, input, {
        now: () => new Date("2026-07-24T10:00:02Z"),
      }),
    ).rejects.toBe(interrupted);
    const pending = await openWorkspaceState(state.paths.root);
    expect(pending.status).toBe("finalizing");
    const repositoryEvents = [...repository.events];

    await expect(
      finalizeWorkspaceState(repository, pending, {
        ...input,
        endedAt: "2026-07-24T10:00:01.500Z",
      }),
    ).rejects.toMatchObject({
      code: "RECORDING_CONFLICT",
    });
    expect(repository.events).toEqual(repositoryEvents);

    repository.clearFault();
    let clockCalls = 0;
    const recovered = await finalizeWorkspaceState(
      repository,
      pending,
      input,
      {
        now: () => {
          clockCalls += 1;
          return new Date("2030-01-01T00:00:00Z");
        },
      },
    );

    expect(recovered.result.finalized).toBe(true);
    expect(recovered.state.finalization).toEqual(
      pending.finalization,
    );
    expect(clockCalls).toBe(0);
  });

  test("rejects changed material after finalization intent is persisted", async () => {
    const repository = new FinalizationFaultRepository();
    const state = await initializedState();
    const input: FinalizeExecutionInput = {
      outcome: "completed",
      endedAt: "2026-07-24T10:00:01Z",
      results: [
        file("results/result.txt", "fixture result", "text/plain"),
      ],
      nativeTrace: nativeTrace(),
    };
    const finalized = await finalizeWorkspaceState(
      repository,
      state,
      input,
      {
        now: () => new Date("2026-07-24T10:00:02Z"),
      },
    );
    const repositoryEvents = [...repository.events];
    const cases: readonly {
      readonly name: string;
      readonly change: (
        value: FinalizeExecutionInput,
      ) => FinalizeExecutionInput;
    }[] = [
      {
        name: "outcome",
        change: (value) => ({ ...value, outcome: "failed" }),
      },
      {
        name: "end time",
        change: (value) => ({
          ...value,
          endedAt: "2026-07-24T10:00:01.500Z",
        }),
      },
      {
        name: "Result bytes",
        change: (value) => ({
          ...value,
          results: [
            file("results/result.txt", "changed result", "text/plain"),
          ],
        }),
      },
      {
        name: "native trace bytes",
        change: (value) => ({
          ...value,
          nativeTrace: nativeTrace("changed trace"),
        }),
      },
    ];

    for (const candidate of cases) {
      await expect(
        finalizeWorkspaceState(
          repository,
          finalized.state,
          candidate.change(input),
        ),
        candidate.name,
      ).rejects.toMatchObject({
        code: "RECORDING_CONFLICT",
        details: {
          workspaceDir: state.paths.root,
        },
      });
    }
    expect(repository.events).toEqual(repositoryEvents);
  });

  test("produces deterministic evidence from identical persisted captures", async () => {
    const firstRepository = new FinalizationFaultRepository();
    const secondRepository = new FinalizationFaultRepository();
    const input: FinalizeExecutionInput = {
      outcome: "completed",
      endedAt: "2026-07-24T10:00:01Z",
      results: [
        file("results/result.txt", "fixture result", "text/plain"),
      ],
      nativeTrace: nativeTrace(),
    };
    const options = {
      now: () => new Date("2026-07-24T10:00:02Z"),
    };

    const first = await finalizeWorkspaceState(
      firstRepository,
      await initializedState(),
      input,
      options,
    );
    const second = await finalizeWorkspaceState(
      secondRepository,
      await initializedState(),
      input,
      options,
    );

    expect(second.result).toEqual(first.result);
    expect(second.state.finalization).toEqual(
      first.state.finalization,
    );
    expect(secondRepository.events).toEqual(firstRepository.events);
    expect(
      await readStoredObject(
        second.state.paths,
        second.state.finalization!.metadata,
      ),
    ).toEqual(
      await readStoredObject(
        first.state.paths,
        first.state.finalization!.metadata,
      ),
    );
  });

  test.each(["failed", "abandoned"] as const)(
    "finalizes a %s execution without Results",
    async (outcome) => {
      const repository = new FinalizationFaultRepository();

      const finalized = await finalizeWorkspaceState(
        repository,
        await initializedState(),
        {
          outcome,
          endedAt: "2026-07-24T10:00:01Z",
          nativeTrace: nativeTrace(),
        },
        {
          now: () => new Date("2026-07-24T10:00:02Z"),
        },
      );

      expect(finalized.result.finalized).toBe(true);
      if (!finalized.result.finalized) {
        throw new Error("Expected finalization to succeed.");
      }
      expect(
        validateExecutionEvidence(
          (await repository.getRecord(
            finalized.result.receipt.record,
          ))!,
        ),
      ).toMatchObject({
        conforms: true,
        diagnostics: [],
      });
    },
  );

  test.each([
    {
      name: "digest",
      mutate: (
        receipt: RepositoryWriteReceipt<EvidenceArtifactReference>,
      ) => ({
        ...receipt,
        reference: {
          digest:
            `sha256:${"0".repeat(64)}` as EvidenceArtifactReference["digest"],
        },
      }),
    },
    {
      name: "size",
      mutate: (
        receipt: RepositoryWriteReceipt<EvidenceArtifactReference>,
      ) => ({
        ...receipt,
        size: receipt.size + 1,
      }),
    },
  ])(
    "rejects an artifact acknowledgement with the wrong $name before checkpointing it",
    async ({ mutate }) => {
      const repository = new ReceiptMutatingRepository(mutate);
      const state = await initializedState();

      await expect(
        finalizeWorkspaceState(
          repository,
          state,
          {
            outcome: "completed",
            endedAt: "2026-07-24T10:00:01Z",
            results: [
              file(
                "results/result.txt",
                "fixture result",
                "text/plain",
              ),
            ],
            nativeTrace: nativeTrace(),
          },
          {
            now: () => new Date("2026-07-24T10:00:02Z"),
          },
        ),
      ).rejects.toMatchObject({
        name: "EvidenceRepositoryError",
        code: "CONTENT_CORRUPT",
      });

      const pending = await openWorkspaceState(state.paths.root);
      expect(pending).toMatchObject({
        status: "finalizing",
        repositoryArtifactDigests: [],
      });
      expect(pending.repositoryRecord).toBeUndefined();
      expect(pending.receipt).toBeUndefined();
    },
  );

  test.each([
    {
      name: "family",
      mutate: (
        receipt: RepositoryWriteReceipt<EvidenceRecordReference>,
      ) => ({
        ...receipt,
        reference: {
          ...receipt.reference,
          family: "result-evaluation" as const,
        },
      }),
    },
    {
      name: "digest",
      mutate: (
        receipt: RepositoryWriteReceipt<EvidenceRecordReference>,
      ) => ({
        ...receipt,
        reference: {
          ...receipt.reference,
          digest:
            `sha256:${"0".repeat(64)}` as EvidenceRecordReference["digest"],
        },
      }),
    },
    {
      name: "size",
      mutate: (
        receipt: RepositoryWriteReceipt<EvidenceRecordReference>,
      ) => ({
        ...receipt,
        size: receipt.size + 1,
      }),
    },
  ])(
    "rejects a record acknowledgement with the wrong $name before finalizing",
    async ({ mutate }) => {
      const repository = new ReceiptMutatingRepository(
        undefined,
        mutate,
      );
      const state = await initializedState();

      await expect(
        finalizeWorkspaceState(
          repository,
          state,
          {
            outcome: "completed",
            endedAt: "2026-07-24T10:00:01Z",
            results: [
              file(
                "results/result.txt",
                "fixture result",
                "text/plain",
              ),
            ],
            nativeTrace: nativeTrace(),
          },
          {
            now: () => new Date("2026-07-24T10:00:02Z"),
          },
        ),
      ).rejects.toMatchObject({
        name: "EvidenceRepositoryError",
        code: "CONTENT_CORRUPT",
      });

      const pending = await openWorkspaceState(state.paths.root);
      expect(pending).toMatchObject({
        status: "finalizing",
      });
      expect(pending.repositoryRecord).toBeUndefined();
      expect(pending.receipt).toBeUndefined();
      expect(pending.repositoryArtifactDigests).toEqual(
        pending.finalization!.artifactDigests,
      );
    },
  );

  test.each(["artifact", "record"] as const)(
    "rejects a repository that mutates %s bytes before acknowledging them",
    async (target) => {
      const repository = new ByteMutatingRepository(target);
      const state = await initializedState();

      await expect(
        finalizeWorkspaceState(
          repository,
          state,
          {
            outcome: "completed",
            endedAt: "2026-07-24T10:00:01Z",
            results: [
              file(
                "results/result.txt",
                "fixture result",
                "text/plain",
              ),
            ],
            nativeTrace: nativeTrace(),
          },
          {
            now: () => new Date("2026-07-24T10:00:02Z"),
          },
        ),
      ).rejects.toMatchObject({
        name: "EvidenceRepositoryError",
        code: "CONTENT_CORRUPT",
      });

      const pending = await openWorkspaceState(state.paths.root);
      expect(pending.status).toBe("finalizing");
      expect(pending.repositoryRecord).toBeUndefined();
      expect(pending.receipt).toBeUndefined();
      if (target === "artifact") {
        expect(pending.repositoryArtifactDigests).toEqual([]);
      } else {
        expect(pending.repositoryArtifactDigests).toEqual(
          pending.finalization!.artifactDigests,
        );
      }
    },
  );

  test("recovers faults before and after every repository operation without rewriting checkpoints", async () => {
    const input: FinalizeExecutionInput = {
      outcome: "completed",
      endedAt: "2026-07-24T10:00:01Z",
      results: [
        file("results/result.txt", "fixture result", "text/plain"),
      ],
      nativeTrace: nativeTrace(),
    };
    const baselineRepository = new FinalizationFaultRepository();
    const baseline = await finalizeWorkspaceState(
      baselineRepository,
      await initializedState(),
      input,
      {
        now: () => new Date("2026-07-24T10:00:02Z"),
      },
    );
    expect(baseline.result.finalized).toBe(true);
    if (!baseline.result.finalized) {
      throw new Error("Expected baseline finalization to succeed.");
    }
    const faultPoints = [...baselineRepository.events];

    for (const point of faultPoints) {
      const injected = new EvidenceRepositoryError(
        "IO_FAILURE",
        `Injected fault at ${point}`,
      );
      const repository = new FinalizationFaultRepository({
        point,
        error: injected,
      });
      const state = await initializedState();
      await expect(
        finalizeWorkspaceState(repository, state, input, {
          now: () => new Date("2026-07-24T10:00:02Z"),
        }),
        point,
      ).rejects.toBe(injected);

      const reopened = await openWorkspaceState(state.paths.root);
      expect(reopened.status).toBe("finalizing");
      expect(reopened.repositoryRecord).toBeUndefined();
      const checkpointed = new Set(
        reopened.repositoryArtifactDigests,
      );
      const resumeEventIndex = repository.events.length;
      repository.clearFault();

      const recovered = await resumePendingFinalization(
        repository,
        reopened,
      );

      expect(recovered.result).toEqual(baseline.result);
      expect(
        repository.events.slice(resumeEventIndex),
      ).toEqual([
        ...baseline.result.receipt.artifacts
          .filter(({ digest }) => !checkpointed.has(digest))
          .flatMap(({ digest }) => [
            `before:artifact:${digest}`,
            `after:artifact:${digest}`,
          ]),
        "before:record:execution-evidence",
        "after:record:execution-evidence",
      ]);
    }
  }, 30_000);

  test("recovers faults before and after every resumed repository operation", async () => {
    const input: FinalizeExecutionInput = {
      outcome: "completed",
      endedAt: "2026-07-24T10:00:01Z",
      results: [
        file("results/result.txt", "fixture result", "text/plain"),
      ],
      nativeTrace: nativeTrace(),
    };
    const baselineRepository = new FinalizationFaultRepository();
    const baseline = await finalizeWorkspaceState(
      baselineRepository,
      await initializedState(),
      input,
      {
        now: () => new Date("2026-07-24T10:00:02Z"),
      },
    );
    expect(baseline.result.finalized).toBe(true);
    if (!baseline.result.finalized) {
      throw new Error("Expected baseline finalization to succeed.");
    }
    const faultPoints = [...baselineRepository.events];
    const firstOperation = faultPoints[0]!;

    for (const point of faultPoints) {
      const initialFault = new EvidenceRepositoryError(
        "IO_FAILURE",
        `Initial interruption before resumed fault at ${point}`,
      );
      const repository = new FinalizationFaultRepository({
        point: firstOperation,
        error: initialFault,
      });
      const state = await initializedState();
      await expect(
        finalizeWorkspaceState(repository, state, input, {
          now: () => new Date("2026-07-24T10:00:02Z"),
        }),
      ).rejects.toBe(initialFault);

      const pending = await openWorkspaceState(state.paths.root);
      const resumedFault = new EvidenceRepositoryError(
        "DEPENDENCY_UNAVAILABLE",
        `Injected resumed fault at ${point}`,
      );
      repository.setFault(point, resumedFault);
      await expect(
        resumePendingFinalization(repository, pending),
        point,
      ).rejects.toBe(resumedFault);

      const interruptedAgain = await openWorkspaceState(
        state.paths.root,
      );
      repository.clearFault();
      const recovered = await resumePendingFinalization(
        repository,
        interruptedAgain,
      );
      expect(recovered.result).toEqual(baseline.result);
    }
  }, 30_000);

  test("rejects nonconforming exact metadata before repository writes", async () => {
    const repository = new FinalizationFaultRepository();
    const state = await initializedState();
    const malformed = {
      ...state,
      recording: {
        ...state.recording!,
        record: {
          ...state.recording!.record,
          description: "",
        },
      },
    };

    await expect(
      finalizeWorkspaceState(
        repository,
        malformed,
        {
          outcome: "completed",
          endedAt: "2026-07-24T10:00:01Z",
          results: [
            file(
              "results/result.txt",
              "fixture result",
              "text/plain",
            ),
          ],
          nativeTrace: nativeTrace(),
        },
        {
          now: () => new Date("2026-07-24T10:00:02Z"),
        },
      ),
    ).rejects.toMatchObject({
      code: "PROTOCOL_CONFORMANCE_FAILED",
      details: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "ROCRATE_ROOT_FIELDS_INVALID",
          }),
        ]),
      },
    });
    expect(repository.events).toEqual([]);
    expect(await openWorkspaceState(state.paths.root)).toMatchObject({
      status: "open",
      head: { revision: state.head.revision + 1 },
      results: [
        expect.objectContaining({ entityId: "results/result.txt" }),
      ],
      nativeTrace: expect.objectContaining({
        artifact: expect.objectContaining({
          entityId: "trace/native.jsonl",
        }),
      }),
    });
  });
});
