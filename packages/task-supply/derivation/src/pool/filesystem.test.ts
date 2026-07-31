// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DerivationError } from "../errors.js";
import { createFilesystemSupplyPool } from "./filesystem.js";
import { buildFixturePoolEntry } from "../testing-support.js";

async function pool() {
  const dir = await mkdtemp(join(tmpdir(), "jinn-supply-pool-"));
  let counter = 0;
  return { dir, pool: createFilesystemSupplyPool({ dir, uniqueSuffix: () => `${(counter += 1)}` }) };
}

describe("filesystem supply pool", () => {
  it("round-trips an entry byte-for-byte, addressed by task digest", async () => {
    const { pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    const summary = await store.put(entry);
    expect(summary.taskDigest).toBe(entry.taskDigest);

    const read = await store.get(entry.taskDigest);
    expect(read!.taskBytes).toEqual(entry.taskBytes);
    expect(read!.evaluationSpecBytes).toEqual(entry.evaluationSpecBytes);
    expect(read!.provenance).toEqual(entry.provenance);
  });

  it("accepts the digest in bare-hex form too", async () => {
    const { pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await store.put(entry);
    expect(await store.get(entry.taskDigest.slice("sha256:".length))).toBeDefined();
  });

  it("is idempotent: re-putting identical content leaves one entry", async () => {
    const { dir, pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await store.put(entry);
    await store.put(entry);
    expect(await readdir(join(dir, "entries"))).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("refuses to overwrite a different body at the same address", async () => {
    const { dir, pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await store.put(entry);
    const hex = entry.taskDigest.slice("sha256:".length);
    await writeFile(join(dir, "entries", hex, "task.sealed.json"), "{}");
    await expect(store.put(entry)).rejects.toThrow(DerivationError);
  });

  it("leaves nothing behind when a put is rejected before writing", async () => {
    const { dir, pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await expect(store.put({ ...entry, taskDigest: `sha256:${"0".repeat(64)}` }))
      .rejects.toThrow(DerivationError);
    expect(await readdir(join(dir, "entries")).catch(() => [])).toHaveLength(0);
  });

  it("stages under a scratch directory and cleans it up", async () => {
    const { dir, pool: store } = await pool();
    await store.put(buildFixturePoolEntry());
    expect(await readdir(join(dir, ".staging"))).toHaveLength(0);
  });

  it("lists deterministically, ordered by task digest", async () => {
    const { pool: store } = await pool();
    const a = buildFixturePoolEntry({ statement: "alpha" });
    const b = buildFixturePoolEntry({ statement: "beta" });
    await store.put(b);
    await store.put(a);
    const digests = (await store.list()).map((summary) => summary.taskDigest);
    expect(digests).toEqual([...digests].sort());
  });

  it("returns undefined for an unknown digest rather than throwing", async () => {
    const { pool: store } = await pool();
    expect(await store.get(`sha256:${"f".repeat(64)}`)).toBeUndefined();
  });

  it("writes exactly three files per entry — nowhere for gold to live", async () => {
    const { dir, pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await store.put(entry);
    const hex = entry.taskDigest.slice("sha256:".length);
    expect((await readdir(join(dir, "entries", hex))).sort())
      .toEqual(["entry.json", "evaluation-spec.sealed.json", "task.sealed.json"]);
    const manifest = await readFile(join(dir, "entries", hex, "entry.json"), "utf8");
    expect(manifest).not.toContain("gold");
  });
});
