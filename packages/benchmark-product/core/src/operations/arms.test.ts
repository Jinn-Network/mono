import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAuditEntries } from "../audit/journal.js";
import { draftPath } from "../workspace/layout.js";
import { armAdd, armList, armRemove, armUpdate } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp11-arms-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-05T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(dir: string, clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir: dir, principal, clock };
}

// The packet's canonical pinnings — pinning is data, and arm definition must not
// require any launcher to exist for either of these harness ids.
const BASELINE_PINNING = { harness: { id: "prediction-v1-baseline" }, isolationPolicy: "unrestricted" };
const SAMPLE_PINNING = { harness: { id: "sample-uniform" }, isolationPolicy: "unrestricted" };

function setupDraft(clock: () => string): string {
  initWorkspace(contextFor(workspaceDir, clock));
  const created = createDraft(contextFor(workspaceDir, clock), { name: "Arms Draft" });
  if (!created.ok) throw new Error("setup failed");
  return created.result.draft.draftId;
}

describe("armAdd / armList", () => {
  test("adding two arms with distinct pinning lists both with no warnings", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);

    armAdd(contextFor(workspaceDir, clock), { draftId, armId: "baseline", pinning: BASELINE_PINNING });
    armAdd(contextFor(workspaceDir, clock), { draftId, armId: "sample-uniform", pinning: SAMPLE_PINNING });

    const outcome = armList(contextFor(workspaceDir, clock), { draftId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.arms.map((arm) => arm.armId)).toEqual(["baseline", "sample-uniform"]);
    expect(outcome.result.warnings).toEqual([]);
  });

  test("a third arm with pinning identical to an existing arm's warns duplicate-pinning naming both armIds", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    armAdd(contextFor(workspaceDir, clock), { draftId, armId: "baseline", pinning: BASELINE_PINNING });
    armAdd(contextFor(workspaceDir, clock), { draftId, armId: "sample-uniform", pinning: SAMPLE_PINNING });

    const outcome = armAdd(contextFor(workspaceDir, clock), {
      draftId,
      armId: "baseline-copy",
      pinning: BASELINE_PINNING,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.warnings).toEqual([
      { code: "duplicate-pinning", armIds: ["baseline", "baseline-copy"], detail: expect.any(String) },
    ]);
  });

  test("an armId containing a space refuses validation", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    const outcome = armAdd(contextFor(workspaceDir, clock), {
      draftId,
      armId: "has space",
      pinning: BASELINE_PINNING,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");
  });

  test("a 65-character armId refuses validation", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    const outcome = armAdd(contextFor(workspaceDir, clock), {
      draftId,
      armId: "a".repeat(65),
      pinning: BASELINE_PINNING,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");
  });

  test("a non-object pinning refuses validation", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    const outcome = armAdd(contextFor(workspaceDir, clock), { draftId, armId: "baseline", pinning: "not-an-object" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");
  });

  test("adding a duplicate armId refuses conflict", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    armAdd(contextFor(workspaceDir, clock), { draftId, armId: "baseline", pinning: BASELINE_PINNING });

    const outcome = armAdd(contextFor(workspaceDir, clock), { draftId, armId: "baseline", pinning: SAMPLE_PINNING });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
  });
});

describe("armUpdate", () => {
  test("replaces pinning wholesale and leaves notes untouched when omitted", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    armAdd(contextFor(workspaceDir, clock), {
      draftId,
      armId: "baseline",
      pinning: BASELINE_PINNING,
      notes: "control",
    });

    const outcome = armUpdate(contextFor(workspaceDir, clock), { draftId, armId: "baseline", pinning: SAMPLE_PINNING });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const arm = outcome.result.draft.spec.arms.find((candidate) => candidate.armId === "baseline");
    expect(arm?.pinning).toEqual(SAMPLE_PINNING);
    expect(arm?.notes).toBe("control");
  });

  test("updating a missing arm refuses not-found", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    const outcome = armUpdate(contextFor(workspaceDir, clock), { draftId, armId: "ghost", pinning: BASELINE_PINNING });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("not-found");
  });
});

describe("armRemove", () => {
  test("removes an existing arm", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    armAdd(contextFor(workspaceDir, clock), { draftId, armId: "baseline", pinning: BASELINE_PINNING });
    armAdd(contextFor(workspaceDir, clock), { draftId, armId: "sample-uniform", pinning: SAMPLE_PINNING });

    const outcome = armRemove(contextFor(workspaceDir, clock), { draftId, armId: "baseline" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.spec.arms.map((arm) => arm.armId)).toEqual(["sample-uniform"]);
  });

  test("removing a missing arm refuses not-found", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    const outcome = armRemove(contextFor(workspaceDir, clock), { draftId, armId: "ghost" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("not-found");
  });
});

describe("audit", () => {
  test("every arm operation — add, update, list, remove — appends exactly one audit entry", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    const before = readAuditEntries(workspaceDir).length;

    armAdd(contextFor(workspaceDir, clock), { draftId, armId: "baseline", pinning: BASELINE_PINNING });
    armUpdate(contextFor(workspaceDir, clock), { draftId, armId: "baseline", notes: "updated" });
    armList(contextFor(workspaceDir, clock), { draftId });
    armRemove(contextFor(workspaceDir, clock), { draftId, armId: "baseline" });

    const entries = readAuditEntries(workspaceDir).slice(before);
    expect(entries.map((entry) => entry.action)).toEqual(["arm.add", "arm.update", "arm.list", "arm.remove"]);
    for (const entry of entries) expect(entry.outcome).toBe("ok");
  });
});

describe("mutability", () => {
  test("a locked draft refuses arm mutation", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    const path = draftPath(workspaceDir, draftId);
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...document, state: "locked" }, null, 2));

    const outcome = armAdd(contextFor(workspaceDir, clock), {
      draftId,
      armId: "baseline",
      pinning: BASELINE_PINNING,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("arm mutation on a quoted draft drives it back to draft (A2: any edit invalidates the quote)", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);
    const path = draftPath(workspaceDir, draftId);
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...document, state: "quoted" }, null, 2));

    const outcome = armAdd(contextFor(workspaceDir, clock), {
      draftId,
      armId: "baseline",
      pinning: BASELINE_PINNING,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.state).toBe("draft");
  });
});
