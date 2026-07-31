// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDerivation } from "./run.js";
import { createFilesystemSupplyPool } from "./pool/filesystem.js";
import { createFilesystemGoldStore } from "./gold/filesystem.js";
import { computeSourceCommitment } from "./source-commitment.js";
import {
  buildFixtureEnvironment,
  buildFixtureRow,
  createStubAdmissionPort,
  fixtureImportInputs,
} from "./testing-support.js";
import { importStrategy } from "./strategies/import.js";

async function harness(admission = createStubAdmissionPort()) {
  const root = await mkdtemp(join(tmpdir(), "jinn-run-"));
  let counter = 0;
  const uniqueSuffix = () => `${(counter += 1)}`;
  return {
    root,
    admission,
    deps: {
      admission,
      pool: createFilesystemSupplyPool({ dir: join(root, "pool"), uniqueSuffix }),
      goldStore: createFilesystemGoldStore({ dir: join(root, "gold"), uniqueSuffix }),
    },
  };
}

const env = buildFixtureEnvironment();

describe("runDerivation", () => {
  it("writes admitted pairs and reports them in the summary", async () => {
    const { deps } = await harness();
    const rows = [buildFixtureRow(), buildFixtureRow({ instance_id: "acme__widget-2", problem_statement: "Second issue.\n" })];
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs(rows));

    expect(summary.strategyId).toBe(importStrategy.id);
    expect(summary.environmentRecordDigest).toBe(env.recordDigest);
    expect(summary.written).toHaveLength(2);
    expect(summary.refused).toHaveLength(0);
    expect(summary.failed).toHaveLength(0);
    expect(await deps.pool.list()).toHaveLength(2);
  });

  it("discards refusals with a typed summary and writes nothing for them", async () => {
    const admission = createStubAdmissionPort({
      refuse: { "acme__widget-2": "env-record-mismatch" },
    });
    const { deps } = await harness(admission);
    const rows = [buildFixtureRow(), buildFixtureRow({ instance_id: "acme__widget-2", problem_statement: "Second issue.\n" })];
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs(rows));

    expect(summary.written).toHaveLength(1);
    expect(summary.refused).toEqual([
      { candidateId: "acme__widget-2", code: "env-record-mismatch" },
    ]);
    expect(await deps.pool.list()).toHaveLength(1);
  });

  it("hands admission a candidate whose spec cites this environment record", async () => {
    const admission = createStubAdmissionPort();
    const { deps } = await harness(admission);
    await runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()]));
    expect(admission.seen).toHaveLength(1);
    expect(admission.seen[0]!.environmentRecordBytes).toEqual(env.recordBytes);
  });

  it("records the receipt digest the admission port published", async () => {
    const { deps, admission } = await harness();
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()]));
    expect(summary.written[0]!.receiptDigest).toBe(admission.published[0]);
    const entry = await deps.pool.get(summary.written[0]!.taskDigest);
    expect(entry!.receiptDigest).toBe(admission.published[0]);
  });

  it("carries the provenance summary into the entry", async () => {
    const { deps } = await harness();
    const row = buildFixtureRow();
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs([row]));
    const entry = await deps.pool.get(summary.written[0]!.taskDigest);
    expect(entry!.provenance).toEqual({
      kind: "mined",
      sourceCommitment: computeSourceCommitment(
        {
          dataset: "nebius/SWE-rebench",
          revision: "refs/convert/parquet-2026-05-01",
          instanceId: row.instance_id,
        },
        row.problem_statement,
      ),
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        instanceId: row.instance_id,
      },
    });
    expect(entry!.rights.sourceLicense).toBe("Apache-2.0");
  });

  it("stores gold in the gold store and nowhere in the pool", async () => {
    const { root, deps } = await harness();
    const row = buildFixtureRow();
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs([row]));
    expect(summary.written).toHaveLength(1);

    const goldFiles = (await readdir(join(root, "gold"))).filter((name) => name.endsWith(".patch"));
    expect(goldFiles).toHaveLength(1);

    const poolRoot = join(root, "pool", "entries");
    for (const address of await readdir(poolRoot)) {
      for (const file of await readdir(join(poolRoot, address))) {
        const text = await readFile(join(poolRoot, address, file), "utf8");
        expect(text).not.toContain(row.patch);
        expect(text).not.toContain("+return 0");
      }
    }
  });

  it("fails the pair, loudly and locally, when the receipt's gold hash disagrees", async () => {
    const admission = createStubAdmissionPort({ goldHashOverride: `sha256:${"0".repeat(64)}` });
    const { deps } = await harness(admission);
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()]));
    expect(summary.written).toHaveLength(0);
    expect(summary.failed[0]!.reason).toBe("gold-mismatch");
    expect(await deps.pool.list()).toHaveLength(0);
  });

  it("propagates a port failure instead of marking every candidate failed", async () => {
    const admission = createStubAdmissionPort({ throwOn: "acme__widget-1234" });
    const { deps } = await harness(admission);
    await expect(runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()])))
      .rejects.toThrow(/admission port unavailable/);
  });

  it("is idempotent across reruns", async () => {
    const { deps } = await harness();
    const inputs = fixtureImportInputs([buildFixtureRow()]);
    await runDerivation(deps, importStrategy, env, inputs);
    const second = await runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()]));
    expect(second.failed).toHaveLength(0);
    expect(await deps.pool.list()).toHaveLength(1);
  });
});
