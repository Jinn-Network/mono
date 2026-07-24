// SPDX-License-Identifier: Apache-2.0

import {
  access,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createArtifactReference,
  createRecordReference,
  EvidenceRepositoryError,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  objectDigest,
  objectPath,
} from "./object-store.js";
import { workspacePaths } from "./paths.js";
import { createExecutionRecorder } from "./recorder.js";
import { openWorkspaceState } from "./state.js";
import type {
  FileArtifactCapture,
  FinalizeExecutionInput,
  NativeTraceCapture,
  StartExecutionRecordingInput,
} from "./types.js";

interface RepositoryFault {
  readonly operation: "artifact" | "record";
  readonly phase: "before" | "after";
  readonly occurrence: number;
  readonly error: Error;
}

class FaultInjectingRepository implements EvidenceRepository {
  readonly delegate = new InMemoryEvidenceRepository();
  readonly artifactCalls: Sha256Digest[] = [];
  readonly recordCalls: EvidenceRecordReference[] = [];

  private artifactOccurrences = 0;
  private recordOccurrences = 0;

  constructor(private fault?: RepositoryFault) {}

  private visit(
    operation: RepositoryFault["operation"],
    phase: RepositoryFault["phase"],
    occurrence: number,
  ): void {
    if (
      this.fault?.operation === operation &&
      this.fault.phase === phase &&
      this.fault.occurrence === occurrence
    ) {
      const error = this.fault.error;
      this.fault = undefined;
      throw error;
    }
  }

  async putArtifact(
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
    const occurrence = ++this.artifactOccurrences;
    this.artifactCalls.push(createArtifactReference(bytes).digest);
    this.visit("artifact", "before", occurrence);
    const receipt = await this.delegate.putArtifact(bytes, options);
    this.visit("artifact", "after", occurrence);
    return receipt;
  }

  getArtifact(
    reference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getArtifact(reference, options);
  }

  async putRecord(
    family: EvidenceRecordFamily,
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    const occurrence = ++this.recordOccurrences;
    this.recordCalls.push(createRecordReference(family, bytes));
    this.visit("record", "before", occurrence);
    const receipt = await this.delegate.putRecord(
      family,
      bytes,
      options,
    );
    this.visit("record", "after", occurrence);
    return receipt;
  }

  getRecord(
    reference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getRecord(reference, options);
  }
}

interface RegularFileSyncAbort {
  regularFileSyncs(): number;
  restore(): void;
}

async function installRegularFileSyncAbort(
  probePath: string,
  ordinal: number,
  controller: AbortController,
  reason: Error,
): Promise<RegularFileSyncAbort> {
  const probe = await open(probePath, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync: FileHandle["sync"];
  };
  await probe.close();
  const original = prototype.sync;
  let regularFileSyncs = 0;
  const spy = vi
    .spyOn(prototype, "sync")
    .mockImplementation(async function (this: FileHandle): Promise<void> {
      await original.call(this);
      if ((await this.stat()).isFile()) {
        regularFileSyncs += 1;
        if (regularFileSyncs === ordinal) controller.abort(reason);
      }
    });

  return {
    regularFileSyncs: () => regularFileSyncs,
    restore: () => spy.mockRestore(),
  };
}

const encoder = new TextEncoder();
const roots: string[] = [];
const origin = {
  kind: "producer-observed",
  observer: "https://producer.example/hardening",
} as const;

async function workspace(): Promise<string> {
  const parent = await realpath(
    await mkdtemp(
      join(tmpdir(), "jinn-recorder-hardening-"),
    ),
  );
  roots.push(parent);
  return join(parent, "recording");
}

function file(
  entityId: string,
  text: string,
  mediaType = "text/plain",
): FileArtifactCapture {
  return {
    kind: "file",
    entityId,
    source: {
      bytes: encoder.encode(text),
      mediaType,
      name: entityId.split("/").at(-1),
    },
    origin,
  };
}

function startInput(
  workspaceDir: string,
  overrides: Partial<StartExecutionRecordingInput> = {},
): StartExecutionRecordingInput {
  return {
    workspaceDir,
    executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    startedAt: "2026-07-24T10:00:00Z",
    record: {
      name: "Hardening fixture",
      description: "Exercises recorder crash recovery.",
      license: "https://spdx.org/licenses/Apache-2.0.html",
    },
    task: {
      entityId: "task.md",
      name: "Exercise crash recovery",
      source: {
        bytes: encoder.encode("exercise crash recovery\n"),
        mediaType: "text/markdown",
        name: "task.md",
      },
      origin,
    },
    initialInputs: [file("inputs/initial.txt", "initial\n")],
    executor: {
      entityId: "https://executor.example/hardening",
      kind: "software",
      name: "Hardening executor",
      origin,
    },
    runtime: {
      entityId: "runtime/spec.json",
      name: "Hardening runtime",
      specification: {
        bytes: encoder.encode('{"runtime":"hardening"}\n'),
        mediaType: "application/json",
        name: "spec.json",
      },
      origin,
      components: [
        {
          kind: "controlled",
          artifact: file(
            "runtime/runner.mjs",
            "export const run = true;\n",
            "text/javascript",
          ),
        },
      ],
    },
    producer: {
      entityId: origin.observer,
      kind: "software",
      name: "Hardening producer",
      origin,
    },
    ...overrides,
  };
}

function nativeTrace(): NativeTraceCapture {
  return {
    artifact: file(
      "trace/native.jsonl",
      '{"event":"finished"}\n',
      "application/x-ndjson",
    ),
    format: {
      entityId: "https://example.test/formats/native-trace/v1",
      name: "Hardening trace",
    },
  };
}

function finalizationInput(): FinalizeExecutionInput {
  return {
    outcome: "completed",
    endedAt: "2026-07-24T10:01:00Z",
    results: [file("results/result.txt", "result\n")],
    nativeTrace: nativeTrace(),
  };
}

function callsFor(
  calls: readonly Sha256Digest[],
  digest: Sha256Digest,
): number {
  return calls.filter((candidate) => candidate === digest).length;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("execution recorder durable transition hardening", () => {
  test("an already-cancelled start creates no recorder workspace", async () => {
    const workspaceDir = await workspace();
    const repository = new FaultInjectingRepository();
    const recorder = createExecutionRecorder({ repository });
    const controller = new AbortController();
    const reason = new Error("cancel before start");
    controller.abort(reason);

    await expect(
      recorder.start(startInput(workspaceDir, {
        signal: controller.signal,
      })),
    ).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      cause: reason,
    });
    await expect(access(workspaceDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(repository.artifactCalls).toEqual([]);
    expect(repository.recordCalls).toEqual([]);
  });

  test("cancellation after object temp fsync publishes no capture transition and retry succeeds", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new FaultInjectingRepository(),
    });
    const recording = await recorder.start(startInput(workspaceDir));
    const before = await openWorkspaceState(workspaceDir);
    const capture = file(
      "inputs/object-interrupted.txt",
      "object interrupted\n",
    );
    const digest = objectDigest(encoder.encode("object interrupted\n"));
    const controller = new AbortController();
    const reason = new Error("abort object publication");
    const injection = await installRegularFileSyncAbort(
      join(workspaceDir, "workspace.json"),
      1,
      controller,
      reason,
    );

    try {
      await expect(
        recording.captureInput(capture, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        code: "OPERATION_ABORTED",
        cause: reason,
      });
    } finally {
      injection.restore();
    }

    expect(injection.regularFileSyncs()).toBe(1);
    expect((await openWorkspaceState(workspaceDir)).head).toEqual(
      before.head,
    );
    await expect(
      access(objectPath(workspacePaths(workspaceDir), digest)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await recording.captureInput(capture);
    const recovered = await openWorkspaceState(workspaceDir);
    expect(recovered.head.revision).toBe(before.head.revision + 1);
    expect(
      recovered.inputs.filter(
        ({ entityId }) =>
          entityId === "inputs/object-interrupted.txt",
      ),
    ).toHaveLength(1);
  });

  test("cancellation after journal temp fsync leaves only a reusable object and retry commits once", async () => {
    const workspaceDir = await workspace();
    const recorder = createExecutionRecorder({
      repository: new FaultInjectingRepository(),
    });
    const recording = await recorder.start(startInput(workspaceDir));
    const before = await openWorkspaceState(workspaceDir);
    const capture = file(
      "inputs/journal-interrupted.txt",
      "journal interrupted\n",
    );
    const digest = objectDigest(encoder.encode("journal interrupted\n"));
    const controller = new AbortController();
    const reason = new Error("abort journal publication");
    const injection = await installRegularFileSyncAbort(
      join(workspaceDir, "workspace.json"),
      2,
      controller,
      reason,
    );

    try {
      await expect(
        recording.captureInput(capture, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        code: "OPERATION_ABORTED",
        cause: reason,
      });
    } finally {
      injection.restore();
    }

    expect(injection.regularFileSyncs()).toBe(2);
    expect((await openWorkspaceState(workspaceDir)).head).toEqual(
      before.head,
    );
    expect(
      new Uint8Array(
        await readFile(
          objectPath(workspacePaths(workspaceDir), digest),
        ),
      ),
    ).toEqual(encoder.encode("journal interrupted\n"));
    expect(await readdir(join(workspaceDir, "journal"))).toEqual([
      "000000000001.json",
    ]);

    await recording.captureInput(capture);
    const recovered = await openWorkspaceState(workspaceDir);
    expect(recovered.head.revision).toBe(before.head.revision + 1);
    expect(
      recovered.inputs.filter(
        ({ entityId }) =>
          entityId === "inputs/journal-interrupted.txt",
      ),
    ).toHaveLength(1);
  });

  test("public resume rejects corrupted captured bytes before repository access", async () => {
    const workspaceDir = await workspace();
    const repository = new FaultInjectingRepository();
    const recorder = createExecutionRecorder({ repository });
    await recorder.start(startInput(workspaceDir));
    const state = await openWorkspaceState(workspaceDir);
    const task = state.recording!.task.source;
    await writeFile(objectPath(state.paths, task.digest), "corrupt");

    await expect(
      recorder.resume({ workspaceDir }),
    ).rejects.toMatchObject({
      code: "CAPTURED_OBJECT_CORRUPT",
    });
    expect(repository.artifactCalls).toEqual([]);
    expect(repository.recordCalls).toEqual([]);
  });

  test("a stale finalization handle cannot reach the repository", async () => {
    const workspaceDir = await workspace();
    const repository = new FaultInjectingRepository();
    const recorder = createExecutionRecorder({ repository });
    const current = await recorder.start(startInput(workspaceDir));
    const stale = await recorder.resume({ workspaceDir });
    await current.captureInput(file("inputs/winner.txt", "winner\n"));

    await expect(
      stale.finalize(finalizationInput()),
    ).rejects.toMatchObject({
      code: "RECORDING_CONFLICT",
    });
    expect(repository.artifactCalls).toEqual([]);
    expect(repository.recordCalls).toEqual([]);
    expect((await openWorkspaceState(workspaceDir)).status).toBe(
      "open",
    );
  });

  test("concurrent finalization handles leave one durable finalized winner", async () => {
    const workspaceDir = await workspace();
    const repository = new FaultInjectingRepository();
    const recorder = createExecutionRecorder({ repository });
    const first = await recorder.start(startInput(workspaceDir));
    const second = await recorder.resume({ workspaceDir });

    const attempts = await Promise.allSettled([
      first.finalize(finalizationInput()),
      second.finalize(finalizationInput()),
    ]);

    const fulfilled = attempts.filter(
      (attempt) => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt) => attempt.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({
      value: { finalized: true },
    });
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "RECORDING_CONFLICT",
        }),
      }),
    ]);

    const recovered = await recorder.resume({ workspaceDir });
    expect(recovered.status).toBe("finalized");
    expect(recovered.receipt).toBeDefined();
  });
});

const repositoryFaults = [
  {
    operation: "artifact",
    phase: "before",
    occurrence: 2,
  },
  {
    operation: "artifact",
    phase: "after",
    occurrence: 2,
  },
  {
    operation: "record",
    phase: "before",
    occurrence: 1,
  },
  {
    operation: "record",
    phase: "after",
    occurrence: 1,
  },
] as const satisfies readonly Omit<RepositoryFault, "error">[];

describe("public repository interruption recovery", () => {
  test.each(repositoryFaults)(
    "preserves and recovers the exact $phase $operation write failure",
    async (fault) => {
      const workspaceDir = await workspace();
      const injected = new EvidenceRepositoryError(
        "DEPENDENCY_UNAVAILABLE",
        `injected ${fault.phase} ${fault.operation} failure`,
      );
      const repository = new FaultInjectingRepository({
        ...fault,
        error: injected,
      });
      const recorder = createExecutionRecorder({ repository });
      const recording = await recorder.start(startInput(workspaceDir));

      await expect(
        recording.finalize(finalizationInput()),
      ).rejects.toBe(injected);
      expect(recording.status).toBe("finalizing");

      const pending = await openWorkspaceState(workspaceDir);
      expect(pending.status).toBe("finalizing");
      expect(pending.repositoryRecord).toBeUndefined();
      expect(pending.receipt).toBeUndefined();

      if (fault.operation === "artifact") {
        const checkpointedDigest = repository.artifactCalls[0]!;
        const interruptedDigest = repository.artifactCalls[1]!;
        expect(pending.repositoryArtifactDigests).toEqual([
          checkpointedDigest,
        ]);
        expect(callsFor(
          repository.artifactCalls,
          checkpointedDigest,
        )).toBe(1);
        const stored = await repository.delegate.getArtifact({
          digest: interruptedDigest,
        });
        if (fault.phase === "after") {
          expect(stored).not.toBeNull();
        } else {
          expect(stored).toBeNull();
        }

        const recovered = await recorder.resume({ workspaceDir });
        expect(recovered.status).toBe("finalized");
        expect(callsFor(
          repository.artifactCalls,
          checkpointedDigest,
        )).toBe(1);
        expect(callsFor(
          repository.artifactCalls,
          interruptedDigest,
        )).toBe(2);
      } else {
        expect(pending.repositoryArtifactDigests).toEqual(
          pending.finalization!.artifactDigests,
        );
        const artifactCalls = [...repository.artifactCalls];
        const recordReference = {
          family: "execution-evidence" as const,
          digest: pending.finalization!.metadata.digest,
        };
        const stored = await repository.delegate.getRecord(
          recordReference,
        );
        if (fault.phase === "after") {
          expect(stored).not.toBeNull();
        } else {
          expect(stored).toBeNull();
        }

        const recovered = await recorder.resume({ workspaceDir });
        expect(recovered.status).toBe("finalized");
        expect(repository.artifactCalls).toEqual(artifactCalls);
        expect(repository.recordCalls).toEqual([
          recordReference,
          recordReference,
        ]);
      }

      const finalized = await openWorkspaceState(workspaceDir);
      expect(finalized.status).toBe("finalized");
      expect(finalized.receipt).toBeDefined();
    },
  );
});
