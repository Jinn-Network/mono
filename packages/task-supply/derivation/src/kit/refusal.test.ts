// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFilesystemGoldStore } from "../gold/filesystem.js";
import { createFilesystemSupplyPool } from "../pool/filesystem.js";
import { runDerivation } from "../run.js";
import { importStrategy } from "../strategies/import.js";
import {
  buildFixtureEnvironment,
  createStubAdmissionPort,
  fixtureImportInputs,
} from "../testing-support.js";
import { loadFixtureRows } from "../testing.js";

describe("refusal path", () => {
  it("keeps a refused candidate out of the pool entirely", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-refusal-"));
    let counter = 0;
    const uniqueSuffix = () => `${(counter += 1)}`;
    const pool = createFilesystemSupplyPool({ dir: join(root, "pool"), uniqueSuffix });

    const summary = await runDerivation(
      {
        admission: createStubAdmissionPort({
          refuse: { "acme__widget-1235": "env-record-mismatch" },
        }),
        pool,
        goldStore: createFilesystemGoldStore({ dir: join(root, "gold"), uniqueSuffix }),
      },
      importStrategy,
      buildFixtureEnvironment(),
      fixtureImportInputs(await loadFixtureRows()),
    );

    expect(summary.refused).toEqual([
      { candidateId: "acme__widget-1235", code: "env-record-mismatch" },
    ]);
    expect(summary.written.map((pair) => pair.candidateId)).toEqual(["acme__widget-1234"]);
    expect(await readdir(join(root, "pool", "entries"))).toHaveLength(1);
    // A refusal is an outcome, not an error: the run reports it and moves on.
    expect(summary.failed).toHaveLength(0);
  });
});
