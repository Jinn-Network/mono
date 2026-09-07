import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ANCHOR_INTENT_EXTENSION,
  BEACON_SOURCE_EXTENSION,
  SAMPLE_SIZE_ADVISORY_EXTENSION,
  parseRun,
  readBeaconSource,
  readRunAnchorIntentExtension,
  readRunSampleSizeAdvisory,
  sealRun,
  withRunSampleSizeAdvisoryExtension,
} from "@jinn-network/benchmarking-records";
import { PREDICTION_FORECAST_PROFILE_DIGEST_HEX } from "@jinn-network/task-execution-profiles";
import { readAuditEntries } from "../audit/journal.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { readRunState, writeRunState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, sealedRecordPath } from "../workspace/sealed-store.js";
import { armAdd, armUpdate } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument, updateDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { draftSampleSizeAdvisory, runLock } from "./run-lock.js";
import { buildRegistrationClosure } from "./publication-register.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-lock-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-05T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpQuotedDraft(clock: () => string, draftId = "draft-1"): Promise<void> {
  initWorkspace(contextFor(clock));
  const draftResult = createDraft(contextFor(clock), { draftId, name: "Lock Test" });
  expect(draftResult.ok).toBe(true);
  await sampleInit(contextFor(clock), { draftId });
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
}

describe("runLock — lifecycle transition", () => {
  test("quoted -> locked; seals a Run record, persists runSha256/closeAt/lockedAt, audits 'lock'", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);

    const outcome = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.state).toBe("locked");
    expect(outcome.result.runSha256).toMatch(/^[a-f0-9]{64}$/);

    const bytes = getSealedBytes(workspaceDir, outcome.result.runSha256);
    const record = parseRun(bytes);
    expect(record.arms).toHaveLength(2);
    expect(record.closeAt).toBe(outcome.result.closeAt);

    const state = readRunState(workspaceDir, "draft-1");
    expect(state?.runSha256).toBe(outcome.result.runSha256);
    expect(state?.closeAt).toBe(outcome.result.closeAt);
    expect(state?.lockedAt).toBeDefined();
    // Owner and specSha256 from the quote step are preserved, not clobbered.
    expect(state?.owner).toBeDefined();

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "lock", subject: "draft-1", outcome: "ok" });
  });

  test("retains an exact registration closure ordered Task material -> Tasks -> Benchmark -> Run", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok).toBe(true);
    if (!locked.ok) return;

    const members = buildRegistrationClosure(
      workspaceDir,
      getSealedBytes(workspaceDir, locked.result.runSha256),
      locked.result.runSha256,
      "2026-08-13T12:00:00Z",
    );
    expect(members.at(-1)?.id).toBe("run");
    const tasks = members.filter((member) => member.id.startsWith("task:"));
    expect(tasks).toHaveLength(3);
    expect(tasks.every((task) => task.dependsOn?.some((id) => id.startsWith("profile:")))).toBe(true);
    expect(tasks.every((task) => task.dependsOn?.some((id) => id.startsWith("evaluation:")))).toBe(true);
    const benchmark = members.find((member) => member.id.startsWith("benchmark:"));
    expect(benchmark?.dependsOn).toEqual(expect.arrayContaining(tasks.map((task) => task.id)));
    expect(members.at(-1)?.dependsOn).toEqual(expect.arrayContaining([benchmark?.id]));

    const profilePath = sealedRecordPath(workspaceDir, PREDICTION_FORECAST_PROFILE_DIGEST_HEX);
    unlinkSync(profilePath);
    expect(() => buildRegistrationClosure(
      workspaceDir,
      getSealedBytes(workspaceDir, locked.result.runSha256),
      locked.result.runSha256,
      "2026-08-13T12:00:00Z",
    )).toThrow(/missing/);
    writeFileSync(profilePath, "tampered");
    expect(() => buildRegistrationClosure(
      workspaceDir,
      getSealedBytes(workspaceDir, locked.result.runSha256),
      locked.result.runSha256,
      "2026-08-13T12:00:00Z",
    )).toThrow(/missing/);
  });

  test("refuses illegal-transition when the draft is not 'quoted' (e.g. still 'draft')", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Never Quoted" });

    const outcome = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("refuses illegal-transition when the draft is already locked (locking twice)", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    const first = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(first.ok).toBe(true);

    const second = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("illegal-transition");
  });
});

describe("runLock — A2 quote invalidation", () => {
  test("refuses conflict when the draft was edited after the quote it's locking against", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);

    // Editing a quoted draft drives quoted->draft (A2) — armUpdate mirrors updateDraft's rule.
    const edited = armUpdate(contextFor(clock), { draftId: "draft-1", armId: "sample", notes: "changed after quote" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.result.draft.state).toBe("draft");

    // Re-quote to get back to "quoted" so the state guard passes, but hand-roll a STALE
    // RunState (as if the re-quote's write had raced or been skipped) to exercise the specSha256
    // mismatch path in isolation from the state-guard path.
    const requoted = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(requoted.ok).toBe(true);

    const staleState = readRunState(workspaceDir, "draft-1");
    expect(staleState).toBeDefined();
    if (staleState === undefined) return;
    writeRunState(workspaceDir, "draft-1", { ...staleState, specSha256: "0".repeat(64) });

    const outcome = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
    expect(outcome.error.detail).toMatch(/re-quote/);
  });

  test("refuses not-found when locking a quoted draft with no RunState at all (should not happen via the public API, but the check is defensive)", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "No RunState" });
    // Force-advance the draft to "quoted" without ever calling runQuote, so no RunState exists.
    const document = readDraftDocument(workspaceDir, "draft-1");
    atomicWriteFileSync(draftPath(workspaceDir, "draft-1"), JSON.stringify({ ...document, state: "quoted" }, null, 2));

    const outcome = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("not-found");
  });
});

describe("runLock — gating (authority-denied / grant)", () => {
  test("an ungranted delegated agent is refused, audited under the denied principal; a grant then allows it", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });

    const denied = runLock(contextFor(clock, "agent-1"), { draftId: "draft-1" });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("authority-denied");

    const entries = readAuditEntries(workspaceDir);
    const deniedEntry = entries[entries.length - 1];
    expect(deniedEntry).toMatchObject({ action: "lock", actor: "agent-1", outcome: "authority-denied" });

    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: ["lock"] });
    const allowed = runLock(contextFor(clock, "agent-1"), { draftId: "draft-1" });
    expect(allowed.ok).toBe(true);
  });
});

describe("runLock — draft immutability after lock", () => {
  test("updateDraft refuses illegal-transition on a locked draft", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok).toBe(true);

    const outcome = updateDraft(contextFor(clock), { draftId: "draft-1", patch: { description: "too late" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("armAdd refuses illegal-transition on a locked draft", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok).toBe(true);

    const outcome = armAdd(contextFor(clock), { draftId: "draft-1", armId: "late", pinning: {} });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });
});

describe("declared anchoring intent (anchor-evidence design §7.3)", () => {
  /** Two drafts, one workspace, one lock instant. Same owner, same benchmark, same arms, same
   * closeAt — so anything that differs in the sealed bytes differs because of the draft's own
   * `anchoring` block and nothing else. */
  async function lockTwoDrafts(declaring: unknown): Promise<{ plain: Uint8Array; declared: Uint8Array }> {
    const setupClock = makeClock();
    await setUpQuotedDraft(setupClock, "plain-draft");

    // `setUpQuotedDraft` already created the workspace; the second draft joins it.
    createDraft(contextFor(setupClock), { draftId: "declaring-draft", name: "Lock Test" });
    await sampleInit(contextFor(setupClock), { draftId: "declaring-draft" });
    armAdd(contextFor(setupClock), { draftId: "declaring-draft", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(setupClock), { draftId: "declaring-draft", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    if (declaring !== undefined) {
      updateDraft(contextFor(setupClock), { draftId: "declaring-draft", patch: { anchoring: declaring } });
    }
    expect((await runQuote(contextFor(setupClock), { draftId: "declaring-draft" })).ok).toBe(true);

    // One frozen instant for both locks, so `closeAt` is identical in both records.
    const lockClock = () => "2026-08-05T09:00:00Z";
    const plain = runLock(contextFor(lockClock), { draftId: "plain-draft" });
    const declared = runLock(contextFor(lockClock), { draftId: "declaring-draft" });
    expect(plain.ok && declared.ok).toBe(true);
    if (!plain.ok || !declared.ok) throw new Error("lock failed");
    return {
      plain: getSealedBytes(workspaceDir, plain.result.runSha256),
      declared: getSealedBytes(workspaceDir, declared.result.runSha256),
    };
  }

  test("a draft that declares nothing seals byte-identical Run records", async () => {
    const { plain, declared } = await lockTwoDrafts(undefined);
    expect(Buffer.from(declared).toString("hex")).toBe(Buffer.from(plain).toString("hex"));
    expect(Object.hasOwn(JSON.parse(new TextDecoder().decode(plain)), ANCHOR_INTENT_EXTENSION)).toBe(false);
  }, 60_000);

  test("a draft that only disables anchoring still seals byte-identical Run records", async () => {
    // The disable is producer-side policy. Sealing it would leak local policy into a public record.
    const { plain, declared } = await lockTwoDrafts({ enabled: false });
    expect(Buffer.from(declared).toString("hex")).toBe(Buffer.from(plain).toString("hex"));
  }, 60_000);

  test("a declared intent adds exactly the one namespaced key and changes the digest", async () => {
    const providers = [
      "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
      "https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1",
    ];
    const { plain, declared } = await lockTwoDrafts({ declaredProviders: providers });
    expect(Buffer.from(declared).toString("hex")).not.toBe(Buffer.from(plain).toString("hex"));

    const record = JSON.parse(new TextDecoder().decode(declared)) as Record<string, unknown>;
    // Sorted and unique, never in the order the draft happened to list them.
    expect(record[ANCHOR_INTENT_EXTENSION]).toEqual({ providers: [...providers].sort() });
    expect(readRunAnchorIntentExtension(record)).toEqual({ providers: [...providers].sort() });
    // Endpoints never travel: the declaration names profiles only.
    expect(new TextDecoder().decode(declared)).not.toContain("timestamp.invalid");

    // Removing the one key and re-sealing reproduces the unanchored bytes exactly: the extension
    // is the only difference, not a re-shaping of the record.
    delete record[ANCHOR_INTENT_EXTENSION];
    expect(Buffer.from(sealRun(record).bytes).toString("hex")).toBe(Buffer.from(plain).toString("hex"));
  }, 60_000);

  test("a duplicated declaration is deduplicated rather than sealed twice", async () => {
    const profile = "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1";
    const { declared } = await lockTwoDrafts({ declaredProviders: [profile, profile] });
    const record = JSON.parse(new TextDecoder().decode(declared)) as Record<string, unknown>;
    expect(record[ANCHOR_INTENT_EXTENSION]).toEqual({ providers: [profile] });
  }, 60_000);
});

/**
 * Issue #3426. Declaring the beacon source before the lock is what leaves `bind` no source to
 * choose; declaring nothing must stay exactly as legal and as byte-identical as it was.
 */
describe("runLock — declared beacon source", () => {
  const sealedRun = (draftId = "draft-1"): Record<string, unknown> => {
    const runSha256 = readRunState(workspaceDir, draftId)?.runSha256;
    if (runSha256 === undefined) throw new Error("no sealed Run");
    return parseRun(getSealedBytes(workspaceDir, runSha256)) as unknown as Record<string, unknown>;
  };

  test("seals the declaration when the draft makes one", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    // Patched before the quote invalidation check would fire, then re-quoted, the way any
    // spec edit reaches a lock.
    updateDraft(contextFor(clock), { draftId: "draft-1", patch: { beaconSource: "drand/quicknet" } });
    await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(runLock(contextFor(clock), { draftId: "draft-1" }).ok).toBe(true);
    expect(readBeaconSource(sealedRun())).toBe("drand/quicknet");
  });

  test("touches the record at all only when the draft declares one", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    expect(runLock(contextFor(clock), { draftId: "draft-1" }).ok).toBe(true);
    expect(sealedRun()).not.toHaveProperty(BEACON_SOURCE_EXTENSION);
    expect(readBeaconSource(sealedRun())).toBeUndefined();
  });

  test("refuses a source no beacon procedure admits, at the draft rather than at the seal", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    const patched = updateDraft(contextFor(clock), { draftId: "draft-1", patch: { beaconSource: "drand/nonesuch" } });
    expect(patched.ok).toBe(false);
    if (patched.ok) return;
    // Assert the refusal this test is about, not merely that something refused: `updateDraft`
    // rejects for several unrelated reasons, and `ok === false` alone would be satisfied by any
    // of them.
    expect(patched.error.code).toBe("validation");
    expect(patched.error.issues?.some((issue) => issue.path.startsWith("beaconSource"))).toBe(true);
  });
});

/**
 * Issue #2978. The lock accepted any replicate and item count without comment, while the interval
 * those counts imply was computable before a single cell was dispatched. What the seal records is
 * not the arithmetic — n and the width are both derivable from the plan — but that the operator was
 * shown the width before the irreversible seal and locked at this n regardless.
 */
describe("runLock — acknowledged sample-size advisory", () => {
  const sealedRun = (draftId = "draft-1"): Record<string, unknown> => {
    const runSha256 = readRunState(workspaceDir, draftId)?.runSha256;
    if (runSha256 === undefined) throw new Error("no sealed Run");
    return parseRun(getSealedBytes(workspaceDir, runSha256)) as unknown as Record<string, unknown>;
  };

  test("seals the advisory when the caller acknowledged it, and returns the same numbers", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    const planned = draftSampleSizeAdvisory(workspaceDir, "draft-1");
    expect(planned).toBeDefined();

    const outcome = runLock(contextFor(clock), { draftId: "draft-1", acknowledgedSampleSizeAdvisory: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.sampleSizeAdvisory).toEqual(planned);
    expect(readRunSampleSizeAdvisory(sealedRun()))
      .toEqual({ n: planned?.n, expectedIntervalWidth: planned?.expectedIntervalWidth });
  });

  test("the sealed n is items x replicates, so it is the denominator each arm's interval will use", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    const single = draftSampleSizeAdvisory(workspaceDir, "draft-1");
    updateDraft(contextFor(clock), { draftId: "draft-1", patch: { replicates: 3 } });
    await runQuote(contextFor(clock), { draftId: "draft-1" });
    const tripled = draftSampleSizeAdvisory(workspaceDir, "draft-1");
    expect(tripled?.n).toBe((single?.n ?? 0) * 3);

    expect(runLock(contextFor(clock), { draftId: "draft-1", acknowledgedSampleSizeAdvisory: true }).ok).toBe(true);
    expect(readRunSampleSizeAdvisory(sealedRun())?.n).toBe(tripled?.n);
    // More trials, a narrower ceiling: the advisory is about the tradeoff, so it has to move.
    expect(Number(tripled?.expectedIntervalWidth))
      .toBeLessThan(Number(single?.expectedIntervalWidth));
  });

  test("touches the record at all only when the caller acknowledged", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    const outcome = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.sampleSizeAdvisory).toBeUndefined();
    expect(sealedRun()).not.toHaveProperty(SAMPLE_SIZE_ADVISORY_EXTENSION);
    expect(readRunSampleSizeAdvisory(sealedRun())).toBeUndefined();
  });

  /**
   * "Byte-identical to a lock before the advisory existed" is a claim about ONE key, so the test
   * has to add that key and take it away again. Comparing an unacknowledged seal with itself
   * (issue #3802) cannot fail for the reason it names and would keep passing if the extension ever
   * started leaking into unacknowledged seals.
   */
  test("acknowledging adds one key and nothing else: strip it and the bytes come back exactly", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    expect(runLock(contextFor(clock), { draftId: "draft-1" }).ok).toBe(true);
    const plain = sealedRun();
    expect(Object.keys(plain)).not.toContain(SAMPLE_SIZE_ADVISORY_EXTENSION);
    const plainHex = Buffer.from(sealRun(plain).bytes).toString("hex");

    const acknowledged = withRunSampleSizeAdvisoryExtension(plain, { n: 24, expectedIntervalWidth: "0.3928" });
    expect(Buffer.from(sealRun(acknowledged).bytes).toString("hex")).not.toBe(plainHex);

    const stripped = { ...acknowledged };
    delete (stripped as Record<string, unknown>)[SAMPLE_SIZE_ADVISORY_EXTENSION];
    expect(Buffer.from(sealRun(stripped).bytes).toString("hex")).toBe(plainHex);
  });

  /**
   * Issue #3908. The claim is about `runLock`'s own acknowledged branch — "acknowledging adds one
   * key and nothing else" — so both sides have to be real seals that operation produced. Attaching
   * the extension with `withRunSampleSizeAdvisoryExtension` and stripping it again round-trips a
   * records helper whose implementation is `{...record, [KEY]: ext}`, which cannot catch `runLock`
   * gaining a second mutation on that branch. Two locks of identical specs, one acknowledged and
   * one not, can.
   */
  test("two real locks of the same spec differ by exactly the one key", async () => {
    const setupClock = makeClock();
    await setUpQuotedDraft(setupClock, "plain-draft");
    // `setUpQuotedDraft` already created the workspace; the acknowledging draft joins it with the
    // same spec, the way the anchoring suite's two-draft comparison does.
    createDraft(contextFor(setupClock), { draftId: "ack-draft", name: "Lock Test" });
    await sampleInit(contextFor(setupClock), { draftId: "ack-draft" });
    armAdd(contextFor(setupClock), { draftId: "ack-draft", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(setupClock), { draftId: "ack-draft", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    expect((await runQuote(contextFor(setupClock), { draftId: "ack-draft" })).ok).toBe(true);

    // One frozen instant for both locks, so `closeAt` is identical in both records.
    const lockClock = () => "2026-08-05T09:00:00Z";
    const plainLock = runLock(contextFor(lockClock), { draftId: "plain-draft" });
    const ackLock = runLock(contextFor(lockClock), { draftId: "ack-draft", acknowledgedSampleSizeAdvisory: true });
    expect(plainLock.ok && ackLock.ok, JSON.stringify({ plainLock, ackLock })).toBe(true);
    if (!plainLock.ok || !ackLock.ok) return;

    const plainHex = Buffer.from(getSealedBytes(workspaceDir, plainLock.result.runSha256)).toString("hex");
    const ackBytes = getSealedBytes(workspaceDir, ackLock.result.runSha256);
    expect(Buffer.from(ackBytes).toString("hex")).not.toBe(plainHex);

    const acknowledged = JSON.parse(new TextDecoder().decode(ackBytes)) as Record<string, unknown>;
    expect(acknowledged).toHaveProperty(SAMPLE_SIZE_ADVISORY_EXTENSION);
    delete acknowledged[SAMPLE_SIZE_ADVISORY_EXTENSION];
    expect(Buffer.from(sealRun(acknowledged).bytes).toString("hex")).toBe(plainHex);
  }, 60_000);

  /**
   * Issue #3832. The advisory names the declared readouts its per-arm width does not bound, and
   * that naming reaches the operator surfaces through the same object `runLock` returns — while the
   * SEALED extension stays exactly the two fields it always carried.
   */
  test("names a declared comparison readout without sealing it", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    expect(createDraft(contextFor(clock), { draftId: "paired", name: "Paired" }).ok).toBe(true);
    await sampleInit(contextFor(clock), { draftId: "paired" });
    armAdd(contextFor(clock), { draftId: "paired", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId: "paired", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    expect(updateDraft(contextFor(clock), {
      draftId: "paired",
      patch: {
        analysis: {
          method: "jinn.benchmarking.method/paired-delta",
          version: "1",
          baseline: "baseline",
          candidate: "sample",
          parameters: { seed: 1, resamples: 10, alpha: "0.05" },
        },
      },
    }).ok).toBe(true);
    const quoted = await runQuote(contextFor(clock), { draftId: "paired" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);

    const planned = draftSampleSizeAdvisory(workspaceDir, "paired");
    expect(planned?.unboundedReadouts).toEqual(["paired-delta@1"]);

    const outcome = runLock(contextFor(clock), { draftId: "paired", acknowledgedSampleSizeAdvisory: true });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    // The surfaces show exactly what the draft advised, scope line included...
    expect(outcome.result.sampleSizeAdvisory).toEqual(planned);
    // ...and the seal still carries the two fields `sample-size-advisory/v1` admits, no more.
    expect(readRunSampleSizeAdvisory(sealedRun("paired")))
      .toEqual({ n: planned?.n, expectedIntervalWidth: planned?.expectedIntervalWidth });
  });
});

describe("draftSampleSizeAdvisory", () => {
  /**
   * Issue #3908. `declaredAnalyses` spreads `spec.additionalAnalyses` after `spec.analysis`, and
   * nothing exercised that spread from a draft: the unit tests pass `declaredAnalyses` straight in
   * and the integration case declares only `spec.analysis`, so dropping the spread passed the whole
   * suite. This is the case that fails when it is dropped.
   */
  test("names the readouts additionalAnalyses declares, after the primary one", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    expect(createDraft(contextFor(clock), { draftId: "plan", name: "Plan" }).ok).toBe(true);
    await sampleInit(contextFor(clock), { draftId: "plan" });
    armAdd(contextFor(clock), { draftId: "plan", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId: "plan", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    expect(updateDraft(contextFor(clock), {
      draftId: "plan",
      patch: {
        analysis: {
          method: "jinn.benchmarking.method/paired-delta",
          version: "1",
          baseline: "baseline",
          candidate: "sample",
          parameters: { seed: 1, resamples: 10, alpha: "0.05" },
        },
        additionalAnalyses: [{ method: "jinn.benchmarking.method/avg-at-k", version: "1" }],
      },
    }).ok).toBe(true);
    const quoted = await runQuote(contextFor(clock), { draftId: "plan" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);

    // Primary first, then the additional entry -- the order `buildAnalysisPlan` seals them in.
    expect(draftSampleSizeAdvisory(workspaceDir, "plan")?.unboundedReadouts)
      .toEqual(["paired-delta@1", "avg-at-k@1"]);
  });

  test("is undefined for a draft no lock could seal yet, so the lock's own refusal is the answer", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "bare", name: "Bare" });
    // No benchmark, not quoted: there is no n to advise about.
    expect(draftSampleSizeAdvisory(workspaceDir, "bare")).toBeUndefined();
    expect(runLock(contextFor(clock), { draftId: "bare" }).ok).toBe(false);
  });
});
