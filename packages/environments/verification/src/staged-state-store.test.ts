// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EnvironmentVerificationError } from "./errors.js";
import { createStagedStateFile, upsertStagedJobs } from "./staged-state.js";
import { createFileStagedStateStore } from "./staged-state-store.js";

const DIGEST_A = `sha256:${"1".repeat(64)}` as const;
const T0 = "2026-07-31T09:00:00.000Z";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-staged-state-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file staged-state store", () => {
  it("returns null before anything is written", async () => {
    expect(await createFileStagedStateStore(directory).read()).toBeNull();
  });

  it("round-trips and resumes across store instances", async () => {
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    await createFileStagedStateStore(directory).write(file);
    expect(await createFileStagedStateStore(directory).read()).toEqual(file);
  });

  it("leaves no temporary files behind", async () => {
    const store = createFileStagedStateStore(directory);
    await store.write(upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0));
    const entries = await readdir(directory);
    expect(entries).toEqual(["staged-state.json"]);
  });

  it("ignores an abandoned temporary file from a crashed write", async () => {
    const store = createFileStagedStateStore(directory);
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    await store.write(file);
    await writeFile(join(directory, "staged-state.json.1234.tmp"), "{ truncated", "utf8");
    expect(await store.read()).toEqual(file);
  });

  it("fails loud on a corrupt state file rather than starting clean", async () => {
    await writeFile(join(directory, "staged-state.json"), "{ not json", "utf8");
    await expect(createFileStagedStateStore(directory).read())
      .rejects.toThrow(EnvironmentVerificationError);
  });
});
