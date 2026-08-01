// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChainExtractionError } from "./errors.js";
import { createExtractionStateFile, upsertExtractionJobs } from "./extraction-state.js";
import { createFileExtractionStateStore } from "./extraction-state-store.js";

const KEY = `sha256:${"1".repeat(64)}` as const;
const T0 = "2026-07-31T09:00:00.000Z";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-extraction-state-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file extraction-state store", () => {
  it("returns null before anything is written", async () => {
    expect(await createFileExtractionStateStore(directory).read()).toBeNull();
  });

  it("round-trips through an atomic rename and leaves no temporary files", async () => {
    const file = upsertExtractionJobs(createExtractionStateFile(T0), [KEY], T0);
    const store = createFileExtractionStateStore(directory);
    await store.write(file);
    expect(await createFileExtractionStateStore(directory).read()).toEqual(file);
    expect(await readdir(directory)).toEqual(["extraction-state.json"]);
  });

  it("fails loud on a corrupt state file rather than starting clean", async () => {
    await writeFile(join(directory, "extraction-state.json"), "{ not json", "utf8");
    await expect(createFileExtractionStateStore(directory).read())
      .rejects.toThrow(ChainExtractionError);
  });
});
