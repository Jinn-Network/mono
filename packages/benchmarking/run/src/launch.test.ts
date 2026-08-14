import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  documentDigest,
  expectedCellSet,
  parseBenchmark,
  parseRun,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import type { ObservationCursor, TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import type { TestableBackend } from "@jinn-network/task-execution-testing";
import { createInMemoryBackend } from "@jinn-network/task-execution-testing";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import { CellCorrespondenceError } from "./checks.js";
import {
  computeCellDeadline,
  defaultClassifyTerminal,
  launchAndWatch,
  resumeRun,
  type AttemptWaitPort,
  type LaunchOptions,
} from "./launch.js";

async function loadMiniature(name: string): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(
      fileURLToPath(
        new URL(`../../testing/fixtures/miniature-run/${name}`, import.meta.url),
      ),
    ),
  );
}

async function miniatureContext() {
  const [benchmarkBytes, runBytes, tasksBytes] = await Promise.all([
    loadMiniature("benchmark.json"),
    loadMiniature("run.json"),
    loadMiniature("tasks.json"),
  ]);
  const bench = parseBenchmark(benchmarkBytes);
  const run = parseRun(runBytes);
  const tasks = JSON.parse(new TextDecoder().decode(tasksBytes)) as {
    digest: string;
    record: unknown;
  }[];
  return { bench, run, runDigest: documentDigest(runBytes), tasks };
}

function sealingTasks(tasks: { digest: string; record: unknown }[]) {
  return new Map(
    tasks.map((task) => {
      const bytes = sealTask(task.record);
      return [task.digest.replace(/^sha256:/, ""), bytes] as const;
    }),
  );
}

function pinningBackend(): TestableBackend {
  return createInMemoryBackend({
    now: () => new Date("2026-08-01T00:00:00Z"),
    runPinning: [
      { key: "harness", inventory: ["*"], posture: "enforced" },
      { key: "model", inventory: ["*"], posture: "enforced" },
      { key: "isolationPolicy", inventory: ["*"], posture: "enforced" },
    ],
  });
}

/** Wait port that drives the Attempt to a chosen terminal state (test host owns "timing"). */
function driveWaitPort(
  backend: TestableBackend,
  state: "delivered" | "expired" | "failed" | "cancelled" = "delivered",
): AttemptWaitPort {
  return {
    async waitUntilTerminal({ attempt }) {
      const snap = await backend.observe(attempt as never);
      if (snap.descriptor.derived.terminal) return snap;
      const engaged = snap.observations.find(
        (observation) => observation.type === "network.jinn.task-execution.attempt-engaged.v1",
      );
      if (engaged === undefined) throw new Error("missing attempt-engaged");
      await backend.drive(attempt as never, [{
        specversion: "1.0",
        id: `terminal-${attempt}`,
        source: engaged.source,
        subject: attempt,
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        sequence: "0000000000000100",
        type: "network.jinn.task-execution.attempt-terminal.v1",
        data: { state },
      }]);
      return backend.observe(attempt as never);
    },
  };
}

/**
 * Real `backend.watch` adapter: advertises watch, advances cursor, completes on terminal,
 * and exits promptly on abort (no owned timer hang).
 */
function watchingBackend(inner: TestableBackend): TestableBackend & TaskExecutionBackend {
  const backend: TestableBackend & TaskExecutionBackend = Object.create(inner);
  backend.capabilities = async () => ({
    ...(await inner.capabilities()),
    watch: true,
  });
  backend.watch = async function* (
    ref: `urn:uuid:${string}`,
    cursor?: ObservationCursor,
  ) {
    let lastSequence = cursor?.sequence ?? "0000000000000000";
    for (;;) {
      const snap = await inner.observe(ref);
      for (const observation of snap.observations) {
        if (observation.sequence > lastSequence) {
          lastSequence = observation.sequence;
          yield observation;
        }
      }
      if (snap.descriptor.derived.terminal) return;
      // Host-visible microtask yield — not a timer policy owned by launch.
      await Promise.resolve();
    }
  };
  // Proxy remaining methods to inner.
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(inner))) {
    if (key === "constructor" || key in backend) continue;
    const value = (inner as unknown as Record<string, unknown>)[key];
    if (typeof value === "function") {
      (backend as unknown as Record<string, unknown>)[key] =
        (value as (...args: unknown[]) => unknown).bind(inner);
    }
  }
  backend.submit = inner.submit.bind(inner);
  backend.observe = inner.observe.bind(inner);
  backend.drive = inner.drive.bind(inner);
  backend.recordDelivery = inner.recordDelivery.bind(inner);
  backend.cancel = inner.cancel?.bind(inner);
  backend.recover = inner.recover.bind(inner);
  backend.deliveries = inner.deliveries.bind(inner);
  backend.fetchDelivery = inner.fetchDelivery.bind(inner);
  backend.simulateReconciliation = inner.simulateReconciliation.bind(inner);
  return backend;
}

function baseOpts(
  runDigest: `sha256:${string}`,
  sealedTasks: Map<string, Uint8Array>,
  backend: TestableBackend,
  overrides: Partial<LaunchOptions> = {},
): LaunchOptions {
  return {
    runDigest,
    taskBytesFor: async (hex) => {
      const bytes = sealedTasks.get(hex);
      if (bytes === undefined) throw new Error(`missing task ${hex}`);
      return bytes;
    },
    waitForTerminal: driveWaitPort(backend, "delivered"),
    clock: { now: () => new Date("2026-08-01T00:00:00Z") },
    ...overrides,
  };
}

/**
 * Compile-time regression for the wall-clock time bomb: `clock` is REQUIRED on
 * `LaunchOptions`, so a caller that forgets it is a type error rather than a run
 * that silently reads wall-clock and detonates when a fixture instant passes.
 *
 * This is deliberately not a runtime test — once `clock` is required the fallback
 * is unreachable, so there is no behaviour left to assert. The guard lives in the
 * type system: re-optionalizing `clock` makes the `@ts-expect-error` below unused,
 * which fails `yarn typecheck`.
 */
// @ts-expect-error — `clock` is required; omitting it must not compile.
const _launchOptionsRequireClock: LaunchOptions = {
  runDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  taskBytesFor: () => new Uint8Array(),
};
void _launchOptionsRequireClock;

describe("computeCellDeadline (durationMs)", () => {
  test("clips nowMs + cellWindowMs to closeAt using calendar RFC3339 Z", () => {
    const deadline = computeCellDeadline(
      new Date("2026-08-01T00:00:00Z"),
      3_600_000,
      "2026-08-01T00:30:00Z",
    );
    expect(deadline).toBe("2026-08-01T00:30:00Z");
  });

  test("uses window end when 60_000 ms precedes closeAt", () => {
    const deadline = computeCellDeadline(
      new Date("2026-08-01T00:00:00Z"),
      60_000,
      "2026-08-04T00:00:00Z",
    );
    expect(deadline).toBe("2026-08-01T00:01:00Z");
  });

  test("3_600_000 ms window is one hour when unclipped", () => {
    const deadline = computeCellDeadline(
      new Date("2026-08-01T00:00:00Z"),
      3_600_000,
      "2026-08-04T00:00:00Z",
    );
    expect(deadline).toBe("2026-08-01T01:00:00Z");
  });
});

describe("defaultClassifyTerminal (§7.4 typed facts)", () => {
  function snap(state: string) {
    return {
      descriptor: { derived: { state, terminal: true } },
      cursor: { sequence: "1" },
      observations: [],
    } as never;
  }

  test.each([
    ["expired", true, "expired"],
    ["delivered", false, undefined],
    ["cancelled", false, undefined],
    ["failed", false, undefined],
  ] as const)("%s replaceable=%s", (state, replaceable, reason) => {
    const result = defaultClassifyTerminal({ snapshot: snap(state) });
    expect(result.replaceable).toBe(replaceable);
    expect(result.replaceableReason).toBe(reason);
  });

  test("unscorable and exclusion-hit host facts are replaceable", () => {
    expect(defaultClassifyTerminal({
      snapshot: snap("delivered"),
      hostFacts: { unscorable: true },
    })).toMatchObject({ replaceable: true, replaceableReason: "unscorable" });
    expect(defaultClassifyTerminal({
      snapshot: snap("delivered"),
      hostFacts: { exclusionHit: true },
    })).toMatchObject({ replaceable: true, replaceableReason: "exclusion-hit" });
  });
});

describe("launchAndWatch (§10.1 op 4 / §7.4)", () => {
  test("rejects a tightened requirements map before dispatch (cell-correspondence)", async () => {
    const { bench, run, runDigest } = await miniatureContext();
    const backend = pinningBackend();
    await expect(async () => {
      for await (const _ of launchAndWatch(bench, run, backend, {
        runDigest,
        taskBytesFor: async () => new Uint8Array([1]),
        waitForTerminal: driveWaitPort(backend),
        requirementsOverride: { model: { id: "model-a" } },
        // Pinned clock like every sibling test: the miniature fixture's closeAt
        // (2026-08-04T00:00:00Z) is an absolute instant, and without this the
        // test flips from rejecting to resolving the moment wall-clock passes
        // it (it did, on 2026-08-04 — a time-bomb, not a code change).
        clock: { now: () => new Date("2026-08-01T00:00:00Z") },
      })) {
        void _;
        break;
      }
    }).rejects.toBeInstanceOf(CellCorrespondenceError);
  });

  test("watches via injected wait port to delivered", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    const events = [];
    for await (const event of launchAndWatch(
      bench,
      run,
      backend,
      baseOpts(runDigest, sealedTasks, backend),
    )) {
      events.push(event);
      if (events.some((entry) => entry.kind === "delivered")) break;
    }
    expect(events.map((event) => event.kind)).toEqual(["dispatch", "claimed", "delivered"]);
  });

  test("seals opaque capability grants into each new Submission without changing requirements", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    const originalSubmit = backend.submit.bind(backend);
    let observed: Record<string, unknown> | undefined;
    backend.submit = async (taskBytes, submissionBytes) => {
      observed ??= JSON.parse(new TextDecoder().decode(submissionBytes)) as Record<string, unknown>;
      return originalSubmit(taskBytes, submissionBytes);
    };
    for await (const event of launchAndWatch(bench, run, backend, baseOpts(
      runDigest,
      sealedTasks,
      backend,
      { capabilityGrants: { "demo1-claude-oauth-token": { kind: "opaque/1" } } },
    ))) {
      if (event.kind === "delivered") break;
    }
    expect(observed?.capabilityGrants).toEqual({
      "demo1-claude-oauth-token": { kind: "opaque/1" },
    });
    const firstCell = expectedCellSet(bench, run)[0]!;
    const firstArm = run.arms.find((arm) => arm.armId === firstCell.armId)!;
    expect(observed?.requirements).toEqual({
      ...run.policy.submissionBaseline,
      ...firstArm.pinning,
    });
  });

  test("captures each sealed Submission before submit and the accepted observation snapshot", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    const order: string[] = [];
    const capturedSubmissions: Uint8Array[] = [];
    const originalSubmit = backend.submit.bind(backend);
    backend.submit = async (taskBytes, submissionBytes) => {
      order.push("submit");
      return originalSubmit(taskBytes, submissionBytes);
    };

    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend),
      capture: {
        async captureSubmission({ bytes }) {
          order.push("submission");
          capturedSubmissions.push(bytes);
        },
        async captureObservation({ snapshot }) {
          order.push("snapshot");
          expect(snapshot.descriptor.attempt).toBeTruthy();
        },
      },
    })) {
      if (event.kind === "delivered") break;
    }

    expect(order.slice(0, 3)).toEqual(["submission", "submit", "snapshot"]);
    const submission = JSON.parse(new TextDecoder().decode(capturedSubmissions[0]!)) as {
      attempts?: { maxTotal?: number; maxConcurrent?: number };
    };
    expect(submission.attempts).toEqual({ maxTotal: 1, maxConcurrent: 1 });
  });

  test("capture failure prevents backend submit", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    let submitted = false;
    const originalSubmit = backend.submit.bind(backend);
    backend.submit = async (taskBytes, submissionBytes) => {
      submitted = true;
      return originalSubmit(taskBytes, submissionBytes);
    };

    await expect(async () => {
      for await (const _event of launchAndWatch(bench, run, backend, {
        ...baseOpts(runDigest, sealedTasks, backend),
        capture: {
          async captureSubmission() {
            throw new Error("capture unavailable");
          },
          async captureObservation() {},
        },
      })) {
        void _event;
      }
    }).rejects.toThrow("capture unavailable");
    expect(submitted).toBe(false);
  });

  test("IMPORTANT F: backend.watch path advances cursor to terminal and aborts without hang", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const inner = pinningBackend();
    const backend = watchingBackend(inner);
    const controller = new AbortController();

    // Drive terminals asynchronously as watches open.
    const originalObserve = inner.observe.bind(inner);
    let engaged = 0;
    inner.observe = async (ref) => {
      const snap = await originalObserve(ref);
      if (!snap.descriptor.derived.terminal && snap.descriptor.attempt) {
        engaged += 1;
        const eng = snap.observations.find(
          (observation) => observation.type === "network.jinn.task-execution.attempt-engaged.v1",
        );
        if (eng !== undefined) {
          queueMicrotask(() => {
            void inner.drive(snap.descriptor.attempt as never, [{
              specversion: "1.0",
              id: `watch-terminal-${engaged}`,
              source: eng.source,
              subject: snap.descriptor.attempt!,
              time: new Date().toISOString(),
              datacontenttype: "application/json",
              sequence: "0000000000000200",
              type: "network.jinn.task-execution.attempt-terminal.v1",
              data: { state: "delivered" },
            }]);
          });
        }
      }
      return snap;
    };

    const events = [];
    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, inner),
      waitForTerminal: undefined, // must use watch
      signal: controller.signal,
    })) {
      events.push(event);
      if (events.some((entry) => entry.kind === "delivered")) {
        controller.abort();
      }
      if (events.some((entry) => entry.cancelledRun === true)) break;
    }
    expect(events.some((event) => event.kind === "delivered")).toBe(true);
    expect(events.some((event) => event.cancelledRun === true)).toBe(true);
    expect(await backend.capabilities()).toMatchObject({ watch: true });
  });

  test("submit rejection is not replaceable", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    let submitCount = 0;
    const originalSubmit = backend.submit.bind(backend);
    backend.submit = async (taskBytes, submissionBytes) => {
      submitCount += 1;
      if (submitCount === 1) {
        return {
          accepted: false,
          error: { category: "unavailable", detail: "forced infra failure" } as never,
        };
      }
      return originalSubmit(taskBytes, submissionBytes);
    };
    const events = [];
    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend),
    })) {
      events.push(event);
      if (events.length >= 2) break;
    }
    expect(events[0]?.replaceable).toBe(false);
    expect(events[0]?.dispatch).toBe(1);
  });

  test("§7.4: expired terminal is replaced with monotonic dispatch index", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    let terminals = 0;
    const waitForTerminal: AttemptWaitPort = {
      async waitUntilTerminal({ attempt }) {
        terminals += 1;
        const state = terminals === 1 ? "expired" : "delivered";
        return driveWaitPort(backend, state).waitUntilTerminal({
          backend,
          attempt,
          closeAt: run.closeAt,
        });
      },
    };
    const events = [];
    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend, { waitForTerminal }),
    })) {
      events.push(event);
      if (events.some((entry) => entry.dispatch === 2 && entry.kind === "delivered")) break;
    }
    const firstCell = expectedCellSet(bench, run)[0]!.cellKey;
    const forCell = events.filter((event) => event.cellKey === firstCell);
    expect(forCell.some((event) =>
      event.dispatch === 1 && event.replaceableReason === "expired"
    )).toBe(true);
    expect(forCell.some((event) => event.dispatch === 2 && event.kind === "delivered")).toBe(true);
  });

  test("§7.4: unscorable and exclusion-hit host facts trigger replacement", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    let cellsSeen = 0;
    const events = [];
    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend, {
        waitForTerminal: driveWaitPort(backend, "delivered"),
        hostTerminalFacts: ({ cellKey }) => {
          if (cellKey === expectedCellSet(bench, run)[0]!.cellKey && cellsSeen < 1) {
            cellsSeen += 1;
            return { unscorable: true };
          }
          return undefined;
        },
      }),
    })) {
      events.push(event);
      if (events.some((entry) => entry.dispatch === 2 && entry.kind === "delivered")) break;
    }
    expect(events.some((event) => event.replaceableReason === "unscorable")).toBe(true);
  });

  test("§7.4 negative: judged/unjudged/invalidated terminals are never replaced", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    const events = [];
    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend),
      classifyTerminal: () => ({ kind: "judged", replaceable: false, judged: true }),
    })) {
      events.push(event);
      if (events.filter((entry) => entry.cellKey === expectedCellSet(bench, run)[0]!.cellKey).length >= 3) {
        break;
      }
    }
    const firstCell = expectedCellSet(bench, run)[0]!.cellKey;
    expect(events.filter((event) => event.cellKey === firstCell).every((event) => event.dispatch === 1))
      .toBe(true);
  });

  test("§7.4 negative: never replaces beyond maxPerCell", async () => {
    const { bench, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    const runBytes = await loadMiniature("run.json");
    const run = parseRun(runBytes) as RunRecord;
    (run.policy.replacement as { maxPerCell: number }).maxPerCell = 1;
    const waitForTerminal = driveWaitPort(backend, "expired");
    const events = [];
    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend, { waitForTerminal }),
    })) {
      events.push(event);
      const firstCell = expectedCellSet(bench, run)[0]!.cellKey;
      if (events.filter((entry) => entry.cellKey === firstCell && entry.replaceable).length >= 2) {
        break;
      }
    }
    const firstCell = expectedCellSet(bench, run)[0]!.cellKey;
    const dispatches = events.filter((event) => event.cellKey === firstCell).map((event) => event.dispatch);
    expect(Math.max(...dispatches)).toBe(2);
  });

  test("resume reuses exact accepted Submission bytes (byte-identical digest)", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend2 = pinningBackend();
    const captured = new Map<string, Uint8Array>();
    const originalSubmit = backend2.submit.bind(backend2);
    backend2.submit = async (taskBytes, submissionBytes) => {
      const doc = JSON.parse(new TextDecoder().decode(submissionBytes)) as {
        annotations?: { cellKey?: string };
      };
      const cellKey = doc.annotations?.cellKey ?? "unknown";
      captured.set(`${cellKey}:1`, submissionBytes);
      return originalSubmit(taskBytes, submissionBytes);
    };
    const launchEvents = [];
    for await (const event of launchAndWatch(bench, run, backend2, {
      ...baseOpts(runDigest, sealedTasks, backend2, {
        clock: { now: () => new Date("2026-08-01T00:00:00Z") },
      }),
    })) {
      launchEvents.push(event);
      if (event.kind === "delivered") break;
    }
    const dispatchEvent = launchEvents.find((event) => event.kind === "dispatch")!;
    const coord = expectedCellSet(bench, run).find((cell) => cell.cellKey === dispatchEvent.cellKey)!;

    const resumeEvents = [];
    for await (const event of resumeRun(bench, run, backend2, {
      ...baseOpts(runDigest, sealedTasks, backend2, {
        clock: { now: () => new Date("2026-08-03T12:00:00Z") },
        waitForTerminal: driveWaitPort(backend2, "delivered"),
        acceptedSubmissions: {
          acceptedSubmissionBytes: (_r, cellKey, dispatch) => captured.get(`${cellKey}:${dispatch}`),
        },
      }),
      outstanding: [{ ...coord, dispatch: 1 }],
    })) {
      resumeEvents.push(event);
    }
    expect(resumeEvents.find((event) => event.kind === "dispatch")?.submissionDigest)
      .toBe(dispatchEvent.submissionDigest);
  });

  test("CRITICAL C: natural closeAt stops dispatch without cancelledRun", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    const events = [];
    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend, {
        clock: { now: () => new Date("2026-08-05T00:00:00Z") }, // after closeAt
      }),
    })) {
      events.push(event);
    }
    expect(events).toEqual([]);
    expect(events.some((event) => event.cancelledRun === true)).toBe(false);
  });

  test("CRITICAL C: signal abort before close sets cancelledRun", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    const controller = new AbortController();
    let sawDispatch = false;
    const waitForTerminal: AttemptWaitPort = {
      async waitUntilTerminal(input) {
        if (!sawDispatch) {
          sawDispatch = true;
          controller.abort();
        }
        return driveWaitPort(backend, "cancelled").waitUntilTerminal(input);
      },
    };
    const events = [];
    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend, { waitForTerminal }),
      signal: controller.signal,
    })) {
      events.push(event);
    }
    expect(events.some((event) => event.cancelledRun === true)).toBe(true);
  });

  test("CRITICAL C: earlyClose sets cancelledRun; resume at/after close does not re-dispatch", async () => {
    const { bench, run, runDigest, tasks } = await miniatureContext();
    const sealedTasks = sealingTasks(tasks);
    const backend = pinningBackend();
    const events = [];
    for await (const event of launchAndWatch(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend),
      earlyClose: true,
    })) {
      events.push(event);
    }
    expect(events.some((event) => event.cancelledRun === true && event.detail === "early-close")).toBe(true);

    const resumeEvents = [];
    for await (const event of resumeRun(bench, run, backend, {
      ...baseOpts(runDigest, sealedTasks, backend, {
        clock: { now: () => new Date("2026-08-05T00:00:00Z") },
      }),
      outstanding: expectedCellSet(bench, run).slice(0, 1).map((cell) => ({ ...cell, dispatch: 1 })),
    })) {
      resumeEvents.push(event);
    }
    expect(resumeEvents).toEqual([]);
  });
});
