import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ObservationSnapshot } from "@jinn-network/task-execution-backend";
import { readRunJournalEntries } from "./journal.js";
import { createProductLaunchCapture } from "./publication-capture.js";
import { sha256Hex } from "../workspace/sealed-store.js";

let workspaceDir: string;
const bytes = new TextEncoder().encode('{"submission":"urn:uuid:00000000-0000-5000-8000-000000000001"}');
const snapshot: ObservationSnapshot = {
  descriptor: {
    attempt: "urn:uuid:00000000-0000-5000-8000-000000000002",
    task: `sha256:${"a".repeat(64)}`,
    submission: "urn:uuid:00000000-0000-5000-8000-000000000001",
    derived: { state: "claimed", terminal: false, contradictory: false, cancelRequested: false, executionIds: [], deliveries: [] },
  },
  cursor: { sequence: "0" },
  observations: [],
};

beforeEach(() => { workspaceDir = mkdtempSync(join(tmpdir(), "pub09-capture-")); });
afterEach(() => { rmSync(workspaceDir, { recursive: true, force: true }); });

describe("createProductLaunchCapture", () => {
  test("persists exact Submission before acceptance and seals an accepted snapshot archive", () => {
    const capture = createProductLaunchCapture({ workspaceDir, draftId: "draft-1", liveClock: () => "2026-08-13T00:00:00Z" });
    const input = { runDigest: `sha256:${"f".repeat(64)}` as const, cellKey: `${"a".repeat(64)}/arm-a/1`, armId: "arm-a", replicate: 1, dispatch: 1 };
    capture.captureSubmission({ ...input, bytes });
    // Use the digest the capture stored rather than a backend-provided made-up acknowledgement.
    const digest = sha256Hex(bytes);
    capture.captureObservation({ ...input, submission: "urn:uuid:00000000-0000-5000-8000-000000000001", submissionDigest: `sha256:${digest}`, snapshot });

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries.map((entry) => entry.kind)).toEqual(["submission-captured", "submission-accepted", "observation-accepted"]);
    expect(entries[2]).toMatchObject({ kind: "observation-accepted", dispatch: 1, attempt: snapshot.descriptor.attempt });
  });

  test("refuses an acknowledgement whose digest differs from the pre-submit capture", () => {
    const capture = createProductLaunchCapture({ workspaceDir, draftId: "draft-1", liveClock: () => "2026-08-13T00:00:00Z" });
    const input = { runDigest: `sha256:${"f".repeat(64)}` as const, cellKey: `${"a".repeat(64)}/arm-a/1`, armId: "arm-a", replicate: 1, dispatch: 1 };
    capture.captureSubmission({ ...input, bytes });
    expect(() => capture.captureObservation({ ...input, submission: "urn:uuid:00000000-0000-5000-8000-000000000001", submissionDigest: `sha256:${"c".repeat(64)}`, snapshot })).toThrow(/does not match/);
  });
});
