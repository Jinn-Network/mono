import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OperationContext } from "./context.js";
import { createDraft, updateDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp10-drafts-"));
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

describe("updateDraft — analysis field", () => {
  test("permits patching the analysis field", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    const created = createDraft(contextFor(workspaceDir, clock), { name: "Patchable Analysis" });
    if (!created.ok) throw new Error("setup failed");

    const outcome = updateDraft(contextFor(workspaceDir, clock), {
      draftId: created.result.draft.draftId,
      patch: {
        analysis: {
          method: "jinn.benchmarking.method/paired-delta",
          version: "1",
          baseline: "armA",
          candidate: "armB",
        },
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.spec.analysis?.candidate).toBe("armB");
  });
});

describe("updateDraft — additionalAnalyses field (packet P5, spec §8.3 option 5)", () => {
  test("permits patching the additionalAnalyses field", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    const created = createDraft(contextFor(workspaceDir, clock), { name: "Patchable Additional Analyses" });
    if (!created.ok) throw new Error("setup failed");

    const outcome = updateDraft(contextFor(workspaceDir, clock), {
      draftId: created.result.draft.draftId,
      patch: {
        additionalAnalyses: [{ method: "jinn.benchmarking.method/avg-at-k", version: "1" }],
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.spec.additionalAnalyses).toEqual([{ method: "jinn.benchmarking.method/avg-at-k", version: "1" }]);
  });

  test("an unknown sibling key in the same patch still refuses, additionalAnalyses being allowlisted notwithstanding", () => {
    const clock = makeClock();
    initWorkspace(contextFor(workspaceDir, clock));
    const created = createDraft(contextFor(workspaceDir, clock), { name: "Unknown Sibling Key" });
    if (!created.ok) throw new Error("setup failed");

    const outcome = updateDraft(contextFor(workspaceDir, clock), {
      draftId: created.result.draft.draftId,
      patch: {
        additionalAnalyses: [{ method: "jinn.benchmarking.method/avg-at-k", version: "1" }],
        notARealField: true,
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");
    expect(outcome.error.issues?.[0]?.message).toMatch(/unknown draft spec field: notARealField/);
  });
});
