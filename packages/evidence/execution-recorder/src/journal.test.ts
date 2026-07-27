// SPDX-License-Identifier: Apache-2.0

import {
  lstat,
  mkdtemp,
  realpath,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sha256Digest } from "@jinn-network/evidence-repository";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  EMPTY_JOURNAL_HEAD,
  appendJournalEntry,
  initializeWorkspaceMarker,
  journalEntryPath,
  readWorkspaceMarker,
  replayJournal,
} from "./journal.js";
import type {
  JournalEvent,
  PersistedStartRecording,
} from "./journal-types.js";
import { workspacePaths, type WorkspacePaths } from "./paths.js";

const EXECUTION_ID = "urn:uuid:11111111-1111-4111-8111-111111111111";
const OTHER_EXECUTION_ID = "urn:uuid:22222222-2222-4222-8222-222222222222";
const ARTIFACT_DIGEST =
  `sha256:${"a".repeat(64)}` as Sha256Digest;
const temporaryDirectories: string[] = [];
let paths: WorkspacePaths;

const PERSISTED_SOURCE = {
  digest: ARTIFACT_DIGEST,
  size: 7,
  mediaType: "application/octet-stream",
} as const;
const ORIGIN = {
  kind: "producer-observed" as const,
  observer: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as const,
};

function initializedEvent(): Extract<
  JournalEvent,
  { type: "initialized" }
> {
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
      source: PERSISTED_SOURCE,
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
        ...PERSISTED_SOURCE,
        mediaType: "application/json",
      },
      name: "Runtime",
      origin: ORIGIN,
      components: [
        {
          kind: "controlled",
          artifact: {
            kind: "file",
            entityId: "runtime/runner.mjs",
            source: PERSISTED_SOURCE,
            origin: ORIGIN,
          },
        },
      ],
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
    declarationFingerprint: `sha256:${"1".repeat(64)}`,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

beforeEach(async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "jinn-recorder-journal-")),
  );
  temporaryDirectories.push(parent);
  paths = workspacePaths(join(parent, "recording"));
});

describe("workspace marker", () => {
  test("publishes an immutable private marker and accepts an identical retry", async () => {
    const first = await initializeWorkspaceMarker(paths, EXECUTION_ID);
    const second = await initializeWorkspaceMarker(paths, EXECUTION_ID);

    expect(first).toEqual({ formatVersion: 1, executionId: EXECUTION_ID });
    expect(second).toEqual(first);
    expect(JSON.parse(await readFile(paths.marker, "utf8"))).toEqual(first);
    expect((await lstat(paths.marker)).mode & 0o777).toBe(0o600);
  });

  test("rejects a different execution identity and unsupported marker version", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    await expect(
      initializeWorkspaceMarker(paths, OTHER_EXECUTION_ID),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });

    await writeFile(
      paths.marker,
      `${JSON.stringify({ formatVersion: 2, executionId: EXECUTION_ID })}\n`,
    );
    await expect(readWorkspaceMarker(paths)).rejects.toMatchObject({
      code: "WORKSPACE_VERSION_UNSUPPORTED",
    });
  });
});

describe("workspace journal", () => {
  test("appends private revisioned entries linked by exact-byte digest", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    const first = await appendJournalEntry(
      paths,
      {
        type: "repository-artifact-written",
        digest: ARTIFACT_DIGEST,
      },
      EMPTY_JOURNAL_HEAD,
      "2026-07-24T10:00:00Z",
    );
    const second = await appendJournalEntry(
      paths,
      {
        type: "repository-artifact-written",
        digest: `sha256:${"b".repeat(64)}`,
      },
      first.head,
      "2026-07-24T10:00:01Z",
    );

    expect(first.entry).toMatchObject({
      formatVersion: 1,
      revision: 1,
      previousEntryDigest: null,
    });
    expect(second.entry).toMatchObject({
      revision: 2,
      previousEntryDigest: first.head.digest,
    });
    expect((await lstat(journalEntryPath(paths, 1))).mode & 0o777).toBe(0o600);

    const replay = await replayJournal(paths);
    expect(replay.entries).toEqual([first.entry, second.entry]);
    expect(replay.head).toEqual(second.head);
  });

  test("ignores incomplete temporary transitions", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    await writeFile(join(paths.journal, ".000000000001.partial.tmp"), "{");

    await expect(replayJournal(paths)).resolves.toEqual({
      entries: [],
      head: EMPTY_JOURNAL_HEAD,
    });
  });

  test("rejects journal gaps, malformed JSON, and broken predecessor chains", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    const first = await appendJournalEntry(
      paths,
      { type: "repository-artifact-written", digest: ARTIFACT_DIGEST },
      EMPTY_JOURNAL_HEAD,
      "2026-07-24T10:00:00Z",
    );
    await appendJournalEntry(
      paths,
      {
        type: "repository-artifact-written",
        digest: `sha256:${"b".repeat(64)}`,
      },
      first.head,
      "2026-07-24T10:00:01Z",
    );

    await rename(journalEntryPath(paths, 1), join(paths.journal, "saved"));
    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "WORKSPACE_CORRUPT",
    });
    await rename(join(paths.journal, "saved"), journalEntryPath(paths, 1));

    await writeFile(journalEntryPath(paths, 1), "{");
    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "WORKSPACE_CORRUPT",
    });

    await writeFile(
      journalEntryPath(paths, 1),
      `${JSON.stringify({
        ...first.entry,
        committedAt: "changed",
      })}\n`,
    );
    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "WORKSPACE_CORRUPT",
    });
  });

  test("rejects unsupported journal versions", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    await writeFile(
      journalEntryPath(paths, 1),
      `${JSON.stringify({
        formatVersion: 2,
        revision: 1,
        previousEntryDigest: null,
        committedAt: "2026-07-24T10:00:00Z",
        event: {
          type: "repository-artifact-written",
          digest: ARTIFACT_DIGEST,
        },
      })}\n`,
    );

    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "WORKSPACE_VERSION_UNSUPPORTED",
    });
  });

  test("rejects a malformed event payload during replay", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    await writeFile(
      journalEntryPath(paths, 1),
      `${JSON.stringify({
        formatVersion: 1,
        revision: 1,
        previousEntryDigest: null,
        committedAt: "2026-07-24T10:00:00Z",
        event: {
          type: "initialized",
          declarationFingerprint: `sha256:${"1".repeat(64)}`,
        },
      })}\n`,
    );

    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "WORKSPACE_CORRUPT",
    });
  });

  test("rejects malformed nested capture payloads before state dereference", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    await appendJournalEntry(
      paths,
      {
        type: "initialized",
        recording: {
          executionId: EXECUTION_ID,
        },
        declarationFingerprint: `sha256:${"1".repeat(64)}`,
      } as never,
      EMPTY_JOURNAL_HEAD,
      "2026-07-24T10:00:00Z",
    );

    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "WORKSPACE_CORRUPT",
    });
  });

  test.each([
    [
      "startedAt",
      (event: ReturnType<typeof initializedEvent>) => ({
        ...event,
        recording: { ...event.recording, startedAt: "not-a-timestamp" },
      }),
    ],
    [
      "record metadata",
      (event: ReturnType<typeof initializedEvent>) => ({
        ...event,
        recording: {
          ...event.recording,
          record: { ...event.recording.record, name: "" },
        },
      }),
    ],
    [
      "artifact entity id",
      (event: ReturnType<typeof initializedEvent>) => ({
        ...event,
        recording: {
          ...event.recording,
          task: { ...event.recording.task, entityId: "../escape" },
        },
      }),
    ],
    [
      "capture origin",
      (event: ReturnType<typeof initializedEvent>) => ({
        ...event,
        recording: {
          ...event.recording,
          task: {
            ...event.recording.task,
            origin: { ...ORIGIN, observer: "relative" },
          },
        },
      }),
    ],
    [
      "executor",
      (event: ReturnType<typeof initializedEvent>) => ({
        ...event,
        recording: {
          ...event.recording,
          executor: { ...event.recording.executor, name: "" },
        },
      }),
    ],
    [
      "recursive artifact metadata",
      (event: ReturnType<typeof initializedEvent>) => ({
        ...event,
        recording: {
          ...event.recording,
          runtime: {
            ...event.recording.runtime,
            components: [
              {
                kind: "controlled",
                artifact: {
                  kind: "file",
                  entityId: "runtime/runner.mjs",
                  origin: ORIGIN,
                  source: {
                    ...PERSISTED_SOURCE,
                    mediaType: "",
                  },
                },
              },
            ],
          },
        },
      }),
    ],
    [
      "repository-state aggregate shape",
      (event: ReturnType<typeof initializedEvent>) => ({
        ...event,
        recording: {
          ...event.recording,
          repositoryState: {
            artifact: {
              kind: "file",
              entityId: "repository/state.json",
              source: {
                ...PERSISTED_SOURCE,
                mediaType: "application/json",
              },
              origin: ORIGIN,
            },
          },
        },
      }),
    ],
    [
      "producer",
      (event: ReturnType<typeof initializedEvent>) => ({
        ...event,
        recording: {
          ...event.recording,
          producer: { ...event.recording.producer, entityId: "relative" },
        },
      }),
    ],
  ])("rejects invalid persisted %s fields", async (_name, mutate) => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    await appendJournalEntry(
      paths,
      mutate(initializedEvent()) as never,
      EMPTY_JOURNAL_HEAD,
      "2026-07-24T10:00:00Z",
    );

    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "WORKSPACE_CORRUPT",
    });
  });

  test.each([
    [
      "resource observation",
      {
        type: "runtime-observation-captured",
        observation: {
          kind: "resource",
          entityId: "observations/tokens",
          name: "",
          value: { invalid: true },
          origin: ORIGIN,
        },
        declarationFingerprint: `sha256:${"2".repeat(64)}`,
      },
    ],
    [
      "trace format",
      {
        type: "native-trace-attached",
        trace: {
          artifact: {
            kind: "file",
            entityId: "trace/trace.json",
            source: PERSISTED_SOURCE,
            origin: ORIGIN,
          },
          format: { entityId: "relative" },
        },
        declarationFingerprint: `sha256:${"3".repeat(64)}`,
      },
    ],
    [
      "final receipt",
      {
        type: "finalized",
        receipt: {
          executionId: EXECUTION_ID,
          record: {
            family: "execution-evidence",
            digest: ARTIFACT_DIGEST,
          },
          artifacts: [{ digest: ARTIFACT_DIGEST }],
          finalizedAt: "not-a-timestamp",
        },
      },
    ],
  ])("rejects invalid persisted %s semantics", async (_name, event) => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    await appendJournalEntry(
      paths,
      event as never,
      EMPTY_JOURNAL_HEAD,
      "2026-07-24T10:00:00Z",
    );

    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "WORKSPACE_CORRUPT",
    });
  });

  test("rejects stale and concurrently racing writers", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    const first = await appendJournalEntry(
      paths,
      { type: "repository-artifact-written", digest: ARTIFACT_DIGEST },
      EMPTY_JOURNAL_HEAD,
      "2026-07-24T10:00:00Z",
    );

    await expect(
      appendJournalEntry(
        paths,
        {
          type: "repository-artifact-written",
          digest: `sha256:${"b".repeat(64)}`,
        },
        EMPTY_JOURNAL_HEAD,
        "2026-07-24T10:00:01Z",
      ),
    ).rejects.toMatchObject({ code: "RECORDING_CONFLICT" });

    const attempts = await Promise.allSettled([
      appendJournalEntry(
        paths,
        {
          type: "repository-artifact-written",
          digest: `sha256:${"c".repeat(64)}`,
        },
        first.head,
        "2026-07-24T10:00:02Z",
      ),
      appendJournalEntry(
        paths,
        {
          type: "repository-artifact-written",
          digest: `sha256:${"d".repeat(64)}`,
        },
        first.head,
        "2026-07-24T10:00:02Z",
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "RECORDING_CONFLICT" }),
      }),
    ]);
  });

  test("rejects symlinked journal entries and cancellation", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    const outside = join(paths.root, "outside");
    await writeFile(outside, "{}");
    await symlink(outside, journalEntryPath(paths, 1));

    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });

    await rm(journalEntryPath(paths, 1));
    const controller = new AbortController();
    controller.abort();
    await expect(
      appendJournalEntry(
        paths,
        { type: "repository-artifact-written", digest: ARTIFACT_DIGEST },
        EMPTY_JOURNAL_HEAD,
        "2026-07-24T10:00:00Z",
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });

  test("rejects a workspace root replaced by a symbolic link before replay", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    const moved = `${paths.root}-moved`;
    await rename(paths.root, moved);
    await symlink(moved, paths.root);

    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  test("rejects a journal directory replaced by a symbolic link before replay", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    const moved = join(paths.root, "journal-moved");
    await rename(paths.journal, moved);
    await symlink(moved, paths.journal);

    await expect(replayJournal(paths)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  test("does not publish through a journal directory symbolic link", async () => {
    await initializeWorkspaceMarker(paths, EXECUTION_ID);
    const moved = join(paths.root, "journal-moved");
    await rename(paths.journal, moved);
    await symlink(moved, paths.journal);

    await expect(
      appendJournalEntry(
        paths,
        { type: "repository-artifact-written", digest: ARTIFACT_DIGEST },
        EMPTY_JOURNAL_HEAD,
        "2026-07-24T10:00:00Z",
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(moved)).toEqual([]);
  });
});
