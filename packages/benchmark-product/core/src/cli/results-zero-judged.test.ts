// SPDX-License-Identifier: Apache-2.0

/**
 * What `results` prints for an arm with no judged cell (operator rulings of 2026-10-06, decision
 * 6; issue #4975).
 *
 * `wilson@1` seals `0.0000` for the rate and both interval bounds of an arm with `n` 0. Printed as
 * sealed, that reads as an arm that failed every task, when it was never scored. The human
 * rendering states no rate for such an arm. The stored records and the `--json` envelope keep the
 * sealed strings.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderResultsDocument, runCli } from "./main.js";
import type { CliContext, CliResult } from "./result.js";

const UNSCORED = { n: 0, passRate: "0.0000", wilsonInterval: { low: "0.0000", high: "0.0000" } };
const UNSTATED = { n: 0, passRate: "No rate is stated", wilsonInterval: { low: "Not stated", high: "Not stated" } };

describe("renderResultsDocument", () => {
  test("an arm with n 0 states no rate and no interval, in the Claim headline and in the Report", () => {
    const scored = { n: 3, passRate: "0.0000", wilsonInterval: { low: "0.0000", high: "0.5615" } };
    const document = {
      draftId: "draft-1",
      attrition: { perArm: { ghost: { expected: 3, judged: 0 } }, asymmetryFlags: [] },
      report: {
        record: { results: { perSubject: [{ subjectSha256: "a".repeat(64), results: { arms: { ghost: UNSCORED, oracle: scored } } }] } },
        claimPackage: { headline: { ghost: UNSCORED, oracle: scored } },
      },
    };
    const rendered = JSON.parse(renderResultsDocument(document)) as typeof document;
    expect(rendered.report.claimPackage.headline).toEqual({ ghost: UNSTATED, oracle: scored });
    expect(rendered.report.record.results.perSubject[0]!.results.arms).toEqual({ ghost: UNSTATED, oracle: scored });
    // An arm that was scored and failed every task keeps its sealed rate: that zero is a result.
    expect(rendered.report.claimPackage.headline.oracle.passRate).toBe("0.0000");
    // Nothing else moves, and the document it was given is not edited in place.
    expect({ ...rendered, report: undefined }).toEqual({ ...document, report: undefined });
    expect(document.report.claimPackage.headline.ghost).toEqual(UNSCORED);
  });

  test("a document with no unscored arm prints exactly as JSON.stringify would", () => {
    const document = {
      draftId: "draft-1",
      cells: [{ cellKey: "k", verdicts: [{ measurements: { reward: 0 } }], n: 0 }],
      report: { claimPackage: { headline: { oracle: { n: 3, passRate: "1.0000", wilsonInterval: { low: "0.4385", high: "1.0000" } } } } },
    };
    expect(renderResultsDocument(document)).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });
});

describe("results, on a run with an arm that has no judged cell", () => {
  const HARBOR_JOBS = fileURLToPath(
    new URL("../../test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/jobs", import.meta.url),
  );
  const TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks", "chess-best-move"] as const;

  let root: string;
  let workspaceDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "results-zero-judged-"));
    workspaceDir = join(root, "ws");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function contextAt(at: string): CliContext {
    let ms = Date.parse(at);
    return {
      cwd: root,
      clock: () => {
        const value = new Date(ms).toISOString();
        ms += 10;
        return value;
      },
    };
  }

  const onDraft = (): readonly string[] => ["--workspace", workspaceDir, "--principal", "me", "--draft", "draft-1"];

  async function ok(argv: readonly string[], ctx: CliContext): Promise<CliResult> {
    const result = await runCli(argv, ctx);
    if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.stdout}${result.stderr}`);
    return result;
  }

  test("the human rendering states no rate for it, and --json keeps the sealed strings", async () => {
    // The fixture's lock must precede its earliest trial start (12:58:28Z), and the import must
    // follow its latest trial finish (13:39:36Z).
    const before = contextAt("2026-10-01T12:00:00.000Z");
    const after = contextAt("2026-10-01T14:00:00.000Z");
    await ok(["init", "--workspace", workspaceDir, "--principal", "me"], before);
    await ok(["draft", "create", "--workspace", workspaceDir, "--principal", "me", "--name", "one arm never ran", "--id", "draft-1"], before);
    await ok(["method", "terminal-bench-2.1", ...onDraft(), "--ids", TASKS.join(",")], before);
    await ok(["arm", "add", ...onDraft(), "--arm", "oracle", "--pinning", JSON.stringify({ agent: { id: "oracle" } })], before);
    // No Harbor job in the directory below belongs to this arm, so all three of its cells are
    // imported as unrun and none reaches a verdict.
    await ok(["arm", "add", ...onDraft(), "--arm", "never-ran", "--pinning", JSON.stringify({ agent: { id: "never-ran" } })], before);
    await ok(["quote", ...onDraft()], before);
    await ok(["lock", ...onDraft(), "--ack-sample-size", "--no-anchor"], before);

    const jobsDir = join(root, "jobs");
    mkdirSync(jobsDir);
    cpSync(join(HARBOR_JOBS, "oracle"), join(jobsDir, "oracle"), { recursive: true });
    await ok(["run", "import", "--from", "harbor", jobsDir, ...onDraft()], after);
    await ok(["collect", ...onDraft()], after);
    await ok(["report", ...onDraft()], after);

    type PerSubjectArms = { perSubject: { results: { arms: Record<string, unknown> } }[] };
    const stored = JSON.parse((await ok(["results", ...onDraft(), "--json"], after)).stdout) as {
      result: {
        report: {
          claimPackage: { headline: Record<string, unknown>; results: PerSubjectArms };
          record: { results: PerSubjectArms };
        };
      };
    };
    /** The three places the document carries an arm's sealed rate. */
    const armTables = (document: typeof stored.result): Record<string, unknown>[] => [
      document.report.claimPackage.headline,
      document.report.claimPackage.results.perSubject[0]!.results.arms,
      document.report.record.results.perSubject[0]!.results.arms,
    ];
    for (const arms of armTables(stored.result)) {
      expect(arms["never-ran"]).toEqual(UNSCORED);
      expect(arms["oracle"]).toEqual({ n: 3, passRate: "1.0000", wilsonInterval: { low: "0.4385", high: "1.0000" } });
    }

    const human = JSON.parse((await ok(["results", ...onDraft()], after)).stdout) as typeof stored.result;
    for (const arms of armTables(human)) expect(arms["never-ran"]).toEqual(UNSTATED);
    // Only that arm's three entries differ between the two renderings.
    const restated = structuredClone(stored.result);
    for (const arms of armTables(restated)) arms["never-ran"] = UNSTATED;
    expect(human).toEqual(restated);
  }, 120_000);
});
