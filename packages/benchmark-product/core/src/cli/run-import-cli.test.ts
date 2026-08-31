// SPDX-License-Identifier: Apache-2.0

/**
 * The `run import` verb (#2979): the slate template, both dump dialects, and the refusals that
 * keep the verb from being a quiet way to shrink a denominator.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { sampleInit } from "../operations/sample.js";
import { runCli, USAGE } from "./main.js";
import type { CliContext } from "./result.js";

let workspaceDir: string;
let dumpDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp-run-import-cli-"));
  dumpDir = mkdtempSync(join(tmpdir(), "bp-run-import-cli-dump-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(dumpDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

const clock = makeClock();

/** Every measurement the bundled sample benchmark's sealed EvaluationSpec declares, sorted the
 * way the template emits them. Only `integrity` and `resolved` are read by its verdict rule. */
const SAMPLE_MEASUREMENTS = [
  "brierSpread", "consensusBrier", "integrity", "outcomeYes", "resolved", "solverBrier",
] as const;

function operationContext(principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function cliContext(): CliContext {
  return { cwd: workspaceDir, clock };
}

async function lockedDraft(draftId = "draft-1"): Promise<void> {
  initWorkspace(operationContext());
  createDraft(operationContext(), { draftId, name: "Run Import CLI" });
  const sample = await sampleInit(operationContext(), { draftId });
  expect(sample.ok, JSON.stringify(sample)).toBe(true);
  armAdd(operationContext(), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(operationContext(), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  expect((await runQuote(operationContext(), { draftId })).ok).toBe(true);
  expect(runLock(operationContext(), { draftId }).ok).toBe(true);
}

async function templateLines(format: "jsonl" | "csv"): Promise<string[]> {
  const rendered = await runCli(
    ["run", "import", "--template", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "draft-1", "--format", format],
    cliContext(),
  );
  expect(rendered.exitCode, rendered.stderr).toBe(0);
  return rendered.stdout.trimEnd().split("\n");
}

describe("run import — the slate template", () => {
  test("USAGE exposes run import as a first-class verb", () => {
    expect(USAGE).toContain("run import       --workspace <dir> --principal <id> --draft <draftId>");
  });

  test("the CSV template is the whole sealed slate, one blank row per expected slot", async () => {
    await lockedDraft();
    const lines = await templateLines("csv");
    const header = lines[0]!.split(",");
    expect(header.slice(0, 7)).toEqual([
      "cellKey", "outcome", "reason", "startedAt", "endedAt", "durationMs", "evidence",
    ]);
    // The measurement columns are exactly what the sample's own sealed EvaluationSpec declares —
    // the names its verdict rule can read, and nothing else.
    expect(header.slice(7)).toEqual(SAMPLE_MEASUREMENTS.map((name) => `m.${name}`));

    const rows = lines.slice(1);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      const fields = row.split(",");
      expect(fields).toHaveLength(header.length);
      expect(fields[0]).toMatch(/^[a-f0-9]{64}\//u);
      expect(fields.slice(1).every((field) => field === "")).toBe(true);
    }
    expect(new Set(rows.map((row) => row.split(",")[0]!)).size).toBe(6);
  }, 60_000);

  test("the JSONL template names the same slots and the same measurements", async () => {
    await lockedDraft();
    const rows = (await templateLines("jsonl")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      // `reason` is forbidden on a `graded` row, so the template does not emit a blank one; the
      // operator adds the key on the rows whose outcome requires it.
      expect(row).toMatchObject({ outcome: "" });
      expect(row).not.toHaveProperty("reason");
      expect(Object.keys(row["measurements"] as Record<string, string>)).toEqual([...SAMPLE_MEASUREMENTS]);
    }
    expect(new Set(rows.map((row) => row["cellKey"])).size).toBe(6);
  }, 60_000);

  test("--json carries the template alongside its row and measurement inventory", async () => {
    await lockedDraft();
    const rendered = await runCli(
      ["run", "import", "--template", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "draft-1", "--format", "csv", "--json"],
      cliContext(),
    );
    expect(rendered.exitCode, rendered.stderr).toBe(0);
    expect(JSON.parse(rendered.stdout)).toMatchObject({
      ok: true,
      result: { format: "csv", rows: 6, measurements: [...SAMPLE_MEASUREMENTS] },
    });
  }, 60_000);

  test("--template reads nothing, so it refuses --file and --source", async () => {
    await lockedDraft();
    for (const [flag, value] of [["file", "dump.csv"], ["source", "some-harness"]] as const) {
      const refused = await runCli(
        ["run", "import", "--template", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "draft-1", `--${flag}`, value, "--json"],
        cliContext(),
      );
      expect(refused.exitCode, flag).toBe(2);
      expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: { code: "invalid-invocation" } });
    }
  }, 60_000);
});

describe("run import — importing a dump", () => {
  test("a filled CSV template imports through the verb and closes the slate", async () => {
    await lockedDraft();
    const lines = await templateLines("csv");
    const header = lines[0]!.split(",");
    const cellKeys = lines.slice(1).map((row) => row.split(",")[0]!);
    /** Fills a template row by COLUMN NAME, so the test never encodes the header's own ordering. */
    const row = (values: Readonly<Record<string, string>>): string =>
      header.map((column) => values[column] ?? "").join(",");
    // Every expected slot, exactly once: one graded, the rest honestly unrun. Nothing is dropped.
    const filled = [
      lines[0]!,
      // Only the two measurements the sealed verdict rule reads; the rest stay absent.
      row({
        cellKey: cellKeys[0]!,
        outcome: "graded",
        // Resolved against the dump's own directory, so a dump and its artifacts move as one tree.
        evidence: "prediction=prediction.json",
        "m.integrity": "true",
        "m.resolved": "true",
      }),
      ...cellKeys.slice(1).map((cellKey) =>
        row({ cellKey, outcome: "unrun", reason: "the sweep was cut short" })),
    ].join("\n");
    writeFileSync(join(dumpDir, "prediction.json"), '{"probabilityYes":"0.5"}');
    const file = join(dumpDir, "records.csv");
    writeFileSync(file, `${filled}\n`);

    const imported = await runCli(
      ["run", "import", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "draft-1",
        "--file", file, "--format", "csv", "--source", "some-external-harness", "--json"],
      cliContext(),
    );
    expect(imported.exitCode, imported.stdout + imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({
      ok: true,
      result: { importedCellCount: 6, written: { graded: 1, ungradeable: 0, notDelivered: 5 } },
    });
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("running");
  }, 60_000);

  test("a dump missing a slot is refused with the whole problem list, not the first one", async () => {
    await lockedDraft();
    const lines = await templateLines("jsonl");
    const cellKeys = lines.map((line) => (JSON.parse(line) as { cellKey: string }).cellKey);
    // Two slots dropped and one outcome outside the closed vocabulary.
    const dump = [
      JSON.stringify({ cellKey: cellKeys[0]!, outcome: "skipped" }),
      ...cellKeys.slice(1, 4).map((cellKey) => JSON.stringify({ cellKey, outcome: "unrun", reason: "not scheduled" })),
    ].join("\n");
    const file = join(dumpDir, "records.jsonl");
    writeFileSync(file, `${dump}\n`);

    const refused = await runCli(
      ["run", "import", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "draft-1",
        "--file", file, "--source", "some-external-harness", "--json"],
      cliContext(),
    );
    expect(refused.exitCode).toBe(1);
    const envelope = JSON.parse(refused.stdout) as { ok: boolean; error: { code: string; detail: string; issues: { path: string }[] } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.issues.map((issue) => issue.path).sort())
      .toEqual(["missing-slot", "missing-slot", "unknown-outcome"]);
    // The remedy names the only sanctioned way to not have a result for a slot.
    expect(envelope.error.detail).toContain("There is no exclude flag.");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
  }, 60_000);

  test("a filled JSONL template row imports without the operator deleting a key", async () => {
    await lockedDraft();
    const rows = (await templateLines("jsonl")).map((line) => JSON.parse(line) as Record<string, unknown>);
    // The graded row is filled IN PLACE: every key the template emitted stays, and every
    // measurement placeholder gets a value the sealed declaration accepts. A template that needed
    // a key removed before it would import is not a template.
    const graded = {
      ...rows[0]!,
      outcome: "graded",
      evidence: [{ name: "prediction", path: "prediction.json" }],
      measurements: {
        integrity: "true", resolved: "true", outcomeYes: "true",
        solverBrier: "0.25", consensusBrier: "0.30", brierSpread: "0.05",
      },
    };
    // The remaining slots are honestly unrun; `measurements` is dropped because the outcome
    // forbids it, which is the operator's own choice of outcome, not a template defect.
    const rest = rows.slice(1).map((row) => {
      const { measurements: _dropped, ...kept } = row;
      return { ...kept, outcome: "unrun", reason: "the sweep was cut short" };
    });
    writeFileSync(join(dumpDir, "prediction.json"), '{"probabilityYes":"0.5"}');
    const file = join(dumpDir, "records.jsonl");
    writeFileSync(file, `${[graded, ...rest].map((row) => JSON.stringify(row)).join("\n")}\n`);

    const imported = await runCli(
      ["run", "import", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "draft-1",
        "--file", file, "--source", "some-external-harness", "--json"],
      cliContext(),
    );
    expect(imported.exitCode, imported.stdout + imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({
      ok: true,
      result: { importedCellCount: 6, written: { graded: 1, ungradeable: 0, notDelivered: 5 } },
    });
  }, 60_000);

  test("refuses a --format outside the two dialects", async () => {
    await lockedDraft();
    const refused = await runCli(
      ["run", "import", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", "draft-1",
        "--file", join(dumpDir, "records.tsv"), "--format", "tsv", "--source", "h", "--json"],
      cliContext(),
    );
    expect(refused.exitCode).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: { code: "invalid-invocation" } });
  }, 60_000);
});
