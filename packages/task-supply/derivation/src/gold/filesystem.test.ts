// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { documentDigest } from "../digest.js";
import { DerivationError } from "../errors.js";
import { GOLD_STORE_MARKER_FILE, createFilesystemGoldStore } from "./filesystem.js";

const GOLD = new TextEncoder().encode("--- a/widget.py\n+++ b/widget.py\n@@\n-raise\n+return 0\n");

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "jinn-gold-"));
  let counter = 0;
  return { dir, store: createFilesystemGoldStore({ dir, uniqueSuffix: () => `${(counter += 1)}` }) };
}

describe("filesystem gold store", () => {
  it("keys by the content digest and round-trips the bytes", async () => {
    const { store: gold } = await store();
    const ref = await gold.put(GOLD);
    expect(ref.goldPatchHash).toBe(documentDigest(GOLD));
    expect(await gold.get(ref.goldPatchHash)).toEqual(GOLD);
  });

  it("accepts a bare-hex key, so a receipt using either encoding resolves", async () => {
    const { store: gold } = await store();
    const ref = await gold.put(GOLD);
    expect(await gold.get(ref.goldPatchHash.slice("sha256:".length))).toEqual(GOLD);
  });

  it("returns undefined for an unknown hash and rejects a malformed one", async () => {
    const { store: gold } = await store();
    expect(await gold.get(`sha256:${"0".repeat(64)}`)).toBeUndefined();
    await expect(gold.get("not-a-digest")).rejects.toThrow(DerivationError);
  });

  it("is idempotent", async () => {
    const { dir, store: gold } = await store();
    await gold.put(GOLD);
    await gold.put(GOLD);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".patch"));
    expect(files).toHaveLength(1);
  });

  it("writes owner-only files and a do-not-publish marker", async () => {
    const { dir, store: gold } = await store();
    const ref = await gold.put(GOLD);
    const mode = (await stat(join(dir, `${ref.goldPatchHash.slice("sha256:".length)}.patch`))).mode;
    expect(mode & 0o077).toBe(0);
    expect(await readdir(dir)).toContain(GOLD_STORE_MARKER_FILE);
  });

  it("refuses empty bytes", async () => {
    const { store: gold } = await store();
    await expect(gold.put(new Uint8Array())).rejects.toThrow(DerivationError);
  });
});
