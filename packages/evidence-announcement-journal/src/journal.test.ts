// SPDX-License-Identifier: MIT
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  EvidenceAnnouncementJournalError,
  openFilesystemEvidenceAnnouncementJournal,
} from "./index.js";
import {
  openFilesystemEvidenceAnnouncementJournalForTesting,
  type JournalAppendFaultPoint,
} from "./journal.js";
import { deterministicBytes, digestBytes } from "./serialization.js";

const SOURCE = "urn:uuid:11111111-1111-4111-8111-111111111111";
const REPOSITORY = "local:11111111-1111-4111-8111-111111111111";
const references = [1, 2, 3].map((digit) => ({
  family: "execution-evidence" as const,
  digest: `sha256:${String(digit).repeat(64)}` as const,
}));

describe("filesystem announcement journal", () => {
  const temporaryRoots: string[] = [];

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "jinn-announcement-journal-"));
    temporaryRoots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ));
  });

  test("uses padded immutable files and finite snapshot replay", async () => {
    const root = await temporaryRoot();
    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    const first = await journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    const iterator = journal.read()[Symbol.asyncIterator]();
    const firstYield = await iterator.next();
    const second = await journal.appendAvailable({
      announcementId: "event-2",
      reference: references[1]!,
      repositoryId: REPOSITORY,
    });
    expect(firstYield.value).toEqual({
      announcements: [first.announcement],
      cursor: first.cursor,
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(await readdir(join(root, "events"))).toEqual([
      "00000000000000000001.json",
      "00000000000000000002.json",
    ]);

    const resumed = [];
    for await (const batch of journal.read({ after: first.cursor })) {
      resumed.push(batch);
    }
    expect(resumed).toEqual([
      { announcements: [second.announcement], cursor: second.cursor },
    ]);
    await journal.close();
  });

  test("rejects conflicting identities and snapshots mutable input", async () => {
    const root = await temporaryRoot();
    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    const input = {
      announcementId: "event-1",
      reference: { ...references[0]! },
      repositoryId: REPOSITORY,
      publishedLocation: {
        bindingProfile: "https://example.invalid/local",
        locator: { nested: { value: "original" } },
      },
    };
    const pending = journal.appendAvailable(input);
    input.reference.digest = references[1]!.digest;
    input.publishedLocation.locator.nested.value = "changed";
    const created = await pending;
    expect(created.announcement.reference).toEqual(references[0]);
    expect(created.announcement.publishedLocation?.locator).toEqual({
      nested: { value: "original" },
    });
    await expect(journal.appendAvailable({
      announcementId: "event-1",
      reference: references[1]!,
      repositoryId: REPOSITORY,
    })).rejects.toMatchObject({ code: "ANNOUNCEMENT_CONFLICT" });
    await journal.close();
  });

  test("ignores incomplete temporary files and rejects gaps or changed bytes", async () => {
    const root = await temporaryRoot();
    let journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    await journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    await journal.appendAvailable({
      announcementId: "event-2",
      reference: references[1]!,
      repositoryId: REPOSITORY,
    });
    await journal.close();
    await writeFile(join(root, "events", ".tmp-incomplete.json"), "{");
    journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    expect(await journal.getEntryCount()).toBe(2);
    await journal.close();

    const firstPath = join(root, "events", "00000000000000000001.json");
    const original = await readFile(firstPath, "utf8");
    await writeFile(firstPath, original.replace("\"event-1\"", "\"changed\""));
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
  });

  test("rejects predecessor breaks, invalid UTF-8, and another chain's cursor", async () => {
    const leftRoot = await temporaryRoot();
    const rightRoot = await temporaryRoot();
    const left = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: leftRoot,
      sourceId: SOURCE,
    });
    const leftReceipt = await left.appendAvailable({
      announcementId: "left",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    const right = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: rightRoot,
      sourceId: "urn:uuid:22222222-2222-4222-8222-222222222222",
    });
    await right.appendAvailable({
      announcementId: "right",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    await expect((async () => {
      for await (const _batch of right.read({ after: leftReceipt.cursor })) {
        // Exhaust the source.
      }
    })()).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await left.close();
    await right.close();

    const eventPath = join(leftRoot, "events", "00000000000000000001.json");
    await writeFile(eventPath, Uint8Array.from([0xff, 0xfe]));
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: leftRoot,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
  });

  test("rejects noncanonical and oversized journal cursors", async () => {
    const root = await temporaryRoot();
    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    const receipt = await journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    const decoded = JSON.parse(
      Buffer.from(receipt.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const hostile = [
      Buffer.from(JSON.stringify(decoded, null, 2)).toString("base64url"),
      Buffer.from(JSON.stringify({
        entryDigest: decoded.entryDigest,
        revision: decoded.revision,
        sourceId: decoded.sourceId,
        version: decoded.version,
      })).toString("base64url"),
      Buffer.from(
        JSON.stringify(decoded).replace('"version":1', '"version":1,"version":1'),
      ).toString("base64url"),
      "A".repeat(4097),
    ];
    for (const cursor of hostile) {
      await expect((async () => {
        for await (const _batch of journal.read({ after: cursor })) {
          // Exhaust the source.
        }
      })()).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    }
    await journal.close();
  });

  test("rejects revision gaps, invalid JSON, and marker mismatch", async () => {
    const gapRoot = await temporaryRoot();
    let journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: gapRoot,
      sourceId: SOURCE,
    });
    for (let index = 0; index < 2; index += 1) {
      await journal.appendAvailable({
        announcementId: `event-${index + 1}`,
        reference: references[index]!,
        repositoryId: REPOSITORY,
      });
    }
    await journal.close();
    await rename(
      join(gapRoot, "events", "00000000000000000002.json"),
      join(gapRoot, "events", "00000000000000000003.json"),
    );
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: gapRoot,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });

    const jsonRoot = await temporaryRoot();
    journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: jsonRoot,
      sourceId: SOURCE,
    });
    await journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    await journal.close();
    await writeFile(
      join(jsonRoot, "events", "00000000000000000001.json"),
      "{",
    );
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: jsonRoot,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });

    const markerRoot = await temporaryRoot();
    journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: markerRoot,
      sourceId: SOURCE,
    });
    await journal.close();
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: markerRoot,
      sourceId: "urn:uuid:33333333-3333-4333-8333-333333333333",
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
    await writeFile(
      join(markerRoot, "journal.json"),
      `${JSON.stringify({
        format: "jinn-evidence-announcement-journal",
        sourceId: SOURCE,
        version: 2,
      }, null, 2)}\n`,
    );
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: markerRoot,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_VERSION_UNSUPPORTED" });
  });

  test("rejects a second physical event that reuses an announcement identity", async () => {
    const root = await temporaryRoot();
    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    await journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    await journal.close();
    const firstBytes = await readFile(
      join(root, "events", "00000000000000000001.json"),
    );
    await writeFile(
      join(root, "events", "00000000000000000002.json"),
      deterministicBytes({
        version: 1,
        revision: 2,
        predecessorDigest: digestBytes(firstBytes),
        announcement: {
          kind: "available",
          sourceId: SOURCE,
          announcementId: "event-1",
          reference: references[1],
          repositoryId: REPOSITORY,
        },
      }),
      { mode: 0o600 },
    );
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
  });

  test("recovers one final journal-owned temporary hard link", async () => {
    const root = await temporaryRoot();
    let journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    await journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    await journal.close();
    const finalPath = join(root, "events", "00000000000000000001.json");
    const temporaryPath = join(root, "events", ".tmp-recovery.json");
    await link(finalPath, temporaryPath);
    expect((await lstat(finalPath)).nlink).toBe(2);
    journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    expect((await lstat(finalPath)).nlink).toBe(1);
    expect(await journal.getEntryCount()).toBe(1);
    await journal.close();
  });

  test("recovers interruption at every append publication transition", async () => {
    const points: JournalAppendFaultPoint[] = [
      "before-file-sync",
      "before-hard-link",
      "before-temporary-removal",
      "before-directory-sync",
    ];
    for (const point of points) {
      const root = await temporaryRoot();
      let injected = false;
      const interrupted =
        await openFilesystemEvidenceAnnouncementJournalForTesting(
          { rootDir: root, sourceId: SOURCE },
          (current) => {
            if (!injected && current === point) {
              injected = true;
              throw new Error(`Injected interruption at ${point}`);
            }
          },
        );
      await expect(interrupted.appendAvailable({
        announcementId: "event-1",
        reference: references[0]!,
        repositoryId: REPOSITORY,
      })).rejects.toMatchObject({ code: "IO_FAILURE" });
      await interrupted.close();

      const recovered = await openFilesystemEvidenceAnnouncementJournal({
        rootDir: root,
        sourceId: SOURCE,
      });
      const expectedExisting =
        point === "before-temporary-removal" ||
        point === "before-directory-sync";
      expect(await recovered.getEntryCount()).toBe(expectedExisting ? 1 : 0);
      expect((await recovered.appendAvailable({
        announcementId: "event-1",
        reference: references[0]!,
        repositoryId: REPOSITORY,
      })).status).toBe(expectedExisting ? "existing" : "created");
      await recovered.close();
    }
  });

  test("rejects managed symlinks and corrects private modes", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    let journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    await journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    await journal.close();
    const marker = join(root, "journal.json");
    const event = join(root, "events", "00000000000000000001.json");
    await chmod(root, 0o755);
    await chmod(join(root, "events"), 0o755);
    await chmod(marker, 0o644);
    await chmod(event, 0o644);
    journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "events"))).mode & 0o777).toBe(0o700);
    expect((await lstat(marker)).mode & 0o777).toBe(0o600);
    expect((await lstat(event)).mode & 0o777).toBe(0o600);
    await journal.close();

    const target = join(dirname(root), `${basename(root)}-target`);
    temporaryRoots.push(target);
    await mkdir(target);
    await rm(join(root, "events"), { recursive: true });
    await symlink(target, join(root, "events"));
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
  });

  test("rejects root, marker, event, parent symlinks and foreign hard links", async () => {
    if (process.platform === "win32") return;

    const parentRoot = await temporaryRoot();
    const realParent = join(parentRoot, "real");
    const linkedParent = join(parentRoot, "linked");
    await mkdir(realParent);
    await symlink(realParent, linkedParent);
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: join(linkedParent, "journal"),
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });

    const rootTarget = await temporaryRoot();
    const rootLink = `${rootTarget}-link`;
    temporaryRoots.push(rootLink);
    await symlink(rootTarget, rootLink);
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: rootLink,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });

    const markerRoot = await temporaryRoot();
    let journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: markerRoot,
      sourceId: SOURCE,
    });
    await journal.close();
    const markerPath = join(markerRoot, "journal.json");
    const markerTarget = join(markerRoot, "marker-target");
    await rename(markerPath, markerTarget);
    await symlink(markerTarget, markerPath);
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: markerRoot,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });

    const eventRoot = await temporaryRoot();
    journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: eventRoot,
      sourceId: SOURCE,
    });
    await journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    await journal.close();
    const eventPath = join(
      eventRoot,
      "events",
      "00000000000000000001.json",
    );
    const eventTarget = join(eventRoot, "events", ".tmp-event-target.json");
    await rename(eventPath, eventTarget);
    await symlink(eventTarget, eventPath);
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: eventRoot,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });

    const hardLinkRoot = await temporaryRoot();
    journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: hardLinkRoot,
      sourceId: SOURCE,
    });
    await journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    await journal.close();
    const hardLinkEvent = join(
      hardLinkRoot,
      "events",
      "00000000000000000001.json",
    );
    await link(hardLinkEvent, join(hardLinkRoot, "foreign-link"));
    await expect(openFilesystemEvidenceAnnouncementJournal({
      rootDir: hardLinkRoot,
      sourceId: SOURCE,
    })).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
  });

  test("serializes append races and rejects a stale second handle", async () => {
    const root = await temporaryRoot();
    const first = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    const second = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        first.appendAvailable({
          announcementId: "event-1",
          reference: references[0]!,
          repositoryId: REPOSITORY,
        })
      ),
    );
    expect(results.filter(({ status }) => status === "created")).toHaveLength(1);
    await expect(second.appendAvailable({
      announcementId: "event-2",
      reference: references[1]!,
      repositoryId: REPOSITORY,
    })).rejects.toMatchObject({ code: "STALE_WRITER" });
    await first.close();
    await second.close();
  });

  test("honors aborts and rejects operations after close", async () => {
    const root = await temporaryRoot();
    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(journal.appendAvailable({
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    }, { signal: controller.signal })).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
    });
    await journal.close();
    await journal.close();
    await expect(journal.getEntryCount()).rejects.toMatchObject({
      code: "JOURNAL_CLOSED",
    });
    await expect((async () => {
      for await (const _batch of journal.read()) {
        // Exhaust the source.
      }
    })()).rejects.toBeInstanceOf(EvidenceAnnouncementJournalError);
  });

  test("finishes an append uninterruptibly after publishing its final link", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const journal = await openFilesystemEvidenceAnnouncementJournalForTesting(
      { rootDir: root, sourceId: SOURCE },
      (point) => {
        if (point === "before-directory-sync") controller.abort();
      },
    );
    const input = {
      announcementId: "event-1",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    };
    await expect(journal.appendAvailable(input, {
      signal: controller.signal,
    })).resolves.toMatchObject({ status: "created" });
    expect(await journal.getEntryCount()).toBe(1);
    await expect(journal.appendAvailable(input))
      .resolves.toMatchObject({ status: "existing" });
    await journal.close();
  });

  test("rejects unsafe announcements with stable errors and snapshots receipts", async () => {
    const root = await temporaryRoot();
    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    const invalidInputs = [
      {
        announcementId: "",
        reference: references[0],
        repositoryId: REPOSITORY,
      },
      {
        announcementId: "event",
        reference: { family: "execution-evidence", digest: "sha256:BAD" },
        repositoryId: REPOSITORY,
      },
      {
        announcementId: "event",
        reference: references[0],
        repositoryId: "",
      },
      {
        announcementId: "event",
        reference: references[0],
        repositoryId: REPOSITORY,
        publishedLocation: {
          bindingProfile: "relative",
          locator: {},
        },
      },
      {
        announcementId: "event",
        reference: references[0],
        repositoryId: REPOSITORY,
        publishedLocation: {
          bindingProfile: "https://example.invalid/binding",
          locator: { invalid: Number.NaN },
        },
      },
      {
        announcementId: "event",
        reference: references[0],
        repositoryId: REPOSITORY,
        extra: true,
      },
    ];
    for (const input of invalidInputs) {
      await expect(
        journal.appendAvailable(input as never),
      ).rejects.toMatchObject({ code: "INVALID_ANNOUNCEMENT" });
    }
    const getterBacked = Object.defineProperty({}, "announcementId", {
      enumerable: true,
      get: () => "event",
    });
    await expect(
      journal.appendAvailable(getterBacked as never),
    ).rejects.toMatchObject({ code: "INVALID_ANNOUNCEMENT" });

    const receipt = await journal.appendAvailable({
      announcementId: "event",
      reference: references[0]!,
      repositoryId: REPOSITORY,
    });
    (receipt.announcement as { repositoryId: string }).repositoryId = "changed";
    expect((await journal.findAvailable(references[0]!))?.announcement.repositoryId)
      .toBe(REPOSITORY);

    await rm(join(root, "journal.json"));
    await expect(journal.getEntryCount()).rejects.toBeInstanceOf(
      EvidenceAnnouncementJournalError,
    );
    await journal.close();
  });

  test("close drains every append accepted before closing", async () => {
    const root = await temporaryRoot();
    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    const appends = references.map((reference, index) =>
      journal.appendAvailable({
        announcementId: `event-${index + 1}`,
        reference,
        repositoryId: REPOSITORY,
      })
    );
    const closing = journal.close();
    await expect(Promise.all(appends)).resolves.toHaveLength(3);
    await closing;

    const reopened = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: root,
      sourceId: SOURCE,
    });
    expect(await reopened.getEntryCount()).toBe(3);
    await reopened.close();
  });
});
