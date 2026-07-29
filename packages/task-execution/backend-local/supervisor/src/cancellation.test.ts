// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runCancellationLadder } from "./cancellation.js";

describe("runCancellationLadder", () => {
  it("does not use cancellation as the outcome channel when a natural success races ahead", async () => {
    const result = await runCancellationLadder({ terminalState: undefined }, {
      signalTerm: vi.fn(), signalKill: vi.fn(), isSubtreeEmpty: vi.fn(() => true),
      readOutcome: vi.fn(() => ({ exitCode: 0, termSignal: null })), harvest: vi.fn(),
      sleep: vi.fn(async () => undefined),
    });
    expect(result).toMatchObject({ requested: true, terminalState: "delivered", outcome: { exitCode: 0, termSignal: null } });
  });

  it("bounds an unkillable subtree and records residual PIDs as infrastructure failure", async () => {
    const result = await runCancellationLadder({}, {
      signalTerm: vi.fn(), signalKill: vi.fn(), isSubtreeEmpty: vi.fn(() => false),
      readOutcome: vi.fn(() => null), harvest: vi.fn(), listPids: vi.fn(() => [9999]),
      sleep: vi.fn(async () => undefined),
    }, { graceMs: 0, killPollCeilingMs: 0 });
    expect(result).toMatchObject({ terminalState: "failed", blame: "infrastructure", residualPids: [9999] });
  });

  it("acknowledges an already terminal attempt idempotently", async () => {
    const result = await runCancellationLadder({ terminalState: "delivered" }, {
      signalTerm: vi.fn(), signalKill: vi.fn(), isSubtreeEmpty: vi.fn(() => true), readOutcome: vi.fn(() => null), harvest: vi.fn(),
    });
    expect(result).toEqual({ requested: false, terminalState: "delivered" });
  });

  it("does not signal the harness twice when cancellation is already requested", async () => {
    const signalTerm = vi.fn();
    const signalKill = vi.fn();
    let now = 0;
    const result = await runCancellationLadder({ cancellationRequested: true }, {
      signalTerm, signalKill, isSubtreeEmpty: vi.fn(() => false), readOutcome: vi.fn(() => null), harvest: vi.fn(),
      sleep: () => { now += 25; },
    }, { graceMs: 0, killPollCeilingMs: 25, nowMs: () => now });
    expect(result).toEqual({ requested: false, terminalState: "cancelling" });
    expect(signalTerm).not.toHaveBeenCalled();
    expect(signalKill).not.toHaveBeenCalled();
  });

  it("records a cancellation signal as cancelled while preserving harvest", async () => {
    const harvest = vi.fn();
    const result = await runCancellationLadder({}, {
      signalTerm: vi.fn(), signalKill: vi.fn(), isSubtreeEmpty: vi.fn(() => true),
      readOutcome: vi.fn(() => ({ exitCode: null, termSignal: "SIGTERM" })), harvest,
    });
    expect(result).toMatchObject({ requested: true, terminalState: "cancelled", outcome: { exitCode: null, termSignal: "SIGTERM" } });
    expect(harvest).toHaveBeenCalledOnce();
  });
});
