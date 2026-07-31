// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CorpusMirrorError } from "./errors.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import { createNodeCorpusFilesystem } from "./node-fs.test.js";

const fs = createNodeCorpusFilesystem();

const alice = { agent: "https://agents.test/alice", name: "attempts" };
const bob = { agent: "https://agents.test/bob", name: "attempts" };

const mark = (sequence: string) => ({
  sequence,
  entry: `sha256:${"a".repeat(64)}` as const,
  issuedAt: "2026-07-30T00:00:00Z",
});

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-hwm-"));
  filePath = join(directory, "state", "mirror-state.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file-backed high-water-mark store", () => {
  test("returns undefined for a source it has never seen", async () => {
    const store = createFileHighWaterMarkStore({ filePath, fs });
    expect(await store.get(alice)).toBeUndefined();
  });

  test("survives process restart — a second store instance reads the mark", async () => {
    const first = createFileHighWaterMarkStore({ filePath, fs });
    await first.put(alice, mark("0000000000000007"));

    const second = createFileHighWaterMarkStore({ filePath, fs });
    expect(await second.get(alice)).toEqual(mark("0000000000000007"));
  });

  test("keys by (agent, name) so two agents' sources do not collide", async () => {
    const store = createFileHighWaterMarkStore({ filePath, fs });
    await store.put(alice, mark("0000000000000001"));
    await store.put(bob, mark("0000000000000009"));

    const reopened = createFileHighWaterMarkStore({ filePath, fs });
    expect((await reopened.get(alice))?.sequence).toBe("0000000000000001");
    expect((await reopened.get(bob))?.sequence).toBe("0000000000000009");
  });

  test("overwrites an existing mark in place", async () => {
    const store = createFileHighWaterMarkStore({ filePath, fs });
    await store.put(alice, mark("0000000000000001"));
    await store.put(alice, mark("0000000000000002"));
    expect((await createFileHighWaterMarkStore({ filePath, fs }).get(alice))?.sequence).toBe(
      "0000000000000002",
    );
  });

  test("writes the state file owner-only", async () => {
    const store = createFileHighWaterMarkStore({ filePath, fs });
    await store.put(alice, mark("0000000000000001"));
    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("writes keys in code-unit order so the file diffs cleanly", async () => {
    const store = createFileHighWaterMarkStore({ filePath, fs });
    await store.put(bob, mark("0000000000000001"));
    await store.put(alice, mark("0000000000000001"));
    const body = await readFile(filePath, "utf8");
    expect(body.indexOf("alice")).toBeLessThan(body.indexOf("bob"));
  });

  test("refuses a corrupt state file rather than silently cold-syncing from genesis", async () => {
    const store = createFileHighWaterMarkStore({ filePath, fs });
    await store.put(alice, mark("0000000000000001"));
    await writeFile(filePath, "{ not json", "utf8");

    const reopened = createFileHighWaterMarkStore({ filePath, fs });
    await expect(reopened.get(alice)).rejects.toBeInstanceOf(CorpusMirrorError);
  });

  test("refuses a structurally invalid state file", async () => {
    await writeFile(filePath.replace(/[^/]+$/u, ""), "", "utf8").catch(() => undefined);
    const store = createFileHighWaterMarkStore({ filePath, fs });
    await store.put(alice, mark("0000000000000001"));
    await writeFile(filePath, JSON.stringify({ format: "wrong", marks: {} }), "utf8");

    await expect(createFileHighWaterMarkStore({ filePath, fs }).get(alice)).rejects.toBeInstanceOf(
      CorpusMirrorError,
    );
  });
});
