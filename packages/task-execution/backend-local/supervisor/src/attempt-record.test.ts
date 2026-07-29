// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { foldAttemptRecord } from "./attempt-record.js";
import type { JournalEvent } from "./journal-types.js";

function event(partial: Partial<JournalEvent> & Pick<JournalEvent, "attemptId" | "seq" | "type">): JournalEvent {
  return { time: "2026-07-28T00:00:00.000Z", details: {}, ...partial };
}

describe("foldAttemptRecord", () => {
  it("folds a happy-path journal into a terminal, non-contradictory record with identity + phase timestamps", () => {
    const events: JournalEvent[] = [
      event({ attemptId: "a1", seq: 1, type: "attempt-engaged", details: { attempt: "urn:uuid:00000000-0000-0000-0000-000000000101", submission: "urn:uuid:00000000-0000-0000-0000-0000000000f1", taskDigest: "sha256:aa" } }),
      event({ attemptId: "a1", seq: 2, type: "spawn-intended", details: { launchPlanDigest: "sha256:bb", nonce: "n1" } }),
      event({ attemptId: "a1", seq: 3, type: "spawned", details: { nonce: "n1", pid: 4242, startTime: 111 } }),
      event({ attemptId: "a1", seq: 4, type: "attempt-terminal", details: { state: "delivered", exitCode: 0, termSignal: null }, failsAttempt: false }),
    ];
    const record = foldAttemptRecord(events);
    expect(record.attemptUri).toBe("urn:uuid:00000000-0000-0000-0000-000000000101");
    expect(record.nonce).toBe("n1");
    expect(record.taskDigest).toBe("sha256:aa");
    expect(record.submissionUri).toBe("urn:uuid:00000000-0000-0000-0000-0000000000f1");
    expect(record.phase).toBe("terminal");
    expect(record.terminal).toBe(true);
    expect(record.terminalState).toBe("delivered");
    expect(record.contradictory).toBe(false);
    expect(record.outcome?.exitCode).toBe(0);
    expect(record.executor.shimFingerprint).toEqual({ pid: 4242, startTime: 111 });
    expect(record.executor.launchPlanDigest).toBe("sha256:bb");
    expect(record.phaseTimestamps.created).toBe("2026-07-28T00:00:00.000Z");
  });

  it("derives phase progression: engaged -> spawn-intended -> running", () => {
    expect(foldAttemptRecord([event({ attemptId: "a1", seq: 1, type: "attempt-engaged" })]).phase).toBe("engaged");
    expect(foldAttemptRecord([
      event({ attemptId: "a1", seq: 1, type: "attempt-engaged" }),
      event({ attemptId: "a1", seq: 2, type: "spawn-intended", details: { nonce: "n1" } }),
    ]).phase).toBe("spawn-intended");
    expect(foldAttemptRecord([
      event({ attemptId: "a1", seq: 1, type: "attempt-engaged" }),
      event({ attemptId: "a1", seq: 2, type: "spawn-intended", details: { nonce: "n1" } }),
      event({ attemptId: "a1", seq: 3, type: "spawned", details: { nonce: "n1", pid: 1, startTime: 1 } }),
    ]).phase).toBe("running");
  });

  it("derives harvesting and recording phases from exec-finished/harvested markers", () => {
    const base: JournalEvent[] = [
      event({ attemptId: "a1", seq: 1, type: "attempt-engaged" }),
      event({ attemptId: "a1", seq: 2, type: "spawned", details: { nonce: "n1", pid: 1, startTime: 1 } }),
      event({ attemptId: "a1", seq: 3, type: "exec-finished", details: { exitCode: 0 } }),
    ];
    expect(foldAttemptRecord(base).phase).toBe("harvesting");
    expect(foldAttemptRecord([...base, event({ attemptId: "a1", seq: 4, type: "harvested", details: {} })]).phase).toBe("recording");
  });

  it("marks contradictory=true when a rejected second terminal is present, but the first terminal's state stands", () => {
    const events: JournalEvent[] = [
      event({ attemptId: "a1", seq: 1, type: "spawned", details: { nonce: "n1", pid: 1, startTime: 1 } }),
      event({ attemptId: "a1", seq: 2, type: "attempt-terminal", details: { state: "delivered", exitCode: 0 } }),
      event({ attemptId: "a1", seq: 3, type: "attempt-terminal", details: { state: "failed", blame: "infrastructure" }, rejectedAtAppend: true }),
    ];
    const record = foldAttemptRecord(events);
    expect(record.contradictory).toBe(true);
    expect(record.terminalState).toBe("delivered");
  });

  it("folds harvest results into the outputs manifest, omissions, and integrity violations", () => {
    const record = foldAttemptRecord(
      [event({ attemptId: "a1", seq: 1, type: "attempt-engaged" })],
      {
        manifest: [{ path: "out/result.txt", sizeBytes: 12, sha256: "sha256:cc" }],
        omissions: ["out/missing.txt"],
        integrityViolations: [{ path: "out/evil", reason: "symlink escapes out/" }],
      },
    );
    expect(record.outputsManifest).toHaveLength(1);
    expect(record.omissions).toEqual(["out/missing.txt"]);
    expect(record.integrityViolations).toEqual([{ path: "out/evil", reason: "symlink escapes out/" }]);
  });

  it("sorts events by seq before folding regardless of input order", () => {
    const events: JournalEvent[] = [
      event({ attemptId: "a1", seq: 2, type: "spawned", details: { nonce: "n1", pid: 1, startTime: 1 } }),
      event({ attemptId: "a1", seq: 1, type: "attempt-engaged" }),
    ];
    expect(foldAttemptRecord(events).events.map((e) => e.seq)).toEqual([1, 2]);
  });
});
