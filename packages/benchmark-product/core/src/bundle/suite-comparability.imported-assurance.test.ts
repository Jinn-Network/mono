// SPDX-License-Identifier: Apache-2.0

/**
 * The checker refuses an imported Inspect eval run whose assurance derives separate log
 * verification (issue #5244). No process re-reads an imported cell's native log, so such a bundle
 * would rebuild a Report saying its official verdicts were separately verified from the log.
 *
 * `run import` refuses that run before it writes anything, so core cannot make the bundle. Here the
 * import guard is turned off, which makes the bundle a producer without it would publish, and
 * `publish`, which runs the checker on its own output, must refuse it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runPublish } from "../operations/publish.js";
import { runReport } from "../operations/report.js";
import { importedInspectEvalRun, inspectReaderImportedInspectEvalRun, type SuiteRun } from "./testing/suite-runs.js";

vi.mock("../runtime/inspect/assurance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/inspect/assurance.js")>()),
  inspectImportMeetsAssurance: () => true,
}));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bp-suite-imported-assurance-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function publishRefusal(run: SuiteRun): Promise<string> {
  const reported = await runReport(run.context, { draftId: run.draftId });
  expect(reported.ok, JSON.stringify(reported)).toBe(true);
  const published = await runPublish(run.context, { draftId: run.draftId, includeNativeArtifacts: true });
  expect(published.ok, JSON.stringify(published)).toBe(false);
  if (published.ok) throw new Error("unreachable");
  return published.error.detail;
}

describe("an imported Inspect eval run under a separate log-verification assurance is refused by the checker (#5244)", () => {
  test("every cell brought with run import --from inspect and graded", async () => {
    const run = await inspectReaderImportedInspectEvalRun(root, { assurance: { preset: "separate-evaluator" } });
    expect(await publishRefusal(run)).toMatch(/an imported Inspect eval run cannot satisfy separate Inspect log verification/u);
  }, 240_000);

  test("no cell delivered, so no evaluation names a log verifier", async () => {
    const run = await importedInspectEvalRun(root, { coverage: "full", assurance: { preset: "separate-evaluator" } });
    expect(await publishRefusal(run)).toMatch(/an imported Inspect eval run cannot satisfy separate Inspect log verification/u);
  }, 240_000);
});
