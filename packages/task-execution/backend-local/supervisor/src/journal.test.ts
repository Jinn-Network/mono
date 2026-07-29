// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JournalCorruptionError, JournalTerminalRejectedError, openAttemptJournal, openSubmissionSegment,
} from "./journal.js";

const tempDirs: string[] = [];
function tempMetaDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jinn-supervisor-journal-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("openAttemptJournal", () => {
  it("assigns durable seq starting at 1 and increments per append", () => {
    const journal = openAttemptJournal(tempMetaDir());
    const e1 = journal.append({ attemptId: "a1", type: "attempt-engaged", details: {} });
    const e2 = journal.append({ attemptId: "a1", type: "spawn-intended", details: { nonce: "n1" } });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(journal.durableSeq()).toBe(3);
  });

  it("read() returns intact events in append order", () => {
    const journal = openAttemptJournal(tempMetaDir());
    journal.append({ attemptId: "a1", type: "attempt-engaged", details: {} });
    journal.append({ attemptId: "a1", type: "spawned", details: { nonce: "n1", pid: 1, startTime: 1 } });
    const events = journal.read();
    expect(events.map((e) => e.type)).toEqual(["attempt-engaged", "spawned"]);
  });

  it("durableSeq resumes from max(intact seq)+1 after a torn tail, never trusting the torn record's claimed seq", () => {
    const metaDir = tempMetaDir();
    const journal = openAttemptJournal(metaDir);
    journal.append({ attemptId: "a1", type: "attempt-engaged", details: {} });
    journal.append({ attemptId: "a1", type: "spawn-intended", details: { nonce: "n1" } });
    // Simulate a crash mid-write of the third record: a trailing line with no closing brace.
    const path = join(metaDir, "journal.jsonl");
    const existing = readFileSync(path, "utf8");
    writeFileSync(path, `${existing}{"attemptId":"a1","seq":3,"type":"spa`);

    expect(journal.durableSeq()).toBe(3);
    expect(journal.read()).toHaveLength(2);

    const resumed = journal.append({ attemptId: "a1", type: "spawned", details: { nonce: "n1", pid: 1, startTime: 1 } });
    expect(resumed.seq).toBe(3); // reuses the seq the torn record falsely claimed
  });

  it("throws JournalCorruptionError on a non-trailing malformed record", () => {
    const metaDir = tempMetaDir();
    const path = join(metaDir, "journal.jsonl");
    writeFileSync(path, `{"attemptId":"a1","seq":1,"broken\n{"attemptId":"a1","seq":2,"type":"spawned","time":"2026-01-01T00:00:00.000Z","details":{}}\n`);
    const journal = openAttemptJournal(metaDir);
    expect(() => journal.read()).toThrow(JournalCorruptionError);
  });

  it("per-nonce terminal uniqueness: a second non-lost terminal is rejected, durably flagged, and the first stands", () => {
    const journal = openAttemptJournal(tempMetaDir());
    journal.append({ attemptId: "a1", type: "spawned", details: { nonce: "n1", pid: 1, startTime: 1 } });
    const first = journal.append({
      attemptId: "a1", type: "attempt-terminal", details: { state: "delivered", nonce: "n1" }, failsAttempt: false,
    });
    expect(first.rejectedAtAppend).toBeUndefined();

    expect(() => journal.append({
      attemptId: "a1", type: "attempt-terminal", details: { state: "failed", blame: "infrastructure", nonce: "n1" }, failsAttempt: false,
    })).toThrow(JournalTerminalRejectedError);

    const events = journal.read();
    expect(events).toHaveLength(3); // the rejected terminal is STILL durably recorded
    expect(events[2]!.rejectedAtAppend).toBe(true);
    expect(events[2]!.details.state).toBe("failed");
    // the first terminal by seq remains the one an authoritative fold would honor
    expect(events[1]!.details.state).toBe("delivered");
  });

  it("lost-correction exception: a corrective terminal after a prior `lost` terminal is accepted with no flag", () => {
    const journal = openAttemptJournal(tempMetaDir());
    journal.append({ attemptId: "a1", type: "spawn-intended", details: { nonce: "n1" } });
    const lost = journal.append({
      attemptId: "a1", type: "attempt-terminal", details: { state: "lost", blame: "infrastructure" }, failsAttempt: true,
    });
    expect(lost.rejectedAtAppend).toBeUndefined();

    const corrected = journal.append({
      attemptId: "a1", type: "attempt-terminal", details: { state: "delivered", nonce: "n1" }, failsAttempt: false,
    });
    expect(corrected.rejectedAtAppend).toBeUndefined();
    expect(journal.read()).toHaveLength(3);
  });

  it("refuses a spawn record whose nonce is already live under another attempt (injected isNonceLive)", () => {
    const journal = openAttemptJournal(tempMetaDir(), { isNonceLive: (nonce) => nonce === "collision" });
    expect(() => journal.append({ attemptId: "a1", type: "spawned", details: { nonce: "collision", pid: 1, startTime: 1 } }))
      .toThrow(/nonce/i);
  });

  it("fsyncedAppend is the same durable operation as append", () => {
    const journal = openAttemptJournal(tempMetaDir());
    const event = journal.fsyncedAppend({ attemptId: "a1", type: "attempt-engaged", details: {} });
    expect(event.seq).toBe(1);
    expect(journal.read()).toHaveLength(1);
  });

  it("fsyncs the journal record before emitting its projected observation", () => {
    const metaDir = tempMetaDir();
    const journal = openAttemptJournal(metaDir);
    let eventWasDurable = false;
    journal.appendAndEmit({ attemptId: "a1", type: "attempt-engaged", details: {} }, (event) => {
      eventWasDurable = journal.read().some((stored) => stored.seq === event.seq);
    });
    expect(eventWasDurable).toBe(true);
  });
});

describe("openSubmissionSegment", () => {
  it("a never-seen submission has an empty segment", () => {
    const segment = openSubmissionSegment(tempMetaDir());
    expect(segment.read()).toHaveLength(0);
  });

  it("a rejected submission stays durably rejected and distinguishable from never-seen, across re-open (restart)", () => {
    const dir = tempMetaDir();
    const segment = openSubmissionSegment(dir);
    segment.append({
      submission: "urn:uuid:00000000-0000-0000-0000-0000000000f9",
      type: "submission-rejected",
      details: { category: "unsupported-requirement" },
    });
    expect(segment.read()).toHaveLength(1);

    const reopened = openSubmissionSegment(dir); // simulates restart: fresh in-memory instance, same durable dir
    const events = reopened.read();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("submission-rejected");
  });

  it("appends are durable on disk immediately (fsynced)", () => {
    const dir = tempMetaDir();
    const segment = openSubmissionSegment(dir);
    segment.append({ submission: "urn:uuid:00000000-0000-0000-0000-0000000000fa", type: "submission-accepted", details: {} });
    expect(existsSync(join(dir, "submission.jsonl"))).toBe(true);
  });
});
