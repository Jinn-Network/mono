import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readAuditEntries } from "../audit/journal.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { importSweBenchRows } from "./import.js";
import { inspectDraft } from "./inspect.js";
import { initWorkspace } from "./init.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp11-import-"));
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

// The platform's own public importer fixture (packages/benchmarking/interop/fixtures/swebench/row.json).
const GOLDEN_ROW = {
  instance_id: "swe-rebench-2024-00042",
  repo: "psf/requests",
  base_commit: "d8bdd423ab2df9f87b7975cdb32b31f3002a20c0",
  problem_statement: "Fix the connection pool leak when retries are exhausted.",
  language: "python",
  image: {
    uri: "https://example.org/images/swe-rebench-runner:2024-00042",
    digest: { sha256: "e8d6cfe4f52e87a1292f3897bf0bea28e4bde32703e6792bb9b1bc60d3024817" },
  },
  testMaterial: [{ uri: "https://example.org/tests/swe-rebench-2024-00042/test_pool.py" }],
  parser: {
    id: "jinn.parser.pytest-json-report",
    version: "1.0.0",
    digest: "sha256:d2136b44c86f551b2494d616a8ee7afd58e6f90681f1beb84441113154a13897",
  },
  transitions: {
    failToPass: ["test_pool.py::test_retry_releases_connection"],
    passToPass: ["test_pool.py::test_basic_get"],
  },
  timeout: 1800,
};

function setupDraft(clock: () => string, name = "Import Target", spec?: Record<string, unknown>): string {
  initWorkspace(contextFor(workspaceDir, clock));
  const created = createDraft(contextFor(workspaceDir, clock), { name, ...(spec !== undefined ? { spec } : {}) });
  if (!created.ok) throw new Error("setup failed");
  return created.result.draft.draftId;
}

describe("importSweBenchRows", () => {
  test("happy path: attaches a benchmark task set, stores bytes, audits one ok entry", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock);

    const outcome = importSweBenchRows(contextFor(workspaceDir, clock), { draftId, rows: [GOLDEN_ROW] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.spec.taskSet).toEqual({
      kind: "benchmark",
      benchmarkSha256: outcome.result.benchmarkSha256,
    });
    expect(outcome.result.taskSha256s).toHaveLength(1);

    expect(() => getSealedBytes(workspaceDir, outcome.result.benchmarkSha256)).not.toThrow();
    for (const taskSha256 of outcome.result.taskSha256s) {
      expect(() => getSealedBytes(workspaceDir, taskSha256)).not.toThrow();
    }

    const entries = readAuditEntries(workspaceDir);
    const importEntries = entries.filter((entry) => entry.action === "import.swebench");
    expect(importEntries).toHaveLength(1);
    expect(importEntries[0]?.outcome).toBe("ok");
  });

  test("persists every imported task's EvaluationSpec bytes under the digest its Task references", () => {
    const clock = makeClock();
    const context = contextFor(workspaceDir, clock);
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId: "d1", name: "Import" }).ok).toBe(true);
    const imported = importSweBenchRows(context, { draftId: "d1", rows: [GOLDEN_ROW] });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) throw new Error("unreachable");

    expect(imported.result.evaluationSpecSha256s).toHaveLength(1);

    // The binding property: the bytes must be retrievable under exactly the digest the sealed Task
    // points at, because that is the only key the venue's evaluation path ever looks up
    // (run/drive.ts:358-374). A digest that resolves to nothing is what made SWE tasks ungradeable.
    for (const taskSha256 of imported.result.taskSha256s) {
      const taskDoc = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, taskSha256))) as {
        evaluation?: { digest?: { sha256?: string } };
      };
      const specSha256 = taskDoc.evaluation?.digest?.sha256;
      expect(specSha256).toMatch(/^[a-f0-9]{64}$/u);
      const specBytes = getSealedBytes(workspaceDir, specSha256 as string);
      expect(specBytes.byteLength).toBeGreaterThan(0);
      expect(imported.result.evaluationSpecSha256s).toContain(specSha256);
    }
  });

  test("the retained bytes parse as the EvaluationSpec the Task actually commits to", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock, "Spec Shape");

    const outcome = importSweBenchRows(contextFor(workspaceDir, clock), { draftId, rows: [GOLDEN_ROW] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Resolving to *some* bytes is not enough — they must be this row's spec. Storing the wrong
    // spec under a resolvable digest would grade every attempt against the wrong transitions,
    // and no digest check downstream would catch it.
    const specBytes = getSealedBytes(workspaceDir, outcome.result.evaluationSpecSha256s[0] as string);
    const spec = JSON.parse(new TextDecoder().decode(specBytes)) as {
      family?: string;
      familyBlock?: { transitions?: { failToPass?: string[] }; timeout?: number };
    };
    expect(spec.family).toBe("deterministic-process");
    expect(spec.familyBlock?.transitions?.failToPass).toEqual(GOLDEN_ROW.transitions.failToPass);
    expect(spec.familyBlock?.timeout).toBe(GOLDEN_ROW.timeout);
  });

  test("a multi-row import associates each Task with its own spec, not merely with some spec", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock, "Multi Row");

    // A single-row import cannot catch a dropped or mis-associated spec: `toContain` is trivially
    // satisfied when there is one of everything. Two rows with DIFFERENT transitions make the
    // association observable.
    const second = {
      ...GOLDEN_ROW,
      instance_id: "swe-rebench-2024-00043",
      transitions: { failToPass: ["test_pool.py::test_second_only"], passToPass: [] },
    };
    const outcome = importSweBenchRows(contextFor(workspaceDir, clock), {
      draftId,
      rows: [GOLDEN_ROW, second],
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.evaluationSpecSha256s).toHaveLength(2);
    expect(new Set(outcome.result.evaluationSpecSha256s).size).toBe(2);

    const transitionsFor = (taskSha256: string): string[] => {
      const taskDoc = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, taskSha256))) as {
        evaluation?: { digest?: { sha256?: string } };
      };
      const specBytes = getSealedBytes(workspaceDir, taskDoc.evaluation!.digest!.sha256!);
      const spec = JSON.parse(new TextDecoder().decode(specBytes)) as {
        familyBlock?: { transitions?: { failToPass?: string[] } };
      };
      return spec.familyBlock?.transitions?.failToPass ?? [];
    };

    const resolved = outcome.result.taskSha256s.map(transitionsFor);
    expect(resolved).toContainEqual(GOLDEN_ROW.transitions.failToPass);
    expect(resolved).toContainEqual(second.transitions.failToPass);
  });

  test("a duplicate-row file refuses validation naming benchmark-item-distinctness, audited", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock, "Dup Rows");

    const outcome = importSweBenchRows(contextFor(workspaceDir, clock), {
      draftId,
      rows: [GOLDEN_ROW, GOLDEN_ROW],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");
    expect(outcome.error.issues?.[0]?.path).toBe("benchmark-item-distinctness");

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "import.swebench", outcome: "validation" });
  });

  test("re-importing onto an already-attached draft refuses conflict", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock, "Reimport");

    const first = importSweBenchRows(contextFor(workspaceDir, clock), { draftId, rows: [GOLDEN_ROW] });
    expect(first.ok).toBe(true);

    const second = importSweBenchRows(contextFor(workspaceDir, clock), { draftId, rows: [GOLDEN_ROW] });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("conflict");
  });

  test("attaching to a quoted draft drives it back to draft (A2: any edit invalidates the quote)", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock, "Quoted Attach");
    const path = draftPath(workspaceDir, draftId);
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...document, state: "quoted" }, null, 2));

    const outcome = importSweBenchRows(contextFor(workspaceDir, clock), { draftId, rows: [GOLDEN_ROW] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.state).toBe("draft");
  });

  test("a non-member principal is refused authority-denied", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock, "Gated");

    const outcome = importSweBenchRows(contextFor(workspaceDir, clock, "stranger"), {
      draftId,
      rows: [GOLDEN_ROW],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("authority-denied");
  });
});

describe("inspectDraft after a swebench import (preset primitives)", () => {
  test("shows itemCount, stored bytes, evaluationSha256, arm pinning, and resolved assurance", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock, "Inspectable Import", {
      arms: [
        {
          armId: "baseline",
          pinning: { harness: { id: "prediction-v1-baseline" }, isolationPolicy: "unrestricted" },
        },
      ],
      assurance: { preset: "separate-evaluator" },
    });

    const imported = importSweBenchRows(contextFor(workspaceDir, clock), { draftId, rows: [GOLDEN_ROW] });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const outcome = inspectDraft(contextFor(workspaceDir, clock), { draftId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { benchmark, arms, assurance } = outcome.result.inspection;
    expect(benchmark?.benchmarkSha256).toBe(imported.result.benchmarkSha256);
    expect(benchmark?.itemCount).toBe(1);
    expect(benchmark?.items).toHaveLength(1);
    expect(benchmark?.items[0]?.stored).toBe(true);
    expect(benchmark?.items[0]?.evaluationSha256).toBeTruthy();
    expect(arms).toEqual([
      { armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline" }, isolationPolicy: "unrestricted" } },
    ]);
    expect(assurance.resolved.distinctEvaluator).toBe(true);
  });

  test("a pendingSample draft's inspection carries no benchmark axis", () => {
    const clock = makeClock();
    const draftId = setupDraft(clock, "Still Pending");

    const outcome = inspectDraft(contextFor(workspaceDir, clock), { draftId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.inspection.benchmark).toBeUndefined();
  });
});
