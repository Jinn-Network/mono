// SPDX-License-Identifier: Apache-2.0

/**
 * A run with an arm that has no judged cell still publishes, and a reader's checker accepts the
 * bundle (#4939; operator rulings of 2026-10-06, decision 6, option c).
 *
 * `wilson@1` seals a rate of `0.0000` and an interval of `0.0000` to `0.0000` for an arm with `n`
 * 0. The ruling keeps those sealed strings, because the claim package schema requires them, and
 * changes only what is shown: the page and the claim text say that no rate is stated for that arm.
 * The checker rebuilds the page byte for byte, so the wording a claimant's `publish` writes and the
 * wording a reader's checker accepts have to be the same wording. Each half is unit-tested where it
 * lives. This test is the two meeting on one real bundle.
 *
 * The run is the claimant path on the official Terminal-Bench 2.1 slate with one change: the
 * claimant declared an arm and then never ran it. The jobs directory holds the `oracle` job of the
 * real Harbor 0.21.0 record under `test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/` and no job
 * for the other arm, so that arm's three slots are imported as `unrun`.
 *
 * It is hermetic: no network, no Docker, no model, and no venue beyond what `quote` reads from the
 * local machine.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BUNDLE_V10_FORMAT, runVerifierCli, verifyPublicBundle, type VerifierCliResult } from "@colophon-claims/check";
import { runCli } from "../cli/main.js";
import type { CliContext } from "../cli/result.js";

const HARBOR_JOBS = fileURLToPath(
  new URL("../../test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/jobs", import.meta.url),
);

const DRAFT = "draft-1";
const TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks", "chess-best-move"] as const;
/** The arm the claimant declared and never ran. No Harbor job in the jobs directory is its. */
const UNSCORED_ARM = "never-ran";
const UNSTATED = `No rate is stated for arm ${UNSCORED_ARM}: none of its cells reached a pass or fail verdict.`;

/** The lock must precede the fixture's earliest `oracle` trial start (13:34:25Z) ... */
const BEFORE_THE_RUN = "2026-10-01T12:00:00.000Z";
/** ... and the import must follow its latest trial finish (13:39:36Z). */
const AFTER_THE_RUN = "2026-10-01T14:00:00.000Z";

let root: string;
let bundleDir: string;
let imported: Record<string, any>;
let verified: Awaited<ReturnType<typeof verifyPublicBundle>>;
let checked: VerifierCliResult;

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

/** Runs one command the claimant types and returns its `--json` result. */
async function typed(argv: readonly string[], context: CliContext): Promise<Record<string, any>> {
  const result = await runCli([...argv, "--json"], context);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.stdout}${result.stderr}`);
  return (JSON.parse(result.stdout) as { readonly result: Record<string, any> }).result;
}

function bundleText(path: string): string {
  return readFileSync(join(bundleDir, path), "utf8");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bp-zero-judged-arm-"));
  const workspaceDir = join(root, "ws");
  const onWorkspace = ["--workspace", workspaceDir, "--principal", "claimant"];
  const onDraft = [...onWorkspace, "--draft", DRAFT];
  const before = contextAt(BEFORE_THE_RUN);
  const after = contextAt(AFTER_THE_RUN);

  await typed(["init", ...onWorkspace], before);
  await typed(["draft", "create", ...onWorkspace, "--name", "One arm never ran", "--id", DRAFT], before);
  await typed(["method", "terminal-bench-2.1", ...onDraft, "--ids", TASKS.join(",")], before);
  await typed(["arm", "add", ...onDraft, "--arm", "oracle", "--pinning", JSON.stringify({ agent: { id: "oracle" } })], before);
  await typed(["arm", "add", ...onDraft, "--arm", UNSCORED_ARM, "--pinning", JSON.stringify({ agent: { id: UNSCORED_ARM } })], before);
  await typed(["quote", ...onDraft], before);
  await typed(["lock", ...onDraft, "--ack-sample-size"], before);

  const jobsDir = join(root, "jobs");
  mkdirSync(jobsDir);
  cpSync(join(HARBOR_JOBS, "oracle"), join(jobsDir, "oracle"), { recursive: true });
  imported = await typed(["run", "import", "--from", "harbor", jobsDir, ...onDraft], after);
  await typed(["collect", ...onDraft], after);
  await typed(["report", ...onDraft], after);
  const published = await typed(["publish", ...onDraft], after);

  // A reader has the bundle directory and nothing else.
  bundleDir = join(root, "bundle");
  cpSync(join(workspaceDir, published["bundleRelativePath"] as string), bundleDir, { recursive: true });
  rmSync(workspaceDir, { recursive: true, force: true });
  verified = await verifyPublicBundle(bundleDir);
  checked = await runVerifierCli([bundleDir]);
}, 300_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a run with an arm that has no judged cell", () => {
  test("imports with that arm's slots accounted for as not delivered", () => {
    expect(imported).toMatchObject({
      importedCellCount: 6,
      written: { graded: 3, ungradeable: 0, notDelivered: 3 },
    });
  });

  test("publishes, and the checker passes the copied bundle with the workspace gone", () => {
    if (verified.format !== BUNDLE_V10_FORMAT) throw new Error(`expected ${BUNDLE_V10_FORMAT}, got ${verified.format}`);
    expect(verified.capabilities).toEqual([
      "external-import",
      "owner-controlled-publication",
      "terminal-bench-2-1-comparability",
    ]);
    expect(verified.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "external-import",
    ]);
    expect(checked.exitCode, checked.stdout + checked.stderr).toBe(0);
    expect(checked.stdout).toContain("Recomputed: 7 of 7 checks passed\n");
  });

  test("keeps the full accounting, and the sealed rate strings the claim schema requires", () => {
    const claim = JSON.parse(bundleText("claim-package.json")) as Record<string, any>;
    expect(claim["completeness"]).toMatchObject({ expected: 6, judged: 3, runOutcome: "partial" });
    expect(claim["attrition"]["perArm"][UNSCORED_ARM]).toMatchObject({ expected: 3, judged: 0, expired: 3 });
    expect(claim["attrition"]["perArm"]["oracle"]).toMatchObject({ expected: 3, judged: 3, expired: 0 });
    expect(claim["headline"]).toEqual({
      [UNSCORED_ARM]: { n: 0, passRate: "0.0000", wilsonInterval: { low: "0.0000", high: "0.0000" } },
      oracle: { n: 3, passRate: "1.0000", wilsonInterval: { low: "0.4385", high: "1.0000" } },
    });
  });

  test("states no rate for that arm on the page, in the README and in the share text", () => {
    const html = bundleText("index.html");
    // One row in the sealed Report's table and one in the stored Claim's.
    const unscoredRow = `<th scope="row">${UNSCORED_ARM}</th><td>0</td><td>3</td><td>3</td>`
      + "<td>No rate is stated</td><td>Not stated</td><td>Not stated</td></tr>";
    const scoredRow = '<th scope="row">oracle</th><td>3</td><td>3</td><td>0</td>'
      + "<td>1.0000</td><td>0.4385</td><td>1.0000</td></tr>";
    expect(html.split(unscoredRow)).toHaveLength(3);
    expect(html.split(scoredRow)).toHaveLength(3);
    // The rate is named for what was judged, and the unscored arm is an adverse fact.
    expect(html).toContain('<th scope="col">Pass rate over judged cells</th>');
    expect(html).toContain(`<li>${UNSTATED}</li>`);

    const readme = bundleText("README.md");
    expect(readme).toContain(`- ${UNSTATED}\n`);
    expect(readme).toContain(`| ${UNSCORED_ARM} | 0 | 3 | 3 | No rate is stated | Not stated | Not stated |\n`);
    expect(bundleText("share.txt")).toContain(` ${UNSTATED} `);
  });
});
