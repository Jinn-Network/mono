// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { RuntimeLogger } from "../logger.js";
import { createNodeCorpusFilesystem } from "./node-fs.test.js";
import {
  MIRROR_SYNC_STATUS_FORMAT,
  createFileMirrorSyncStatusStore,
  type MirrorSyncStatusRecord,
} from "./sync-status.js";

const fs = createNodeCorpusFilesystem();

interface Warning {
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

function recordingLogger(): { readonly log: RuntimeLogger; readonly warnings: Warning[] } {
  const warnings: Warning[] = [];
  const log: RuntimeLogger = {
    debug: () => {},
    info: () => {},
    warn: (message, fields) => warnings.push({ message, ...(fields === undefined ? {} : { fields }) }),
    error: () => {},
  };
  return { log, warnings };
}

const record = (): MirrorSyncStatusRecord => ({
  format: MIRROR_SYNC_STATUS_FORMAT,
  lastCycle: { completedAt: "2026-09-01T00:00:00.000Z", status: "synced" },
  sources: {
    "https://agents.test/alice/attempts": { lastSyncedAt: "2026-09-01T00:00:00.000Z" },
    "https://agents.test/bob/attempts": {
      lastFailure: { code: "TRANSPORT", message: "unreachable", at: "2026-09-01T00:00:00.000Z" },
    },
  },
});

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-mirror-status-"));
  filePath = join(directory, "state", "mirror-sync-status.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file-backed mirror sync-status store", () => {
  test("reads an absent file as undefined", async () => {
    const { log } = recordingLogger();
    const store = createFileMirrorSyncStatusStore({ filePath, fs, log });
    expect(await store.read()).toBeUndefined();
  });

  test("round-trips a written record", async () => {
    const { log } = recordingLogger();
    await createFileMirrorSyncStatusStore({ filePath, fs, log }).write(record());
    expect(await createFileMirrorSyncStatusStore({ filePath, fs, log }).read()).toEqual(record());
  });

  test("writes atomically, leaving no temporary sibling behind", async () => {
    const { log } = recordingLogger();
    await createFileMirrorSyncStatusStore({
      filePath,
      fs,
      log,
      tempNonce: () => "nonce",
    }).write(record());
    expect(await readdir(dirname(filePath))).toEqual(["mirror-sync-status.json"]);
  });

  test("warns and reads a corrupt file as undefined rather than throwing", async () => {
    // Deliberately unlike the high-water-mark store, which throws: treating
    // ITS corruption as "never synced" would replay every archive from
    // genesis, whereas nothing about this reporting file is expensive to lose.
    const { log, warnings } = recordingLogger();
    await createFileMirrorSyncStatusStore({ filePath, fs, log }).write(record());
    await writeFile(filePath, "{ not json", "utf8");

    expect(await createFileMirrorSyncStatusStore({ filePath, fs, log }).read()).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe("corpus.mirror.status.unreadable");
    expect(warnings[0]!.fields).toMatchObject({ path: filePath });
  });

  test("warns and reads an unrecognized format as undefined", async () => {
    const { log, warnings } = recordingLogger();
    await createFileMirrorSyncStatusStore({ filePath, fs, log }).write(record());
    await writeFile(filePath, JSON.stringify({ format: "wrong", sources: {} }), "utf8");

    expect(await createFileMirrorSyncStatusStore({ filePath, fs, log }).read()).toBeUndefined();
    expect(warnings.map((warning) => warning.message)).toEqual(["corpus.mirror.status.unreadable"]);
  });

  test("writes sources in code-unit key order so the file diffs cleanly", async () => {
    const { log } = recordingLogger();
    await createFileMirrorSyncStatusStore({ filePath, fs, log }).write({
      format: MIRROR_SYNC_STATUS_FORMAT,
      sources: {
        "https://agents.test/bob/attempts": {},
        "https://agents.test/alice/attempts": {},
      },
    });
    const body = await readFile(filePath, "utf8");
    expect(body.indexOf("alice")).toBeLessThan(body.indexOf("bob"));
  });
});
