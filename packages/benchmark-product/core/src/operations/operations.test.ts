import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditEntrySchema, readAuditEntries } from "../audit/journal.js";
import { GATED_OPERATIONS, readAuthorityPolicy } from "../authority/policy.js";
import { resolveAssurance, type DraftDocument } from "../domain/draft.js";
import { artifactsDir, draftPath, draftsDir, journalPath, recordsDir, workspaceMetadataPath } from "../workspace/layout.js";
import type { OperationContext } from "./context.js";
import { createDraft, getDraft, listDrafts, updateDraft } from "./drafts.js";
import { inspectDraft } from "./inspect.js";
import { initWorkspace } from "./init.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp10-ops-"));
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

const HEX64 = /^[a-f0-9]{64}$/;

describe("initWorkspace", () => {
  test("creates the workspace layout and the founding authority policy, and audits exactly one entry", () => {
    const clock = makeClock();
    const context = contextFor(workspaceDir, clock);

    const outcome = initWorkspace(context);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.workspace.storageVersion).toBe(1);

    expect(existsSync(workspaceMetadataPath(workspaceDir))).toBe(true);
    expect(existsSync(draftsDir(workspaceDir))).toBe(true);
    expect(existsSync(recordsDir(workspaceDir))).toBe(true);
    expect(existsSync(artifactsDir(workspaceDir))).toBe(true);

    const policy = readAuthorityPolicy(workspaceDir);
    expect(policy.principals).toEqual([{ id: "sponsor-1", role: "sponsor", grants: [...GATED_OPERATIONS] }]);

    const entries = readAuditEntries(workspaceDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: "sponsor-1", action: "init", subject: "workspace", outcome: "ok" });
    expect(entries[0]?.inputsDigest).toMatch(HEX64);
  });

  test("refuses conflict on an already-initialized workspace, without a new audit entry", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));

    const outcome = initWorkspace(contextFor(workspaceDir, clock));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
    expect(readAuditEntries(workspaceDir)).toHaveLength(1);
  });
});

describe("createDraft", () => {
  test("name-only draft gets the DRAFT_SPEC_DEFAULTS, a slugged draftId, and createdAt === updatedAt === the entry's at", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));

    const outcome = createDraft(contextFor(workspaceDir, clock), { name: "My Bench Run" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const draft = outcome.result.draft;
    expect(draft.draftId).toBe("my-bench-run");
    expect(draft.state).toBe("draft");
    expect(draft.spec.taskSet).toEqual({ kind: "pendingSample" });
    expect(draft.spec.venue).toBe("self-run");
    expect(draft.spec.assurance).toEqual({ preset: "direct-check" });
    expect(draft.spec.replicates).toBe(1);
    expect(draft.createdAt).toBe(draft.updatedAt);

    const entries = readAuditEntries(workspaceDir);
    const created = entries.find((entry) => entry.action === "draft.create");
    expect(created?.at).toBe(draft.createdAt);
  });

  test("createDraft with an explicit spec parses and persists two arms, replicates 2, and the evaluator-panel preset", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));

    const outcome = createDraft(contextFor(workspaceDir, clock), {
      name: "Two Arms",
      spec: {
        arms: [
          { armId: "arm-a", pinning: { harness: "prediction-v1-baseline", isolationPolicy: "unrestricted" } },
          { armId: "arm-b", pinning: { harness: "claude-code", isolationPolicy: "unrestricted" } },
        ],
        replicates: 2,
        assurance: { preset: "evaluator-panel" },
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.spec.arms).toHaveLength(2);
    expect(outcome.result.draft.spec.replicates).toBe(2);
    expect(outcome.result.draft.spec.assurance).toEqual({ preset: "evaluator-panel" });

    const persisted = JSON.parse(
      readFileSync(draftPath(workspaceDir, outcome.result.draft.draftId), "utf8"),
    ) as DraftDocument;
    expect(persisted.spec.arms).toHaveLength(2);
  });

  test("a duplicate draftId refuses conflict, and the refusal is itself audited", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    createDraft(contextFor(workspaceDir, clock), { name: "Dup" });

    const before = readAuditEntries(workspaceDir).length;
    const outcome = createDraft(contextFor(workspaceDir, clock), { name: "Dup" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");

    const entries = readAuditEntries(workspaceDir);
    expect(entries).toHaveLength(before + 1);
    expect(entries[entries.length - 1]?.outcome).toBe("conflict");
  });
});

describe("updateDraft", () => {
  test("patches arms and policy, advances updatedAt, and audits ok", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    const created = createDraft(contextFor(workspaceDir, clock), { name: "Patchable" });
    if (!created.ok) throw new Error("setup failed");

    const outcome = updateDraft(contextFor(workspaceDir, clock), {
      draftId: created.result.draft.draftId,
      patch: {
        arms: [{ armId: "arm-a", pinning: { harness: "prediction-v1-baseline" } }],
        policy: {
          completenessFloor: "0.9",
          cellWindowMs: 1_000,
          replacement: { allowed: true, maxPerCell: 2 },
          closeAfterMs: 2_000,
        },
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.spec.arms).toEqual([{ armId: "arm-a", pinning: { harness: "prediction-v1-baseline" } }]);
    expect(outcome.result.draft.spec.policy.completenessFloor).toBe("0.9");
    expect(outcome.result.draft.updatedAt).not.toBe(created.result.draft.createdAt);

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "draft.update", outcome: "ok" });
  });

  test("editing a quoted draft invalidates the quote (state returns to draft)", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    const created = createDraft(contextFor(workspaceDir, clock), { name: "Quoted" });
    if (!created.ok) throw new Error("setup failed");
    const path = draftPath(workspaceDir, created.result.draft.draftId);
    writeFileSync(path, JSON.stringify({ ...created.result.draft, state: "quoted" }, null, 2));

    const outcome = updateDraft(contextFor(workspaceDir, clock), {
      draftId: created.result.draft.draftId,
      patch: { replicates: 5 },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.state).toBe("draft");
  });

  test("a locked draft refuses mutation: file byte-unchanged, exactly one illegal-transition audit entry", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    const created = createDraft(contextFor(workspaceDir, clock), { name: "Locked" });
    if (!created.ok) throw new Error("setup failed");
    const path = draftPath(workspaceDir, created.result.draft.draftId);
    const lockedBytes = JSON.stringify({ ...created.result.draft, state: "locked" }, null, 2);
    writeFileSync(path, lockedBytes);

    const before = readAuditEntries(workspaceDir).length;
    const outcome = updateDraft(contextFor(workspaceDir, clock), {
      draftId: created.result.draft.draftId,
      patch: { replicates: 9 },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
    expect(readFileSync(path, "utf8")).toBe(lockedBytes);

    const entries = readAuditEntries(workspaceDir);
    expect(entries).toHaveLength(before + 1);
    expect(entries[entries.length - 1]?.outcome).toBe("illegal-transition");
  });
});

describe("authority", () => {
  test("a non-member principal is refused authority-denied, and the denial is audited under its own identity", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    const created = createDraft(contextFor(workspaceDir, clock), { name: "Gated" });
    if (!created.ok) throw new Error("setup failed");

    const outcome = getDraft(contextFor(workspaceDir, clock, "stranger"), { draftId: created.result.draft.draftId });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("authority-denied");

    const entries = readAuditEntries(workspaceDir);
    const last = entries[entries.length - 1];
    expect(last?.actor).toBe("stranger");
    expect(last?.outcome).toBe("authority-denied");
  });
});

describe("getDraft", () => {
  test("reads back a draft that exists, and refuses not-found for one that does not (both audited)", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    const created = createDraft(contextFor(workspaceDir, clock), { name: "Findable" });
    if (!created.ok) throw new Error("setup failed");

    const ok = getDraft(contextFor(workspaceDir, clock), { draftId: created.result.draft.draftId });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.result.draft.draftId).toBe(created.result.draft.draftId);

    const missing = getDraft(contextFor(workspaceDir, clock), { draftId: "ghost" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not-found");

    const entries = readAuditEntries(workspaceDir);
    expect(entries.some((entry) => entry.action === "draft.get" && entry.outcome === "ok")).toBe(true);
    expect(entries.some((entry) => entry.action === "draft.get" && entry.outcome === "not-found")).toBe(true);
  });
});

describe("listDrafts", () => {
  test("returns every draft sorted by draftId, ascending lexicographic", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    createDraft(contextFor(workspaceDir, clock), { name: "Charlie" });
    createDraft(contextFor(workspaceDir, clock), { name: "Alpha" });
    createDraft(contextFor(workspaceDir, clock), { name: "Bravo" });

    const outcome = listDrafts(contextFor(workspaceDir, clock));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.drafts.map((draft) => draft.draftId)).toEqual(["alpha", "bravo", "charlie"]);
    for (const summary of outcome.result.drafts) {
      expect(summary).toMatchObject({ name: expect.any(String), state: "draft" });
      expect(summary.createdAt).toBeTruthy();
      expect(summary.updatedAt).toBeTruthy();
    }
  });
});

describe("inspectDraft", () => {
  test("echoes per-arm pinning and resolves the assurance preset to its primitives", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    const created = createDraft(contextFor(workspaceDir, clock), {
      name: "Inspectable",
      spec: {
        arms: [{ armId: "arm-a", pinning: { harness: "prediction-v1-baseline" }, notes: "control" }],
        assurance: { preset: "evaluator-panel" },
      },
    });
    if (!created.ok) throw new Error("setup failed");

    const outcome = inspectDraft(contextFor(workspaceDir, clock), { draftId: created.result.draft.draftId });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.inspection.arms).toEqual([
      { armId: "arm-a", pinning: { harness: "prediction-v1-baseline" }, notes: "control" },
    ]);
    expect(outcome.result.inspection.assurance.resolved).toEqual(resolveAssurance({ preset: "evaluator-panel" }));
    expect(outcome.result.inspection.assurance.resolved).toEqual({
      independence: "gating",
      minVerdicts: 2,
      distinctEvaluator: true,
      verdictRule: "majority",
    });
  });
});

describe("AC4 — exactly one audit entry per operation, across a mixed sequence", () => {
  test("8 operations (mixed ok / typed failures / authority denial) produce exactly 8 ordered, attributed entries", () => {
    const clock = makeClock();

    const results: Array<{ ok: boolean }> = [];
    results.push(initWorkspace(contextFor(workspaceDir, clock))); // 1: ok, actor sponsor-1

    const created = createDraft(contextFor(workspaceDir, clock), { name: "Alpha" }); // 2: ok
    results.push(created);
    if (!created.ok) throw new Error("setup failed");

    results.push(
      updateDraft(contextFor(workspaceDir, clock), {
        draftId: created.result.draft.draftId,
        patch: { replicates: 3 },
      }),
    ); // 3: ok

    results.push(getDraft(contextFor(workspaceDir, clock), { draftId: created.result.draft.draftId })); // 4: ok
    results.push(getDraft(contextFor(workspaceDir, clock), { draftId: "ghost" })); // 5: not-found
    results.push(createDraft(contextFor(workspaceDir, clock), { name: "Alpha" })); // 6: conflict (same slug)

    const lockedPath = draftPath(workspaceDir, "locked-draft");
    writeFileSync(
      lockedPath,
      JSON.stringify({ ...created.result.draft, draftId: "locked-draft", state: "locked" }, null, 2),
    );
    results.push(updateDraft(contextFor(workspaceDir, clock), { draftId: "locked-draft", patch: {} })); // 7: illegal-transition

    results.push(
      getDraft(contextFor(workspaceDir, clock, "stranger"), { draftId: created.result.draft.draftId }),
    ); // 8: authority-denied

    expect(results).toHaveLength(8);

    const entries = readAuditEntries(workspaceDir);
    expect(entries).toHaveLength(8);

    for (const entry of entries) {
      expect(AuditEntrySchema.safeParse(entry).success).toBe(true);
    }

    expect(entries.map((entry) => entry.outcome)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "not-found",
      "conflict",
      "illegal-transition",
      "authority-denied",
    ]);

    expect(entries.map((entry) => entry.actor)).toEqual([
      "sponsor-1",
      "sponsor-1",
      "sponsor-1",
      "sponsor-1",
      "sponsor-1",
      "sponsor-1",
      "sponsor-1",
      "stranger",
    ]);
  });
});

describe("non-workspace directory", () => {
  test("an operation against a directory that is not a workspace refuses not-found and appends nothing", () => {
    const clock = makeClock();
    const freshDir = mkdtempSync(join(tmpdir(), "bp10-ops-nonws-"));
    try {
      const outcome = getDraft(contextFor(freshDir, clock), { draftId: "whatever" });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("not-found");
      expect(existsSync(journalPath(freshDir))).toBe(false);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
