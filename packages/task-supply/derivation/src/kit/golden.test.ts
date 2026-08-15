// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { createFilesystemGoldStore } from "../gold/filesystem.js";
import { createFilesystemSupplyPool } from "../pool/filesystem.js";
import { runDerivation } from "../run.js";
import { importStrategy, PERMISSIVE_LICENSE_ALLOWLIST } from "../strategies/import.js";
import { loadDerivationEnvironment } from "../strategy.js";
import {
  buildFixtureEnvironmentRecordBody,
  createStubAdmissionPort,
} from "../testing-support.js";
import { loadFixtureRows } from "../testing.js";

const UPDATE = process.env["JINN_UPDATE_FIXTURES"] === "1";
const fixtures = (path: string) => new URL(`../../fixtures/${path}`, import.meta.url);

async function expectBytes(path: string, actual: Uint8Array): Promise<void> {
  const url = fixtures(path);
  if (UPDATE) {
    await mkdir(new URL(".", url), { recursive: true });
    await writeFile(url, actual);
    return;
  }
  expect(new Uint8Array(await readFile(url))).toEqual(actual);
}

describe("golden derivation run", () => {
  it("produces byte-exact sealed pairs, entry manifests, and summary", async () => {
    const recordBytes = sealEnvironmentRecord(buildFixtureEnvironmentRecordBody());
    await expectBytes("environment/record.sealed.json", recordBytes);

    const env = loadDerivationEnvironment(recordBytes);
    const root = await mkdtemp(join(tmpdir(), "jinn-golden-"));
    let counter = 0;
    const uniqueSuffix = () => `${(counter += 1)}`;
    const pool = createFilesystemSupplyPool({ dir: join(root, "pool"), uniqueSuffix });

    const skipped: string[] = [];
    const summary = await runDerivation(
      {
        admission: createStubAdmissionPort(),
        pool,
        goldStore: createFilesystemGoldStore({ dir: join(root, "gold"), uniqueSuffix }),
        logger: {
          candidateSkipped: (event) => skipped.push(`${event.candidateId}:${event.reason}`),
          candidateRefused: () => {},
          pairWritten: () => {},
        },
      },
      importStrategy,
      env,
      {
        rows: await loadFixtureRows(),
        upstream: { dataset: "nebius/SWE-rebench", revision: "refs/convert/parquet-2026-05-01" },
        defaultTimeoutSeconds: 900,
        licensePolicy: { allow: PERMISSIVE_LICENSE_ALLOWLIST },
      },
    );

    // The GPL row never becomes a candidate (D12's permissive filter).
    expect(skipped).toEqual(["acme__widget-1236:license-not-permitted"]);
    expect(summary.written).toHaveLength(2);
    expect(summary.refused).toHaveLength(0);
    expect(summary.failed).toHaveLength(0);

    for (const pair of summary.written) {
      const address = pair.taskDigest.slice("sha256:".length);
      const entryDir = join(root, "pool", "entries", address);
      for (const file of (await readdir(entryDir)).sort()) {
        await expectBytes(
          `golden/entries/${address}/${file}`,
          new Uint8Array(await readFile(join(entryDir, file))),
        );
      }
    }

    await expectBytes(
      "golden/summary.json",
      new TextEncoder().encode(`${JSON.stringify(summary, null, 2)}\n`),
    );
  });
});
