// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { exportDemo1PublicBundle } from "./demo1-export-public-bundle.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "colophon-demo1-public-bundle-"));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

test("exports the sealed comparison as a deterministic evidence-native public bundle", async () => {
  const firstDir = join(tempRoot, "first");
  const secondDir = join(tempRoot, "second");
  const first = await exportDemo1PublicBundle(firstDir);
  const second = await exportDemo1PublicBundle(secondDir);

  assert.equal(first.verification.format, "benchmark-product-public-bundle/5");
  assert.equal(first.verification.identity, second.verification.identity);
  assert.equal(first.verification.evidenceRecords, 984);
  assert.equal(first.verification.artifacts, 1003);
  assert.equal(first.presentation.title, "Do you need a Skill, or is CLAUDE.md enough?");
  assert.equal(first.presentation.result.estimatePpm, -47143);
  assert.deepEqual(first.presentation.execution.source.upstreamRuntime, {
    name: "BenchFlow",
    version: "0.6.3",
    usedForOfficialCells: false,
  });
  assert.equal(first.presentation.execution.armConstruction.owner, "Colophon");
  assert.equal(first.presentation.execution.agentHarness.heldConstantAcrossArms, true);
  assert.equal(first.presentation.execution.grading.location, "pinned task container");
  assert.deepEqual(first.presentation.result.confidenceInterval95Ppm, { lower: -223444, upper: 129159 });
  assert.equal(first.presentation.population.flatTasks, 41);
  assert.equal(first.presentation.population.funnel.at(-1).tasks, 14);
  assert.equal(first.presentation.accounting.expectedCells, 492);
  assert.equal(first.presentation.accounting.failedHostOracles.length, 2);
  assert.equal(first.presentation.verification.readerAvailability, "available");
  assert.match(first.presentation.provenance.internalRunId, /demo1/u);

  assert.deepEqual(readFileSync(join(firstDir, "bundle.json")), readFileSync(join(secondDir, "bundle.json")));
  assert.deepEqual(
    readFileSync(join(firstDir, "source", "demo1-report.v1.json")),
    readFileSync(join(process.cwd(), "../../../docs/superpowers/plans/demo-report-1/demo1-report.v1.json")),
  );
  const readme = readFileSync(join(firstDir, "README.md"), "utf8");
  assert.doesNotMatch(readme.split("\n", 1)[0], /Demo-1/u);
  assert.match(readme, /public npm reader/u);
  assert.doesNotMatch(readme, /not been released/u);
});
