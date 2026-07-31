// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CORPUS_SYNC_LOCK_FORMAT, tryAcquireSyncLock } from "./lock.js";
import { createNodeCorpusFilesystem } from "./node-fs.test.js";

const fs = createNodeCorpusFilesystem();

let directory: string;
let lockPath: string;
let child: ChildProcess | undefined;

const HOLDER_SCRIPT = `
const Database = require('better-sqlite3');
const database = new Database(process.argv[1], { timeout: 0 });
database.pragma('busy_timeout = 0');
database.pragma('locking_mode = EXCLUSIVE');
database.exec('CREATE TABLE IF NOT EXISTS corpus_sync_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), format TEXT NOT NULL)');
database.prepare('INSERT INTO corpus_sync_lock(singleton, format) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING').run(process.argv[2]);
database.exec('BEGIN EXCLUSIVE');
database.prepare('UPDATE corpus_sync_lock SET format = format WHERE singleton = 1').run();
process.stdout.write('held\\n');
setInterval(() => {}, 60000);
`;

async function startHolder(path: string): Promise<ChildProcess> {
  const process_ = spawn(
    process.execPath,
    ["-e", HOLDER_SCRIPT, path, CORPUS_SYNC_LOCK_FORMAT],
    { cwd: new URL("../..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("holder did not report")), 15_000);
    process_.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("held")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    process_.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
  return process_;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-lock-"));
  lockPath = join(directory, "nested", "mirror-sync.lock");
});

afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  await rm(directory, { recursive: true, force: true });
});

describe("mirror sync lock", () => {
  test("acquires when free", async () => {
    const lock = await tryAcquireSyncLock({ path: lockPath, fs });
    expect(lock).toBeDefined();
    await lock!.close();
  });

  test("creates the lock file owner-only, making its parent directory", async () => {
    const lock = await tryAcquireSyncLock({ path: lockPath, fs });
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    await lock!.close();
  });

  test("SKIPS rather than waits when already held in this process", async () => {
    const first = await tryAcquireSyncLock({ path: lockPath, fs });
    expect(first).toBeDefined();

    const started = Date.now();
    const second = await tryAcquireSyncLock({ path: lockPath, fs });
    const elapsed = Date.now() - started;

    expect(second).toBeUndefined();
    expect(elapsed).toBeLessThan(1_000);

    await first!.close();
  });

  test("SKIPS rather than waits when held by another process", async () => {
    const lock = await tryAcquireSyncLock({ path: lockPath, fs });
    await lock!.close();

    child = await startHolder(lockPath);

    const started = Date.now();
    const attempt = await tryAcquireSyncLock({ path: lockPath, fs });
    const elapsed = Date.now() - started;

    expect(attempt).toBeUndefined();
    expect(elapsed).toBeLessThan(1_000);
  });

  test("becomes acquirable again once the holder releases", async () => {
    const first = await tryAcquireSyncLock({ path: lockPath, fs });
    await first!.close();
    const second = await tryAcquireSyncLock({ path: lockPath, fs });
    expect(second).toBeDefined();
    await second!.close();
  });

  test("close is idempotent", async () => {
    const lock = await tryAcquireSyncLock({ path: lockPath, fs });
    await lock!.close();
    await expect(lock!.close()).resolves.toBeUndefined();
  });
});
