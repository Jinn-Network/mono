// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "../capture/paths.js";
import { openIndexDatabase, type IndexDatabaseIO } from "./database.js";
import { INDEX_SCHEMA_VERSION, INDEX_TOKENIZER } from "./schema.js";

const testIndexIo: IndexDatabaseIO = {
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  removeFile: (path) => rm(path, { force: true }),
};

const freshPath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "jinn-index-")), "index.sqlite");

describe("index database", () => {
  test("creates the schema and records its generation", async () => {
    const path = await freshPath();
    const opened = await openIndexDatabase({ databasePath: path, io: testIndexIo });
    const meta = opened.database
      .prepare("SELECT schema_version, tokenizer FROM index_metadata WHERE singleton = 1")
      .get() as { schema_version: number; tokenizer: string };
    expect(meta.schema_version).toBe(INDEX_SCHEMA_VERSION);
    expect(meta.tokenizer).toBe(INDEX_TOKENIZER);
    expect(opened.rebuiltFromScratch).toBe(true);
    opened.database.close();
  });

  test("FTS5 is available and the configured tokenizer works", async () => {
    const path = await freshPath();
    const opened = await openIndexDatabase({ databasePath: path, io: testIndexIo });
    opened.database
      .prepare(
        "INSERT INTO document_terms(rowid, summary, summary_idents, body, body_idents) VALUES (?,?,?,?,?)",
      )
      .run(1, "snake_case_thing client/src/dashboard", "", "parse trajectory", "");
    const hit = (query: string): number =>
      (
        opened.database
          .prepare("SELECT count(*) AS c FROM document_terms WHERE document_terms MATCH ?")
          .get(query) as { c: number }
      ).c;
    expect(hit('"dashboard"')).toBe(1);
    expect(hit('"case"')).toBe(1);
    expect(hit('{body} : "trajectory"')).toBe(1);
    expect(hit('{summary} : "trajectory"')).toBe(0);
    expect(hit('"absent"')).toBe(0);
    opened.database.close();
  });

  test("WAL and the safety pragmas are set", async () => {
    const path = await freshPath();
    const opened = await openIndexDatabase({ databasePath: path, io: testIndexIo });
    expect(String(opened.database.pragma("journal_mode", { simple: true }))).toBe("wal");
    expect(Number(opened.database.pragma("busy_timeout", { simple: true }))).toBe(5000);
    opened.database.close();
  });

  test("the database file is owner-only", async () => {
    const path = await freshPath();
    const opened = await openIndexDatabase({ databasePath: path, io: testIndexIo });
    opened.database.close();
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("reopening keeps the content", async () => {
    const path = await freshPath();
    const first = await openIndexDatabase({ databasePath: path, io: testIndexIo });
    first.database.prepare("INSERT INTO document_terms(rowid, summary, summary_idents, body, body_idents) VALUES (1,'kept','','','')").run();
    first.database.close();
    const second = await openIndexDatabase({ databasePath: path, io: testIndexIo });
    expect(second.rebuiltFromScratch).toBe(false);
    expect(
      (
        second.database
          .prepare("SELECT count(*) AS c FROM document_terms WHERE document_terms MATCH '\"kept\"'")
          .get() as { c: number }
      ).c,
    ).toBe(1);
    second.database.close();
  });

  test("a tokenizer change drops and recreates rather than mixing tokenizations", async () => {
    const path = await freshPath();
    const first = await openIndexDatabase({ databasePath: path, io: testIndexIo });
    first.database.prepare("INSERT INTO document_terms(rowid, summary, summary_idents, body, body_idents) VALUES (1,'stale','','','')").run();
    first.database.prepare("UPDATE index_metadata SET tokenizer = 'ascii' WHERE singleton = 1").run();
    first.database.close();

    const second = await openIndexDatabase({ databasePath: path, io: testIndexIo });
    expect(second.rebuiltFromScratch).toBe(true);
    expect(
      (
        second.database
          .prepare("SELECT count(*) AS c FROM document_terms WHERE document_terms MATCH '\"stale\"'")
          .get() as { c: number }
      ).c,
    ).toBe(0);
    second.database.close();
  });
});
