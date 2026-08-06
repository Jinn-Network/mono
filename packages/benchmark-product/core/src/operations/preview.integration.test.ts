/**
 * BP-20 AC1 — the real-subprocess proof: one preview run against the REAL local venue
 * (`../venue/venue.js`'s `createLocalVenue`, the default `runPreview` deps), real
 * subprocess-spawning launchers — no fake backend. Pattern mirrors
 * `../run/run-path.integration.test.ts` (real wall clock, sample benchmark, two arms via
 * `SOLVE_HARNESS_PINS`), scaled down to `items: 1` (2 solve cells) to keep the run fast.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PREVIEW_MARKER } from "../run/preview-log.js";
import { SOLVE_HARNESS_PINS } from "../venue/venue.js";
import { previewArtifactPath } from "../workspace/layout.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runPreview } from "./preview.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp20-preview-integration-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** The REAL wall clock — see `run-path.integration.test.ts`'s own note: this test drives the
 * real local venue's real subprocess supervisor, whose deadline bookkeeping compares against
 * actual OS time. */
function makeClock(): () => string {
  return () => new Date().toISOString();
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function snapshotDir(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else {
        snapshot[relative(root, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  }
  walk(root);
  return snapshot;
}

function officialStateSnapshot(): Record<string, string> {
  return {
    ...snapshotDir(join(workspaceDir, "drafts")),
    ...snapshotDir(join(workspaceDir, "records")),
    ...snapshotDir(join(workspaceDir, "runs")),
  };
}

describe("preview — real local venue, real subprocesses (AC1)", () => {
  test(
    "items: 1 rehearses exactly 2 solve cells (2 real launchers x 1 item) on the real backend, and leaves official state byte-unchanged",
    async () => {
      const clock = makeClock();
      const draftId = "draft-1";

      const initialized = initWorkspace(contextFor(clock));
      expect(initialized.ok).toBe(true);
      const created = createDraft(contextFor(clock), { draftId, name: "Preview Integration" });
      expect(created.ok).toBe(true);

      const sample = await sampleInit(contextFor(clock), { draftId });
      expect(sample.ok).toBe(true);
      if (!sample.ok) throw new Error("unreachable");
      expect(sample.result.tasks).toHaveLength(3);

      const baselineArm = armAdd(contextFor(clock), {
        draftId,
        armId: "baseline",
        pinning: { harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"] },
      });
      expect(baselineArm.ok).toBe(true);
      const sampleArm = armAdd(contextFor(clock), {
        draftId,
        armId: "sample-uniform",
        pinning: { harness: SOLVE_HARNESS_PINS["sample-uniform"] },
      });
      expect(sampleArm.ok).toBe(true);

      const before = officialStateSnapshot();

      const preview = await runPreview(contextFor(clock), { draftId, items: 1 });
      expect(preview.ok, JSON.stringify(preview)).toBe(true);
      if (!preview.ok) throw new Error("unreachable");

      expect(preview.result.preview.marker).toBe(PREVIEW_MARKER);
      expect(preview.result.preview.scope).toBe("solve-cells-only");
      expect(preview.result.preview.itemCount).toBe(1);
      expect(preview.result.preview.cellCount).toBe(2);
      expect(preview.result.preview.arms).toHaveLength(2);
      const totalOutcomes = preview.result.preview.arms.reduce(
        (sum, arm) => sum + arm.outcomes.delivered + arm.outcomes.failed + arm.outcomes.expired
          + arm.outcomes.cancelled + arm.outcomes.other,
        0,
      );
      expect(totalOutcomes).toBe(2);

      const artifactPath = previewArtifactPath(workspaceDir, draftId, "preview-001");
      expect(existsSync(artifactPath)).toBe(true);
      const artifactOnDisk = JSON.parse(readFileSync(artifactPath, "utf8")) as typeof preview.result.preview;
      expect(artifactOnDisk).toEqual(preview.result.preview);

      const after = officialStateSnapshot();
      expect(after).toEqual(before);
    },
    120_000,
  );
});
