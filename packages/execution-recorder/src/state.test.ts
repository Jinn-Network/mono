// SPDX-License-Identifier: Apache-2.0

import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sha256Digest } from "@jinn-network/evidence-repository";
import { afterEach, describe, expect, test } from "vitest";

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
const protocolFixtureRoot = new URL(
  "../../evidence-protocol/fixtures/golden-execution-evidence-v1/execution/",
  import.meta.url,
);

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

function withInitializedRecording(
  event: Extract<JournalEvent, { type: "initialized" }>,
  recording: PersistedStartRecording,
): Extract<JournalEvent, { type: "initialized" }> {
  return {
    ...event,
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
  let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
  const { artifacts, metadata, artifactDigests } =
    await conformingMetadataFixture(state);
  const start = initialized(artifacts[0]);
  state = await appendWorkspaceEvent(
    state,
    withInitializedRecording(start, {
      ...start.recording,
      initialInputs: artifacts.map((artifact, index) =>
        file(`inputs/fixture-${index}.bin`, artifact),
      ),
    }),
    "2026-07-24T10:00:00Z",
  );
  state = await appendWorkspaceEvent(
    state,
    {
      type: "finalization-prepared",
      intentFingerprint: `sha256:${"4".repeat(64)}`,
      finalizedAt: "2026-07-24T10:01:00Z",
      outcome: "completed",
      endedAt: "2026-07-24T10:00:59Z",
      results: artifacts.slice(1).map((artifact, index) =>
        file(`results/result-${index + 1}.bin`, artifact),
      ),
      nativeTrace: {
        artifact: file("trace/trace.json", artifacts[0]),
        format: { entityId: "https://example.com/trace-format" },
      },
      metadata,
      artifactDigests,
    },
    "2026-07-24T10:01:00Z",
  );
  return {
    state,
    metadata,
    artifactDigests,
  };
}

async function conformingMetadataFixture(
  state: WorkspaceState,
  options: { readonly descriptorSha?: boolean } = {},
): Promise<{
  readonly artifacts: readonly StoredObjectReference[];
  readonly metadata: StoredObjectReference;
  readonly artifactDigests: readonly Sha256Digest[];
  readonly extra: StoredObjectReference;
}> {
  const metadataBytes = await readFile(
    new URL("ro-crate-metadata.json", protocolFixtureRoot),
  );
  const document = JSON.parse(new TextDecoder().decode(metadataBytes)) as {
    "@graph": Array<{ "@id": string; sha256?: string }>;
  };
  const byDigest = new Map<Sha256Digest, StoredObjectReference>();
  for (const entity of document["@graph"]) {
    if (
      entity["@id"] === "ro-crate-metadata.json" ||
      typeof entity.sha256 !== "string"
    ) {
      continue;
    }
    const reference = await storeObject(
      state.paths,
      await readFile(new URL(entity["@id"], protocolFixtureRoot)),
    );
    expect(reference.digest).toBe(`sha256:${entity.sha256}`);
    byDigest.set(reference.digest, reference);
  }
  const artifacts = [...byDigest.values()].sort((left, right) =>
    left.digest.localeCompare(right.digest),
  );
  const extra = await storeObject(
    state.paths,
    new TextEncoder().encode("captured-but-not-in-metadata"),
  );
  if (options.descriptorSha) {
    const descriptor = document["@graph"].find(
      (entity) => entity["@id"] === "ro-crate-metadata.json",
    );
    if (descriptor === undefined) throw new Error("Missing metadata descriptor");
    descriptor.sha256 = extra.digest.slice("sha256:".length);
  }
  return {
    artifacts,
    metadata: await storeObject(
      state.paths,
      options.descriptorSha
        ? new TextEncoder().encode(JSON.stringify(document))
        : metadataBytes,
    ),
    artifactDigests: artifacts.map(({ digest }) => digest),
    extra,
  };
}

async function initializedConformingMetadataState(
  workspaceDir: string,
  options: { readonly descriptorSha?: boolean } = {},
): Promise<{
  readonly state: WorkspaceState;
  readonly metadata: StoredObjectReference;
  readonly artifactDigests: readonly Sha256Digest[];
  readonly extra: StoredObjectReference;
  readonly trace: StoredObjectReference;
}> {
  let state = await createWorkspaceState(workspaceDir, EXECUTION_ID);
  const fixture = await conformingMetadataFixture(state, options);
  const start = initialized(fixture.artifacts[0]);
  state = await appendWorkspaceEvent(
    state,
    withInitializedRecording(start, {
      ...start.recording,
      initialInputs: [...fixture.artifacts, fixture.extra].map(
        (artifact, index) =>
          file(`inputs/fixture-${index}.bin`, artifact),
      ),
    }),
    "2026-07-24T10:00:00Z",
  );
  return {
    state,
    metadata: fixture.metadata,
    artifactDigests: fixture.artifactDigests,
    extra: fixture.extra,
    trace: fixture.artifacts[0],
  };
}

function finalizationEvent(
  metadata: StoredObjectReference,
  trace: StoredObjectReference,
  artifactDigests: readonly Sha256Digest[],
): Extract<JournalEvent, { type: "finalization-prepared" }> {
  return {
    type: "finalization-prepared",
    intentFingerprint: `sha256:${"4".repeat(64)}`,
    finalizedAt: "2026-07-24T10:01:00Z",
    outcome: "completed",
    endedAt: "2026-07-24T10:00:59Z",
    results: [],
    nativeTrace: {
      artifact: file("trace/trace.json", trace),
      format: { entityId: "https://example.com/trace-format" },
    },
    metadata,
    artifactDigests,
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
    const { state, metadata, artifactDigests, trace } =
      await initializedConformingMetadataState(workspaceDir);

    await expect(
      appendWorkspaceEvent(
        state,
        finalizationEvent(metadata, trace, artifactDigests.slice(1)),
        "2026-07-24T10:01:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("rejects captured artifact digests absent from the persisted metadata", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, metadata, artifactDigests, extra, trace } =
      await initializedConformingMetadataState(workspaceDir);
    const withExtra = [...artifactDigests, extra.digest].sort();

    await expect(
      appendWorkspaceEvent(
        state,
        finalizationEvent(metadata, trace, withExtra),
        "2026-07-24T10:01:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("excludes the metadata descriptor hash by entity identity", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, metadata, artifactDigests, trace } =
      await initializedConformingMetadataState(workspaceDir, {
        descriptorSha: true,
      });

    await expect(
      appendWorkspaceEvent(
        state,
        finalizationEvent(metadata, trace, artifactDigests),
        "2026-07-24T10:01:00Z",
      ),
    ).resolves.toMatchObject({ status: "finalizing" });
  });

  test("rejects a finalization object reference whose prior digest has a conflicting size", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, metadata, artifactDigests, trace } =
      await initializedConformingMetadataState(workspaceDir);

    await expect(
      appendWorkspaceEvent(
        state,
        finalizationEvent(
          metadata,
          { ...trace, size: trace.size + 1 },
          artifactDigests,
        ),
        "2026-07-24T10:01:00Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_CORRUPT" });
  });

  test("rejects a finalization end time before the recorded start time", async () => {
    const workspaceDir = await temporaryWorkspace();
    const { state, metadata, artifactDigests, trace } =
      await initializedConformingMetadataState(workspaceDir);

    await expect(
      appendWorkspaceEvent(
        state,
        {
          ...finalizationEvent(metadata, trace, artifactDigests),
          endedAt: "2026-07-24T09:59:59Z",
        },
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
