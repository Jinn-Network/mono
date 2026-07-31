// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(root)) {
    const path = join(root, name);
    if ((await stat(path)).isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

describe("gold never enters the pool", () => {
  it("leaves no gold byte sequence anywhere under the pool directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-gold-scan-"));
    let counter = 0;
    const uniqueSuffix = () => `${(counter += 1)}`;
    const rows = await loadFixtureRows();

    const summary = await runDerivation(
      {
        admission: createStubAdmissionPort(),
        pool: createFilesystemSupplyPool({ dir: join(root, "pool"), uniqueSuffix }),
        goldStore: createFilesystemGoldStore({ dir: join(root, "gold"), uniqueSuffix }),
      },
      importStrategy,
      buildFixtureEnvironment(),
      fixtureImportInputs(rows),
    );
    expect(summary.written.length).toBeGreaterThan(0);

    const poolFiles = await walk(join(root, "pool"));
    expect(poolFiles.length).toBeGreaterThan(0);
    for (const path of poolFiles) {
      const text = await readFile(path, "utf8");
      for (const row of rows) {
        expect(text, `gold leaked into ${relative(root, path)}`).not.toContain(row.patch);
        // The one channel by which patch material actually rides into a sealed spec is
        // `testMaterial[].content`, which is base64 — a plaintext-only scan would miss a leak
        // through exactly the encoding that carries patches today.
        expect(text, `base64 gold leaked into ${relative(root, path)}`)
          .not.toContain(Buffer.from(row.patch, "utf8").toString("base64"));
        for (const line of row.patch.split("\n").filter((l) => l.startsWith("+") && l.length > 3)) {
          expect(text, `gold line leaked into ${relative(root, path)}`).not.toContain(line);
        }
      }
    }

    // …and the bytes really are retrievable from the store that is supposed to hold them.
    const goldFiles = await walk(join(root, "gold"));
    expect(goldFiles.filter((path) => path.endsWith(".patch"))).toHaveLength(
      summary.written.length,
    );
  });
});
