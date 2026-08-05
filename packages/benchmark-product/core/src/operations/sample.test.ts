import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAuditEntries } from "../audit/journal.js";
import type { DraftDocument } from "../domain/draft.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp11-ops-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** A deterministic, per-test injectable clock: each call advances a counter (spec §5.1 A-injected-clock). */
function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-05T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(dir: string, clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir: dir, principal, clock };
}

function setupDraft(clock: () => string): string {
  initWorkspace(contextFor(workspaceDir, clock));
  const created = createDraft(contextFor(workspaceDir, clock), { name: "Sampled" });
  if (!created.ok) throw new Error("setup failed");
  return created.result.draft.draftId;
}

const HEX64 = /^[a-f0-9]{64}$/;

describe("sampleInit", () => {
  test("attaches the bundled sample benchmark to a pendingSample draft, audits ok exactly once", async () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);

    const outcome = await sampleInit(contextFor(workspaceDir, clock), { draftId });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.benchmarkSha256).toMatch(HEX64);
    expect(outcome.result.evaluationSpecSha256).toMatch(HEX64);
    expect(outcome.result.tasks.length).toBeGreaterThanOrEqual(2);
    for (const task of outcome.result.tasks) {
      expect(task.taskSha256).toMatch(HEX64);
      expect(task.receiptSha256).toMatch(HEX64);
      expect(task.marketId.length).toBeGreaterThan(0);
    }

    expect(outcome.result.draft.spec.taskSet).toEqual({
      kind: "benchmark",
      benchmarkSha256: outcome.result.benchmarkSha256,
    });

    const persisted = JSON.parse(readFileSync(draftPath(workspaceDir, draftId), "utf8")) as DraftDocument;
    expect(persisted.spec.taskSet).toEqual({ kind: "benchmark", benchmarkSha256: outcome.result.benchmarkSha256 });

    const storedBenchmark = getSealedBytes(workspaceDir, outcome.result.benchmarkSha256);
    expect(storedBenchmark.length).toBeGreaterThan(0);

    const entries = readAuditEntries(workspaceDir);
    const sampleEntries = entries.filter((entry) => entry.action === "sample.init");
    expect(sampleEntries).toHaveLength(1);
    expect(sampleEntries[0]).toMatchObject({ subject: draftId, outcome: "ok" });
  });

  test("a second sample.init on the same draft refuses conflict; both attempts are audited", async () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    const first = await sampleInit(contextFor(workspaceDir, clock), { draftId });
    expect(first.ok).toBe(true);

    const outcome = await sampleInit(contextFor(workspaceDir, clock), { draftId });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");

    const entries = readAuditEntries(workspaceDir).filter((entry) => entry.action === "sample.init");
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.outcome)).toEqual(["ok", "conflict"]);
  });

  test("an unknown draft refuses not-found, and the refusal is audited", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));

    const outcome = await sampleInit(contextFor(workspaceDir, clock), { draftId: "ghost" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("not-found");

    const entries = readAuditEntries(workspaceDir);
    const last = entries[entries.length - 1];
    expect(last?.action).toBe("sample.init");
    expect(last?.outcome).toBe("not-found");
  });

  test("a non-member principal is refused authority-denied, and the denial is audited under its own identity", async () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);

    const outcome = await sampleInit(contextFor(workspaceDir, clock, "stranger"), { draftId });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("authority-denied");

    const entries = readAuditEntries(workspaceDir);
    const last = entries[entries.length - 1];
    expect(last?.actor).toBe("stranger");
    expect(last?.outcome).toBe("authority-denied");
  });
});
