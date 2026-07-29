// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { foldAttemptRecord } from "./attempt-record.js";
import { reconcileAttempt } from "./reconciler.js";
import type { JournalEvent } from "./journal-types.js";

const event = (type: JournalEvent["type"], seq: number): JournalEvent => ({
  attemptId: "a1", seq, type, time: "2026-07-28T00:00:00.000Z", details: {},
});

describe("reconcileAttempt", () => {
  it("rejects an engaged attempt with no spawn intent because it never executed", () => {
    const result = reconcileAttempt(foldAttemptRecord([event("attempt-engaged", 1)]), {
      processAlive: false, shimAlive: false, outcomePresent: false,
    });
    expect(result).toMatchObject({ classification: "absent-never-executed", action: "rejected", terminalState: "rejected" });
  });

  it("marks a spawn intent without reality as infrastructure-lost", () => {
    const result = reconcileAttempt(foldAttemptRecord([event("spawn-intended", 1)]), {
      processAlive: false, shimAlive: false, outcomePresent: false,
    });
    expect(result).toMatchObject({ classification: "absent", action: "lost", terminalState: "lost", blame: "infrastructure" });
  });

  it("kills an orphaned live group under a dead shim before marking it lost", () => {
    const result = reconcileAttempt(foldAttemptRecord([event("spawned", 1)]), {
      processAlive: true, shimAlive: false, outcomePresent: false, pids: [12, 13],
    });
    expect(result).toMatchObject({ classification: "orphaned", action: "kill-ladder-then-lost", terminalState: "lost", killedPids: [12, 13] });
  });

  it("ignores a nonce-mismatched outcome as stale foreign state", () => {
    const result = reconcileAttempt(foldAttemptRecord([event("spawned", 1)]), {
      processAlive: false, shimAlive: false, outcomePresent: true, nonceMatches: false,
    });
    expect(result).toMatchObject({ classification: "stale-foreign", action: "ignore-outcome-file" });
  });
});
