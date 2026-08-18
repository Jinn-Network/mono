import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ANCHOR_INTENT_EXTENSION,
  parseRun,
  readRunAnchorIntentExtension,
  sealRun,
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
import { runLock } from "./run-lock.js";
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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);
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
  }, 30_000);

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
  }, 30_000);
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
  }, 30_000);

  test("armAdd refuses illegal-transition on a locked draft", async () => {
    const clock = makeClock();
    await setUpQuotedDraft(clock);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok).toBe(true);

    const outcome = armAdd(contextFor(clock), { draftId: "draft-1", armId: "late", pinning: {} });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  }, 30_000);
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
