/**
 * `runBind` (issue #2976), against a real workspace, a real lock and real sealed records.
 *
 * Beacon values below are synthetic repeated hex; the drand round numbers are real round INDICES
 * on the published quicknet schedule, chosen only so their derived instants sit either side of the
 * lock. Nothing here contacts a beacon: the operation takes the reference as input by design.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BEACON_SOURCES,
  computeBeaconOrder,
  requiredBeaconRound,
  verifyRunBinding,
  type BeaconReference,
} from "@colophon-claims/verify";
import { itemTaskDigest, parseBenchmark } from "@jinn-network/benchmarking-records";
import { readAuditEntries } from "../audit/journal.js";
import { readRunBindingCarriage } from "../binding/carriage.js";
import { readRunState, writeRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes, sealedRecordPath } from "../workspace/sealed-store.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runBind } from "./run-bind.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { runStatus } from "./run-status.js";
import { sampleInit } from "./sample.js";

const VALUE = "b".repeat(64);
/** Well past the 2026 lock instants below on quicknet's 3-second schedule. */
const LATE_ROUND = 200_000_000;
/** genesis + 0 -- 2023, comfortably before any lock this suite takes. */
const EARLY_ROUND = 1;

/**
 * The one round the seal names (issue #3322), recorded by `setUpLockedDraft` from the lock this
 * suite actually took rather than hard-coded: it is a function of the lock instant, so pinning a
 * number here would silently stop testing the rule the moment the fixture clock moved.
 */
let sealDerivedRound: number;

const beacon = (overrides: Partial<BeaconReference> = {}): BeaconReference => ({
  source: "drand/quicknet",
  round: sealDerivedRound,
  value: VALUE,
  ...overrides,
});

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bind-"));
  // Reset to a well-formed round for the tests that never lock: they refuse on the DRAFT STATE,
  // and a leftover (or absent) round would refuse on the beacon first and pass for the wrong
  // reason -- or, run in isolation, fail outright.
  sealDerivedRound = LATE_ROUND;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-17T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpLockedDraft(clock: () => string, draftId = "draft-1"): Promise<string> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Bind Test" });
  await sampleInit(contextFor(clock), { draftId });
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  if (!locked.ok) throw new Error("lock failed");
  const lockedAt = readRunState(workspaceDir, draftId)?.lockedAt;
  if (lockedAt === undefined) throw new Error("lock recorded no instant");
  sealDerivedRound = requiredBeaconRound("drand/quicknet", lockedAt)!.round;
  return locked.result.runSha256;
}

function benchmarkItemIds(draftId = "draft-1"): readonly string[] {
  const document = readDraftDocument(workspaceDir, draftId);
  if (document.spec.taskSet.kind !== "benchmark") throw new Error("no benchmark");
  const benchmark = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  return [...new Set(benchmark.items.map((item) => `sha256:${itemTaskDigest(item)}`))];
}

describe("runBind", () => {
  test("seals a census binding whose order is the beacon-derived one, and records it", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);

    const result = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = computeBeaconOrder({
      sealDigest: `sha256:${runSha256}`,
      beaconValue: VALUE,
      itemSha256s: benchmarkItemIds(),
    });
    expect(result.result.binding.mode).toBe("census");
    expect(result.result.binding.order).toEqual(expected.order);
    expect(result.result.binding.poolDigest).toBe(expected.poolDigest);
    expect(result.result.binding.sealDigest).toBe(`sha256:${runSha256}`);
    expect(result.result.binding.postSeal).toBe("proven-offline");

    const state = readRunState(workspaceDir, "draft-1");
    expect(state?.binding?.recordSha256).toBe(result.result.recordSha256);
    expect(state?.binding?.boundAt).toBe(result.result.boundAt);
    // The record is verifiable in isolation, by the same function an external reader uses.
    expect(verifyRunBinding(JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, result.result.recordSha256)))).order)
      .toEqual(expected.order);
  });

  test("the sealed binding does not move the lock: the draft stays locked", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
  });

  test("the statement is the census one, naming the weaker ordering-only binding", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const result = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    if (!result.ok) throw new Error("bind failed");
    expect(result.result.statement).toContain("binds execution ORDER only");
    expect(result.result.statement).toContain("weaker binding");
  });

  test("refuses a beacon round that predates the seal", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const result = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon({ round: EARLY_ROUND }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.detail).toMatch(/does not postdate the seal/u);
    expect(readRunState(workspaceDir, "draft-1")?.binding).toBeUndefined();
  });

  test("round 1 of the schedule is not admitted merely because it is round 1", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    expect(BEACON_SOURCES["drand/quicknet"].genesisTimeSeconds * 1000)
      .toBeLessThan(Date.parse("2026-08-17T00:00:00Z"));
    expect(runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon({ round: 1 }) }).ok).toBe(false);
  });

  test("refuses an unknown beacon source and a malformed value", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    for (const bad of [
      { source: "lottery/uk" as BeaconReference["source"], round: LATE_ROUND, value: VALUE },
      beacon({ value: "B".repeat(64) }),
      beacon({ value: "abc" }),
    ]) {
      const result = runBind(contextFor(clock), { draftId: "draft-1", beacon: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("validation");
    }
  });

  test("binds once — a second bind is refused and leaves the first intact", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const first = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    if (!first.ok) throw new Error("first bind failed");

    const second = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon({ round: LATE_ROUND + 1 }) });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
    expect(readRunState(workspaceDir, "draft-1")?.binding?.recordSha256).toBe(first.result.recordSha256);
  });

  test("writeRunState refuses to replace a recorded binding, whatever the writer", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const first = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    if (!first.ok) throw new Error("bind failed");
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(() => writeRunState(workspaceDir, "draft-1", {
      ...state,
      binding: { recordSha256: "f".repeat(64), boundAt: state.binding!.boundAt },
    })).toThrow(/binds once/u);
    expect(() => writeRunState(workspaceDir, "draft-1", { ...state, binding: undefined }))
      .toThrow(/cannot be removed/u);
  });

  test("refuses before the draft is locked", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Bind Test" });
    await sampleInit(contextFor(clock), { draftId: "draft-1" });
    const result = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("illegal-transition");
  });

  test("refuses once the run has launched", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const state = readRunState(workspaceDir, "draft-1")!;
    writeRunState(workspaceDir, "draft-1", { ...state, launchedAt: "2026-08-17T01:00:00Z" });
    const result = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).toMatch(/already launched/u);
  });

  /**
   * Issue #3322: postdating the seal is not enough on its own. Between lock and launch an operator
   * sees many published rounds and can derive what each would produce, so admitting any later round
   * leaves the choice among realised values open. The seal names exactly one round on a scheduled
   * source, and this is the refusal that holds the run to it.
   */
  describe("round choice", () => {
    test("refuses a round later than the one the seal names, and names that round", async () => {
      const clock = makeClock();
      await setUpLockedDraft(clock);
      const result = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon({ round: LATE_ROUND }) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("validation");
      expect(result.error.detail).toContain(`round ${sealDerivedRound}`);
      expect(result.error.detail).toMatch(/first round this source publishes after the seal/u);
      expect(readRunState(workspaceDir, "draft-1")?.binding).toBeUndefined();
    });

    /**
     * The lower adjacency, which the `EARLY_ROUND = 1` case above does not reach: the round one
     * BEFORE the required one is refused too, and by the postdating rule rather than this one. The
     * two refusals therefore meet with no gap and no double-refusal, leaving exactly one admissible
     * round -- the claim the design rests on, asserted here through `runBind` itself.
     */
    test("refuses the round one before it — the two refusals meet with no gap", async () => {
      const clock = makeClock();
      await setUpLockedDraft(clock);
      const result = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon({ round: sealDerivedRound - 1 }) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("validation");
      expect(result.error.detail).toMatch(/does not postdate the seal/u);
      expect(readRunState(workspaceDir, "draft-1")?.binding).toBeUndefined();
    });

    test("refuses the round one past it — the cheapest grind is refused like the largest", async () => {
      const clock = makeClock();
      await setUpLockedDraft(clock);
      expect(runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon({ round: sealDerivedRound + 1 }) }).ok)
        .toBe(false);
    });

    test("the round the seal names binds, and its sentence says the round was not chosen", async () => {
      const clock = makeClock();
      await setUpLockedDraft(clock);
      const result = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.binding.roundBasis).toBe("seal-derived");
      expect(result.result.statement).toContain("first round this source publishes after the seal");
    });

    test("a height-indexed source has no such round, so its height binds and is reported as chosen", async () => {
      const clock = makeClock();
      await setUpLockedDraft(clock);
      const result = runBind(contextFor(clock), {
        draftId: "draft-1",
        beacon: { source: "bitcoin/mainnet", round: 900_000, value: VALUE },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.binding.roundBasis).toBe("operator-chosen");
      expect(result.result.statement).toContain("No round follows from a seal on a height-indexed source");
      // Nothing in the bundle places a height after the seal, so the sentence claims no
      // unpredictability -- the retraction this issue exists to make, on the branch that needs it.
      expect(result.result.statement).not.toContain("could not have been predicted");
    });

    test("status offers the bindable rounds before the run binds, and drops them after", async () => {
      const clock = makeClock();
      await setUpLockedDraft(clock);
      const before = runStatus(contextFor(clock), { draftId: "draft-1" });
      if (!before.ok) throw new Error("status failed");
      expect(before.result.bindableBeaconRounds).toEqual([
        { source: "drand/default", round: expect.any(Number), publishedAt: expect.any(String) },
        { source: "drand/quicknet", round: sealDerivedRound, publishedAt: expect.any(String) },
      ]);

      runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
      const after = runStatus(contextFor(clock), { draftId: "draft-1" });
      if (!after.ok) throw new Error("status failed");
      expect(after.result.bindableBeaconRounds).toBeUndefined();
    });
  });

  test("appends exactly one audit entry per call", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const before = readAuditEntries(workspaceDir).length;
    runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    const entries = readAuditEntries(workspaceDir);
    expect(entries.length).toBe(before + 1);
    expect(entries.at(-1)?.action).toBe("bind");
  });
});

describe("readRunBindingCarriage", () => {
  test("is undefined for a run that never bound", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    expect(readRunBindingCarriage(workspaceDir, readRunState(workspaceDir, "draft-1")!)).toBeUndefined();
  });

  test("re-derives the order from the stored bytes rather than reporting a stored field", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const bound = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    if (!bound.ok) throw new Error("bind failed");
    const carried = readRunBindingCarriage(workspaceDir, readRunState(workspaceDir, "draft-1")!)!;
    expect(carried.order).toEqual(computeBeaconOrder({
      sealDigest: `sha256:${runSha256}`,
      beaconValue: VALUE,
      itemSha256s: benchmarkItemIds(),
    }).order);
  });

  test("refuses a binding record whose order is not the derived one", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const bound = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    if (!bound.ok) throw new Error("bind failed");

    // Stored honestly under its own digest, so the sealed store's own check passes and what
    // refuses is the recomputation -- the check that would catch an operator who reordered a run
    // after seeing the beacon.
    const stored = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, bound.result.recordSha256)));
    const tampered = putSealedBytes(
      workspaceDir,
      new TextEncoder().encode(JSON.stringify({ ...stored, order: [...stored.order].reverse() })),
    );
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(() => readRunBindingCarriage(workspaceDir, { ...state, binding: { recordSha256: tampered, boundAt: state.binding!.boundAt } }))
      .toThrow(/differs from the beacon-binding\/1 recomputation/u);
  });

  test("refuses a binding record edited in place, before it is ever projected", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const bound = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    if (!bound.ok) throw new Error("bind failed");
    const stored = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, bound.result.recordSha256)));
    atomicWriteFileSync(
      sealedRecordPath(workspaceDir, bound.result.recordSha256),
      new TextEncoder().encode(JSON.stringify({ ...stored, order: [...stored.order].reverse() })),
    );
    expect(() => readRunBindingCarriage(workspaceDir, readRunState(workspaceDir, "draft-1")!))
      .toThrow(/stored bytes do not match their digest/u);
  });

  test("refuses a binding record whose bytes do not match the digest it is filed under", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const bound = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    if (!bound.ok) throw new Error("bind failed");
    const other = putSealedBytes(workspaceDir, new TextEncoder().encode("{}"));
    const state = readRunState(workspaceDir, "draft-1")!;
    // A run state naming a digest whose record is not a binding at all.
    expect(() => readRunBindingCarriage(workspaceDir, { ...state, binding: { recordSha256: other, boundAt: state.binding!.boundAt } }))
      .toThrow();
  });

  test("refuses a valid binding record written for a different run", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const otherRunSha256 = await setUpLockedDraft(clock, "draft-2");
    const bound = runBind(contextFor(clock), { draftId: "draft-2", beacon: beacon() });
    if (!bound.ok) throw new Error("bind failed");

    // Honest bytes, honest digest, internally consistent -- everything but the run it belongs to.
    // This is the post-hoc move the binding exists to make impossible: a run sealed after its
    // results were known borrowing an older run's beacon to claim it could not have selected.
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(state.runSha256).not.toBe(otherRunSha256);
    expect(() => readRunBindingCarriage(workspaceDir, {
      ...state,
      binding: { recordSha256: bound.result.recordSha256, boundAt: "2026-09-01T00:00:00Z" },
    })).toThrow(/which is not this run's sealed Run/u);
  });

  test("refuses a binding record whose sealedAt disagrees with the run's lock", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const bound = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    if (!bound.ok) throw new Error("bind failed");

    // Same sealDigest, so the order still recomputes and `verifyRunBinding` passes; only the seal
    // INSTANT moves, which is the half of the postdating claim `verifyRunBinding` cannot check.
    const stored = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, bound.result.recordSha256)));
    const forged = putSealedBytes(
      workspaceDir,
      new TextEncoder().encode(JSON.stringify({ ...stored, sealedAt: "2020-01-01T00:00:00Z" })),
    );
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(() => readRunBindingCarriage(workspaceDir, {
      ...state,
      binding: { recordSha256: forged, boundAt: state.binding!.boundAt },
    })).toThrow(/but this run was sealed at/u);
  });

  test("refuses a recorded binding on a run with no sealed identity to resolve it against", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const bound = runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    if (!bound.ok) throw new Error("bind failed");
    const state = readRunState(workspaceDir, "draft-1")!;
    expect(() => readRunBindingCarriage(workspaceDir, { ...state, runSha256: undefined }))
      .toThrow(/no sealed Run identity/u);
  });
});

describe("runStatus", () => {
  test("omits the binding for an unbound run and states it for a bound one", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const before = runStatus(contextFor(clock), { draftId: "draft-1" });
    if (!before.ok) throw new Error("status failed");
    expect(before.result.binding).toBeUndefined();

    runBind(contextFor(clock), { draftId: "draft-1", beacon: beacon() });
    const after = runStatus(contextFor(clock), { draftId: "draft-1" });
    if (!after.ok) throw new Error("status failed");
    expect(after.result.binding?.class).toBe("beacon-ordering-only");
    expect(after.result.binding?.beacon.round).toBe(sealDerivedRound);
    expect(after.result.binding?.postSeal).toBe("proven-offline");
    expect(after.result.binding?.statement).toContain("beacon-binding/1");
  });
});
