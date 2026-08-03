// SPDX-License-Identifier: MIT

import { itemTaskDigest } from "@jinn-network/benchmarking-records";
import type { AttemptWaitPort } from "@jinn-network/benchmarking-run";
import { createInMemoryBackend, type TestableBackend } from "@jinn-network/task-execution-testing";
import { describe, expect, test } from "vitest";
import { decideAllocation } from "./allocation.js";
import { PolicyOptimizationError } from "./errors.js";
import { assembleWaveMatrix, executeWave } from "./execute.js";
import {
  CANDIDATE,
  PARENT,
  benchmarkFor,
  campaignFor,
  runSettings,
  tasksFor,
} from "./testing/wave-fixtures.js";
import { NO_CELLS_COMMITTED, type WaveRunSettings } from "./wave-types.js";
import { planWave } from "./wave.js";

const DEV_TASKS = tasksFor(["exec alpha", "exec beta"]);
const DEV = benchmarkFor({ name: "exec slate", tasks: DEV_TASKS, reveal: { policy: "immediate" } });
const GATE = benchmarkFor({
  name: "exec gate",
  tasks: tasksFor(["exec gate one"]),
  reveal: { policy: "after-run" },
});
const CAMPAIGN = campaignFor({
  developmentBenchmark: DEV.digest,
  promotionBenchmark: GATE.digest,
  seeds: [PARENT],
  allocation: { policyRef: "uniform/1.0", parameters: {} },
});
const CAMPAIGN_DIGEST = `sha256:${"c".repeat(64)}`;
const TASK_BYTES = new Map(DEV_TASKS.map((task) => [task.digest, task.bytes] as const));
const CLOCK = { now: () => new Date("2026-08-04T09:00:00Z") };

function plan(settings: Partial<WaveRunSettings> = {}) {
  return planWave({
    campaign: CAMPAIGN,
    campaignDigest: CAMPAIGN_DIGEST,
    waveNumber: 1,
    candidates: [PARENT, CANDIDATE],
    allocation: decideAllocation({
      campaign: CAMPAIGN,
      waveNumber: 1,
      population: [PARENT, CANDIDATE],
      taskDigests: DEV.record.items.map(itemTaskDigest),
    }),
    developmentBenchmarkBytes: DEV.bytes,
    settings: runSettings(settings),
    committed: NO_CELLS_COMMITTED,
  });
}

function backend(): TestableBackend {
  return createInMemoryBackend({
    now: CLOCK.now,
    runPinning: [
      { key: "harness", inventory: ["*"], posture: "enforced" },
      { key: "model", inventory: ["*"], posture: "enforced" },
      { key: "loadout", inventory: ["*"], posture: "enforced" },
      { key: "isolationPolicy", inventory: ["*"], posture: "enforced" },
    ],
  });
}

function deliveringWaitPort(instance: TestableBackend): AttemptWaitPort {
  return {
    async waitUntilTerminal({ attempt }) {
      const snapshot = await instance.observe(attempt as never);
      if (snapshot.descriptor.derived.terminal) return snapshot;
      const engaged = snapshot.observations.find(
        (observation) => observation.type === "network.jinn.task-execution.attempt-engaged.v1",
      )!;
      await instance.drive(attempt as never, [{
        specversion: "1.0",
        id: `terminal-${attempt}`,
        source: engaged.source,
        subject: attempt,
        time: CLOCK.now().toISOString(),
        datacontenttype: "application/json",
        sequence: "0000000000000100",
        type: "network.jinn.task-execution.attempt-terminal.v1",
        data: { state: "delivered" },
      }]);
      return instance.observe(attempt as never);
    },
  };
}

const EMPTY_EVIDENCE = { evidenceFor: () => undefined };
const VENUE = { isolationInventory: ["unrestricted"] };

async function category(build: () => Promise<unknown>): Promise<string> {
  try {
    await build();
  } catch (error) {
    if (error instanceof PolicyOptimizationError) return error.category;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("dispatch accounting is total over the expected cell set, not over the events", () => {
  test("every expected cell gets exactly one account, ordered by cellKey", async () => {
    const wave = plan();
    const instance = backend();
    const execution = await executeWave({
      plan: wave,
      backend: instance,
      taskBytesFor: (digest) => TASK_BYTES.get(digest)!,
      launch: { clock: CLOCK, waitForTerminal: deliveringWaitPort(instance) },
    });
    expect(execution.dispatches).toHaveLength(wave.cells);
    expect(execution.dispatches.map((entry) => entry.cellKey))
      .toEqual([...execution.dispatches.map((entry) => entry.cellKey)].sort());
    for (const dispatch of execution.dispatches) {
      expect(dispatch.dispatches, dispatch.cellKey).toBe(1);
      expect(dispatch.attempt, dispatch.cellKey).toBeDefined();
      expect(dispatch.terminal, dispatch.cellKey).toBe("delivered");
    }
    expect(execution.cancelled).toBe(false);
  });

  test("a Run past its close boundary dispatches nothing and still assembles every cell", async () => {
    // The join must not shrink the denominator: a cell nobody reached is expired, not absent.
    const wave = plan({ closeAt: "2026-08-04T08:00:00Z" });
    const instance = backend();
    const execution = await executeWave({
      plan: wave,
      backend: instance,
      taskBytesFor: (digest) => TASK_BYTES.get(digest)!,
      launch: { clock: CLOCK, waitForTerminal: deliveringWaitPort(instance) },
    });
    expect(execution.dispatches).toHaveLength(wave.cells);
    expect(execution.dispatches.every((entry) => entry.dispatches === 0)).toBe(true);

    const matrix = await assembleWaveMatrix({
      plan: wave,
      execution,
      evidence: EMPTY_EVIDENCE,
      venue: VENUE,
    });
    expect(matrix.record.cells).toHaveLength(wave.cells);
    for (const cell of matrix.record.cells) {
      expect(cell.outcome, cell.cellKey).toBe("expired");
      // Nothing executed, so not even the vacuous isolation axis can be said to have been honored.
      expect(cell.verification, cell.cellKey).toEqual({
        harness: "unverifiable",
        model: "unverifiable",
        loadout: "unverifiable",
        isolation: "unverifiable",
        checksFailed: [],
      });
    }
  });

  test("an owner early-close marks the Matrix cancelled rather than partial", async () => {
    const wave = plan();
    const instance = backend();
    const execution = await executeWave({
      plan: wave,
      backend: instance,
      taskBytesFor: (digest) => TASK_BYTES.get(digest)!,
      launch: { clock: CLOCK, earlyClose: true, waitForTerminal: deliveringWaitPort(instance) },
    });
    expect(execution.cancelled).toBe(true);
    const matrix = await assembleWaveMatrix({
      plan: wave,
      execution,
      evidence: EMPTY_EVIDENCE,
      venue: VENUE,
    });
    expect(matrix.record.completeness.runOutcome).toBe("cancelled");
  });
});

describe("assembly refuses what it cannot honestly answer", () => {
  test("assembling one wave's execution against another wave's plan is refused", async () => {
    const wave = plan();
    const other = plan({ closeAt: "2026-09-02T00:00:00Z" });
    const instance = backend();
    const execution = await executeWave({
      plan: other,
      backend: instance,
      taskBytesFor: (digest) => TASK_BYTES.get(digest)!,
      launch: { clock: CLOCK, waitForTerminal: deliveringWaitPort(instance) },
    });
    expect(await category(() => assembleWaveMatrix({
      plan: wave,
      execution,
      evidence: EMPTY_EVIDENCE,
      venue: VENUE,
    }))).toBe("wave-composition");
  });

  test("a venue that declares no isolation inventory is refused, never defaulted", async () => {
    const wave = plan();
    const instance = backend();
    const execution = await executeWave({
      plan: wave,
      backend: instance,
      taskBytesFor: (digest) => TASK_BYTES.get(digest)!,
      launch: { clock: CLOCK, waitForTerminal: deliveringWaitPort(instance) },
    });
    expect(await category(() => assembleWaveMatrix({
      plan: wave,
      execution,
      evidence: EMPTY_EVIDENCE,
      venue: { isolationInventory: [] },
    }))).toBe("wave-composition");
  });

  test("a dispatched cell with no fidelity evidence reports unverifiable, never a free match", async () => {
    const wave = plan();
    const instance = backend();
    const execution = await executeWave({
      plan: wave,
      backend: instance,
      taskBytesFor: (digest) => TASK_BYTES.get(digest)!,
      launch: { clock: CLOCK, waitForTerminal: deliveringWaitPort(instance) },
    });
    const matrix = await assembleWaveMatrix({
      plan: wave,
      execution,
      evidence: EMPTY_EVIDENCE,
      venue: VENUE,
    });
    for (const cell of matrix.record.cells) {
      expect(cell.verification.harness, cell.cellKey).toBe("unverifiable");
      expect(cell.verification.loadout, cell.cellKey).toBe("unverifiable");
      // Isolation stays vacuously matched: something did run, and the venue admits one policy.
      expect(cell.verification.isolation, cell.cellKey).toBe("match");
      // `expired`, not `unjudged`: a cell is "delivered" to assembly by its Delivery digest, which
      // the venue's evidence supplies. A dispatch the loop watched to a terminal is not by itself
      // a delivery, and the join does not promote one into the other.
      expect(cell.outcome, cell.cellKey).toBe("expired");
    }
  });
});
