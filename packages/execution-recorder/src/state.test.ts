// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sha256Digest } from "@jinn-network/evidence-repository";
import { afterEach, describe, expect, test } from "vitest";

import { buildFinalizationCandidate } from "./finalization-candidate.js";
import { finalizationIntentFingerprint } from "./finalization-intent.js";
import type {
  JournalEvent,
  PersistedFileArtifactCapture,
  PersistedStartRecording,
  StoredObjectReference,
} from "./journal-types.js";
import { objectPath, storeObject } from "./object-store.js";
import { captureFingerprint } from "./persist-capture.js";
import {
  appendWorkspaceEvent,
  createWorkspaceState,
  openWorkspaceState,
  type WorkspaceState,
} from "./state.js";

const EXECUTION_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const ORIGIN = {
  kind: "producer-observed" as const,
  observer: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as const,
};
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "jinn-recorder-state-")),
  );
  temporaryDirectories.push(parent);
  return join(parent, "recording");
}

function file(
  entityId: string,
  source: StoredObjectReference,
): PersistedFileArtifactCapture {
  return {
    kind: "file",
    entityId,
    source: {
      ...source,
      mediaType: "application/octet-stream",
    },
    origin: ORIGIN,
  };
}

function initialized(
  source: StoredObjectReference,
): Extract<JournalEvent, { type: "initialized" }> {
  const artifact = file("runtime/runner.mjs", source);
  const recording: PersistedStartRecording = {
    executionId: EXECUTION_ID,
    startedAt: "2026-07-24T10:00:00Z",
    record: {
      name: "Fixture",
      description: "Fixture recording",
      license: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    task: {
      entityId: "task/task.md",
      name: "Fixture task",
      source: {
        ...source,
        mediaType: "text/markdown",
      },
      origin: ORIGIN,
    },
    initialInputs: [],
    executor: {
      entityId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      kind: "software",
      name: "Executor",
      origin: ORIGIN,
    },
    runtime: {
      entityId: "runtime/runtime.json",
      specification: {
        ...source,
        mediaType: "application/json",
      },
      name: "Runtime",
      origin: ORIGIN,
      components: [{ kind: "controlled", artifact }],
    },
    producer: {
      entityId: ORIGIN.observer,
      kind: "software",
      name: "Producer",
      origin: ORIGIN,
    },
  };
  return {
    type: "initialized",
    recording,
    declarationFingerprint: captureFingerprint(
      "initialized",
      recording,
    ),
  };
}

async function finalizingState(
  workspaceDir: string,
): Promise<{
  readonly state: WorkspaceState;
  readonly metadata: StoredObjectReference;
  readonly artifactDigests: readonly Sha256Digest[];
}> {
  const fixture = await initializedConformingMetadataState(workspaceDir);
  const state = await appendWorkspaceEvent(
    fixture.state,
    fixture.event,
    "2026-07-24T10:01:00Z",
  );
  return {
    state,
    metadata: fixture.metadata,
    artifactDigests: fixture.artifactDigests,
  };
}

async function initializedConformingMetadataState(
  workspaceDir: string,
): Promise<{
  readonly state: WorkspaceState;
  readonly metadata: StoredObjectReference;
  readonly artifactDigests: readonly Sha256Digest[];
  readonly extra: StoredObjectReference;
  readonly event: Extract<JournalEvent, { type: "finalization-prepared" }>;
}> {
  let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
  const source = await storeObject(
    state.paths,
    new TextEncoder().encode("fixture source"),
  );
  const start = initialized(source);
  state = await appendWorkspaceEvent(
    state,
    start,
    "2026-07-24T10:00:00Z",
  );
  const resultSource = await storeObject(
    state.paths,
    new TextEncoder().encode("fixture result"),
  );
  const traceSource = await storeObject(
    state.paths,
    new TextEncoder().encode("fixture trace"),
  );
  const results = [file("results/result.bin", resultSource)];
  const nativeTrace = {
    artifact: file("trace/trace.json", traceSource),
    format: { entityId: "https://example.com/trace-format" },
  } as const;
  const material = { results, nativeTrace };
  state = await appendWorkspaceEvent(
    state,
    {
      type: "finalization-material-captured",
      ...material,
      declarationFingerprint: captureFingerprint(
        "finalization-material",
        material,
      ),
    },
    "2026-07-24T10:00:59Z",
  );
  const candidate = buildFinalizationCandidate({
    recording: state.recording!,
    additionalInputs: [],
    runtimeObservations: [],
    outcome: "completed",
    endedAt: "2026-07-24T10:00:59Z",
    finalizedAt: "2026-07-24T10:01:00Z",
    results,
    nativeTrace,
  });
  expect(candidate.validation.conforms).toBe(true);
  const metadata = await storeObject(
    state.paths,
    candidate.metadataBytes,
  );
  const event = {
    type: "finalization-prepared",
    intentFingerprint: candidate.intentFingerprint,
    finalizedAt: "2026-07-24T10:01:00Z",
    outcome: "completed",
    endedAt: "2026-07-24T10:00:59Z",
    results,
    nativeTrace,
    metadata,
    artifactDigests: candidate.artifactDigests,
  } as const;
  const extra = await storeObject(
    state.paths,
    new TextEncoder().encode("captured-but-not-in-metadata"),
  );
  return {
    state,
    metadata,
    artifactDigests: candidate.artifactDigests,
    extra,
    event,
  };
}

function finalizationEvent(
  event: Extract<JournalEvent, { type: "finalization-prepared" }>,
  overrides: Partial<
    Extract<JournalEvent, { type: "finalization-prepared" }>
  > = {},
): Extract<JournalEvent, { type: "finalization-prepared" }> {
  const changed = { ...event, ...overrides };
  return {
    ...changed,
    intentFingerprint: finalizationIntentFingerprint(changed),
  };
}

describe("replayed workspace state", () => {
  test("reduces immutable events and verifies every referenced captured object", async () => {
    const workspaceDir = await temporaryWorkspace();
    let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
    const source = await storeObject(state.paths, new TextEncoder().encode("source"));
    state = await appendWorkspaceEvent(
      state,
      initialized(source),
      "2026-07-24T10:00:00Z",
    );
    const input = file("inputs/value.bin", source);
    state = await appendWorkspaceEvent(
      state,
      {
        type: "input-captured",
        input,
        declarationFingerprint: captureFingerprint("input", input),
      },
      "2026-07-24T10:00:01Z",
    );
    const observation = {
      kind: "resource" as const,
      entityId: "observations/tokens",
      name: "Tokens",
      value: 12,
      origin: ORIGIN,
    };
    state = await appendWorkspaceEvent(
      state,
      {
        type: "runtime-observation-captured",
        observation,
        declarationFingerprint: captureFingerprint(
          "runtime-observation",
          observation,
        ),
      },
      "2026-07-24T10:00:02Z",
    );

    const reopened = await openWorkspaceState(workspaceDir);
    expect(reopened).toMatchObject({
      executionId: EXECUTION_ID,
      status: "open",
      recording: initialized(source).recording,
      inputs: [input],
      runtimeObservations: [
        expect.objectContaining({ kind: "resource", value: 12 }),
      ],
      head: { revision: 3 },
    });
  });

  test("replays durably captured finalization material while still open", async () => {
    const workspaceDir = await temporaryWorkspace();
    let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
    const source = await storeObject(
      state.paths,
      new TextEncoder().encode("source"),
    );
    state = await appendWorkspaceEvent(
      state,
      initialized(source),
      "2026-07-24T10:00:00Z",
    );
    const result = file("results/value.bin", source);
    const material = {
      results: [result],
      nativeTrace: undefined,
    };
    state = await appendWorkspaceEvent(
      state,
      {
        type: "finalization-material-captured",
        ...material,
        declarationFingerprint: captureFingerprint(
          "finalization-material",
          material,
        ),
      },
      "2026-07-24T10:00:01Z",
    );

    const reopened = await openWorkspaceState(workspaceDir);
    expect(reopened.status).toBe("open");
    expect(reopened.results).toEqual([result]);
    expect(reopened.nativeTrace).toBeUndefined();
  });

  test("rejects finalization material with a conflicting contextual identity before publication", async () => {
    const workspaceDir = await temporaryWorkspace();
    let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
    const source = await storeObject(
      state.paths,
      new TextEncoder().encode("source"),
    );
    const start = initialized(source);
    state = await appendWorkspaceEvent(
      state,
      start,
      "2026-07-24T10:00:00Z",
    );
    const nativeTrace = {
      artifact: file("trace/trace.json", source),
      format: { entityId: start.recording.executor.entityId },
    } as const;
    const material = { results: [], nativeTrace };

    await expect(
      appendWorkspaceEvent(
        state,
        {
          type: "finalization-material-captured",
          ...material,
          declarationFingerprint: captureFingerprint(
            "finalization-material",
            material,
          ),
        },
        "2026-07-24T10:00:01Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
    expect((await openWorkspaceState(workspaceDir)).head).toEqual(
      state.head,
    );
  });

  test("rejects a replay whose journal references a corrupted object", async () => {
    const workspaceDir = await temporaryWorkspace();
    let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
    const source = await storeObject(state.paths, new TextEncoder().encode("source"));
    state = await appendWorkspaceEvent(
      state,
      initialized(source),
      "2026-07-24T10:00:00Z",
    );
    await writeFile(objectPath(state.paths, source.digest), "corrupt");

    await expect(openWorkspaceState(workspaceDir)).rejects.toMatchObject({
      code: "CAPTURED_OBJECT_CORRUPT",
    });
  });

  test("rejects a transition that references an object not durably captured", async () => {
    const workspaceDir = await temporaryWorkspace();
    const state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
    const missing = {
      digest: `sha256:${"f".repeat(64)}` as Sha256Digest,
      size: 7,
    };

    await expect(
      appendWorkspaceEvent(
        state,
        initialized(missing),
        "2026-07-24T10:00:00Z",
      ),
    ).rejects.toMatchObject({ code: "CAPTURED_OBJECT_CORRUPT" });
    expect((await openWorkspaceState(workspaceDir)).head.revision).toBe(0);
  });

  test("rejects journal histories whose first transition is not initialization", async () => {
    const workspaceDir = await temporaryWorkspace();
    const state = await createWorkspaceState(workspaceDir, EXECUTION_ID);

    await expect(
      appendWorkspaceEvent(
        state,
        {
          type: "repository-artifact-written",
          digest: `sha256:${"a".repeat(64)}`,
        },
        "2026-07-24T10:00:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("rejects finalization intent that names an untracked object digest", async () => {
    const workspaceDir = await temporaryWorkspace();
    let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
    const source = await storeObject(state.paths, new TextEncoder().encode("source"));
    state = await appendWorkspaceEvent(
      state,
      initialized(source),
      "2026-07-24T10:00:00Z",
    );

    await expect(
      appendWorkspaceEvent(
        state,
        {
          type: "finalization-prepared",
          intentFingerprint: `sha256:${"4".repeat(64)}`,
          finalizedAt: "2026-07-24T10:01:00Z",
          outcome: "completed",
          endedAt: "2026-07-24T10:00:59Z",
          results: [],
          nativeTrace: {
            artifact: file("trace/trace.json", source),
            format: { entityId: "https://example.com/trace-format" },
          },
          metadata: source,
          artifactDigests: [
            `sha256:${"f".repeat(64)}`,
          ],
        },
        "2026-07-24T10:01:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("rejects finalization artifact digests that omit metadata-bound artifacts", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, artifactDigests, event } =
      await initializedConformingMetadataState(workspaceDir);

    await expect(
      appendWorkspaceEvent(
        state,
        finalizationEvent(event, {
          artifactDigests: artifactDigests.slice(1),
        }),
        "2026-07-24T10:01:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("rejects captured artifact digests absent from the persisted metadata", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, artifactDigests, extra, event } =
      await initializedConformingMetadataState(workspaceDir);
    const withExtra = [...artifactDigests, extra.digest].sort();

    await expect(
      appendWorkspaceEvent(
        state,
        finalizationEvent(event, { artifactDigests: withExtra }),
        "2026-07-24T10:01:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("accepts an exact reconstructed finalization intent", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, event } =
      await initializedConformingMetadataState(workspaceDir);
    await expect(
      appendWorkspaceEvent(
        state,
        event,
        "2026-07-24T10:01:00Z",
      ),
    ).resolves.toMatchObject({ status: "finalizing" });
  });

  test("rejects a finalization object reference whose prior digest has a conflicting size", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, event } =
      await initializedConformingMetadataState(workspaceDir);
    if (event.nativeTrace.artifact.kind !== "file") {
      throw new Error("Fixture native trace must be a file.");
    }

    await expect(
      appendWorkspaceEvent(
        state,
        finalizationEvent(event, {
          nativeTrace: {
            ...event.nativeTrace,
            artifact: {
              ...event.nativeTrace.artifact,
              source: {
                ...event.nativeTrace.artifact.source,
                size: event.nativeTrace.artifact.source.size + 1,
              },
            },
          },
        }),
        "2026-07-24T10:01:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("rejects a finalization end time before the recorded start time", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, event } =
      await initializedConformingMetadataState(workspaceDir);

    await expect(
      appendWorkspaceEvent(
        state,
        finalizationEvent(event, {
          endedAt: "2026-07-24T09:59:59Z",
        }),
        "2026-07-24T10:01:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("rejects duplicate intended artifact digests", async () => {
    const workspaceDir = await temporaryWorkspace();
    let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
    const source = await storeObject(state.paths, new TextEncoder().encode("source"));
    const metadata = await storeObject(
      state.paths,
      new TextEncoder().encode("metadata"),
    );
    state = await appendWorkspaceEvent(
      state,
      initialized(source),
      "2026-07-24T10:00:00Z",
    );

    await expect(
      appendWorkspaceEvent(
        state,
        {
          type: "finalization-prepared",
          intentFingerprint: `sha256:${"4".repeat(64)}`,
          finalizedAt: "2026-07-24T10:01:00Z",
          outcome: "completed",
          endedAt: "2026-07-24T10:00:59Z",
          results: [],
          nativeTrace: {
            artifact: file("trace/trace.json", source),
            format: { entityId: "https://example.com/trace-format" },
          },
          metadata,
          artifactDigests: [source.digest, source.digest],
        },
        "2026-07-24T10:01:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("rejects unexpected and duplicate repository artifact acknowledgements", async () => {
    const workspaceDir = await temporaryWorkspace();
    let { state, artifactDigests } = await finalizingState(workspaceDir);

    await expect(
      appendWorkspaceEvent(
        state,
        {
          type: "repository-artifact-written",
          digest: `sha256:${"f".repeat(64)}`,
        },
        "2026-07-24T10:01:01Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });

    state = await appendWorkspaceEvent(
      state,
      {
        type: "repository-artifact-written",
        digest: artifactDigests[0],
      },
      "2026-07-24T10:01:01Z",
    );
    await expect(
      appendWorkspaceEvent(
        state,
        {
          type: "repository-artifact-written",
          digest: artifactDigests[0],
        },
        "2026-07-24T10:01:02Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("requires every intended artifact before the repository record", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, metadata } = await finalizingState(workspaceDir);

    await expect(
      appendWorkspaceEvent(
        state,
        {
          type: "repository-record-written",
          reference: {
            family: "execution-evidence",
            digest: metadata.digest,
          },
        },
        "2026-07-24T10:01:02Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test.each([
    [
      "record family",
      {
        family: "result-evaluation" as const,
        digest: null,
      },
    ],
    [
      "metadata digest",
      {
        family: "execution-evidence" as const,
        digest: `sha256:${"e".repeat(64)}` as Sha256Digest,
      },
    ],
  ])("rejects a repository record with the wrong %s", async (_name, patch) => {
    const workspaceDir = await temporaryWorkspace();
    let { state, metadata, artifactDigests } =
      await finalizingState(workspaceDir);
    for (const digest of artifactDigests) {
      state = await appendWorkspaceEvent(
        state,
        { type: "repository-artifact-written", digest },
        "2026-07-24T10:01:01Z",
      );
    }

    await expect(
      appendWorkspaceEvent(
        state,
        {
          type: "repository-record-written",
          reference: {
            family: patch.family,
            digest: patch.digest ?? metadata.digest,
          },
        },
        "2026-07-24T10:01:02Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("binds the finalized receipt exactly to the finalization intent", async () => {
    const workspaceDir = await temporaryWorkspace();
    let { state, metadata, artifactDigests } =
      await finalizingState(workspaceDir);
    for (const digest of artifactDigests) {
      state = await appendWorkspaceEvent(
        state,
        { type: "repository-artifact-written", digest },
        "2026-07-24T10:01:01Z",
      );
    }
    const record = {
      family: "execution-evidence" as const,
      digest: metadata.digest,
    };
    state = await appendWorkspaceEvent(
      state,
      { type: "repository-record-written", reference: record },
      "2026-07-24T10:01:02Z",
    );

    await expect(
      appendWorkspaceEvent(
        state,
        {
          type: "finalized",
          receipt: {
            executionId: EXECUTION_ID,
            record,
            artifacts: [...artifactDigests]
              .reverse()
              .map((digest) => ({ digest })),
            finalizedAt: "2026-07-24T10:01:00Z",
          },
        },
        "2026-07-24T10:01:03Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });

    const finalized = await appendWorkspaceEvent(
      state,
      {
        type: "finalized",
        receipt: {
          executionId: EXECUTION_ID,
          record,
          artifacts: artifactDigests.map((digest) => ({ digest })),
          finalizedAt: "2026-07-24T10:01:00Z",
        },
      },
      "2026-07-24T10:01:03Z",
    );
    expect(finalized).toMatchObject({
      status: "finalized",
      receipt: { executionId: EXECUTION_ID, record },
    });
  });

  test("honors cancellation while opening state", async () => {
    const workspaceDir = await temporaryWorkspace();
    await createWorkspaceState(workspaceDir, EXECUTION_ID);
    const controller = new AbortController();
    controller.abort();

    await expect(
      openWorkspaceState(workspaceDir, controller.signal),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });
});
