// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  appendWorkspaceEvent,
  createWorkspaceState,
  openWorkspaceState,
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
  const parent = await mkdtemp(join(tmpdir(), "jinn-recorder-state-"));
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
    declarationFingerprint:
      `sha256:${"1".repeat(64)}` as Sha256Digest,
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
        declarationFingerprint:
          `sha256:${"2".repeat(64)}` as Sha256Digest,
      },
      "2026-07-24T10:00:01Z",
    );
    state = await appendWorkspaceEvent(
      state,
      {
        type: "runtime-observation-captured",
        observation: {
          kind: "resource",
          entityId: "observations/tokens",
          name: "Tokens",
          value: 12,
          origin: ORIGIN,
        },
        declarationFingerprint:
          `sha256:${"3".repeat(64)}` as Sha256Digest,
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
