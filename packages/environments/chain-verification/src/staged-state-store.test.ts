// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChainVerificationError } from "./errors.js";
import { createStagedStateFile, upsertStagedJobs } from "./staged-state.js";
import { createFileStagedStateStore } from "./staged-state-store.js";

const DIGEST_A = `sha256:${"1".repeat(64)}` as const;
const T0 = "2026-07-31T09:00:00.000Z";
const T1 = "2026-07-31T09:05:00.000Z";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-chain-staged-state-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file staged-state store", () => {
  it("returns null before anything is written", async () => {
    expect(await createFileStagedStateStore(directory).load()).toBeNull();
  });

  it("round-trips and resumes across store instances", async () => {
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    await createFileStagedStateStore(directory).save(file);
    expect(await createFileStagedStateStore(directory).load()).toEqual(file);
  });

  it("writes through a sibling temporary file and leaves only the state file", async () => {
    const store = createFileStagedStateStore(directory);
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    await store.save(file);
    const entries = await readdir(directory);
    expect(entries).toEqual(["staged-state.json"]);
    expect(entries.some((entry) => entry.startsWith(".staged-state."))).toBe(false);
    const bytes = await readFile(join(directory, "staged-state.json"));
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("ignores an abandoned temporary file from a crashed write", async () => {
    const store = createFileStagedStateStore(directory);
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    await store.save(file);
    await writeFile(join(directory, ".staged-state.1234.tmp"), "{ truncated", "utf8");
    expect(await store.load()).toEqual(file);
  });

  it("leaves exactly one file after two sequential saves", async () => {
    const store = createFileStagedStateStore(directory);
    await store.save(upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0));
    await store.save(upsertStagedJobs(createStagedStateFile(T1), [DIGEST_A], T1));
    expect(await readdir(directory)).toEqual(["staged-state.json"]);
    expect(await store.load()).toEqual(upsertStagedJobs(createStagedStateFile(T1), [DIGEST_A], T1));
  });

  it("fails loud on a corrupt state file rather than starting clean", async () => {
    await writeFile(join(directory, "staged-state.json"), "{ not json", "utf8");
    await expect(createFileStagedStateStore(directory).load())
      .rejects.toThrow(ChainVerificationError);
  });

  it("fails loud on a truncated state file", async () => {
    await writeFile(join(directory, "staged-state.json"), "{ truncated", "utf8");
    await expect(createFileStagedStateStore(directory).load())
      .rejects.toThrow(ChainVerificationError);
  });
});
