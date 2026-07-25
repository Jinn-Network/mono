// SPDX-License-Identifier: MIT
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import * as journalRoot from "./index.js";
import {
  EVIDENCE_ANNOUNCEMENT_JOURNAL_ERROR_CODES,
  EVIDENCE_ANNOUNCEMENT_JOURNAL_FORMAT,
  EvidenceAnnouncementJournalError,
  openFilesystemEvidenceAnnouncementJournal,
} from "./index.js";

const DIGEST =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const;

describe("announcement journal root contract", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  test("freezes format and stable error codes", () => {
    expect(EVIDENCE_ANNOUNCEMENT_JOURNAL_FORMAT).toEqual({
      format: "jinn-evidence-announcement-journal",
      version: 1,
    });
    expect(EVIDENCE_ANNOUNCEMENT_JOURNAL_ERROR_CODES).toEqual([
      "INVALID_ANNOUNCEMENT",
      "ANNOUNCEMENT_CONFLICT",
      "CURSOR_INVALID",
      "JOURNAL_VERSION_UNSUPPORTED",
      "JOURNAL_CORRUPT",
      "STALE_WRITER",
      "JOURNAL_CLOSED",
      "OPERATION_ABORTED",
      "IO_FAILURE",
    ]);
    expect(
      new EvidenceAnnouncementJournalError("IO_FAILURE", "fixture").code,
    ).toBe("IO_FAILURE");
    expect("encodeJournalCursor" in journalRoot).toBe(false);
    expect("replayJournal" in journalRoot).toBe(false);
    expect("openFilesystemEvidenceAnnouncementJournalForTesting" in journalRoot)
      .toBe(false);
  });

  test("opens empty and appends an idempotent replayable source", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-journal-contract-"));
    roots.push(root);
    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    });
    expect(await journal.getHighWaterCursor()).toBeUndefined();
    expect(await journal.getEntryCount()).toBe(0);

    const input = {
      announcementId: "urn:jinn:announcement:1",
      reference: { family: "execution-evidence", digest: DIGEST },
      repositoryId: "local:fixture",
    } as const;
    const created = await journal.appendAvailable(input);
    expect(created.status).toBe("created");
    expect((await journal.appendAvailable(input)).status).toBe("existing");
    expect(await journal.getEntryCount()).toBe(1);
    expect(await journal.getHighWaterCursor()).toBe(created.cursor);
    expect(await journal.findAvailable(input.reference)).toEqual(created);

    const batches = [];
    for await (const batch of journal.read()) batches.push(batch);
    expect(batches).toEqual([
      { announcements: [created.announcement], cursor: created.cursor },
    ]);

    const resumed = [];
    for await (const batch of journal.read({ after: created.cursor })) {
      resumed.push(batch);
    }
    expect(resumed).toEqual([]);
    await journal.close();
  });
});
