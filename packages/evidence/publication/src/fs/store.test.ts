// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  readdirSync,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRecordReference } from "@jinn-network/evidence-repository";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createFilesystemPublicationJournalStore,
  FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES,
} from "./index.js";
import {
  FILESYSTEM_PUBLICATION_JOURNAL_MARKER_BYTES,
} from "./paths.js";
import {
  derivePublicationIdentities,
  hashExactBytes,
} from "../identities.js";
import {
  encodeVersionedPublicationJournalEntry,
} from "../journal.js";
import type { PublicationJournalEntry } from "../types.js";
import {
  describePublicationJournalStoreContract,
} from "../testing.js";

const roots: string[] = [];
const authorityMarkers = [
  new TextEncoder().encode(
    "printable-publication-authority-marker-0001",
  ),
  Uint8Array.from([
    0xff, 0xfe, 0x80, 0x00, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
    0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
    0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
  ]),
] as const;

async function temporaryRoot(): Promise<string> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-"))
  );
  roots.push(root);
  return root;
}

function entry(): PublicationJournalEntry {
  const destination = "urn:jinn:publication-destination:fs-test";
  const records = [
    createRecordReference("execution-evidence", new Uint8Array([1])),
  ];
  return {
    schemaVersion: 1,
    ...derivePublicationIdentities(records, [], destination),
    destination,
    repositoryCapabilities: {},
    artifacts: [],
    records,
    storedArtifacts: [],
    storedRecords: [],
    completed: false,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describePublicationJournalStoreContract(async () => {
  const root = await temporaryRoot();
  return {
    store: await createFilesystemPublicationJournalStore({ rootDir: root }),
    authorityMarkers,
    injectCorruption: async (created) => {
      const hex = created.bundleKey.slice(7);
      await writeFile(
        join(
          root,
          "entries",
          "sha256",
          hex.slice(0, 2),
          hex.slice(2),
          `${String(created.revision).padStart(20, "0")}.json`,
        ),
        Uint8Array.of(0),
        { mode: 0o600 },
      );
    },
  };
});

describe("filesystem publication journal store", () => {
  test("rejects a hard-linked root marker before changing the outside inode", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const outsidePath = join(outside, "outside-marker.json");
    const markerPath = join(root, "publication-journal.json");
    await writeFile(
      outsidePath,
      FILESYSTEM_PUBLICATION_JOURNAL_MARKER_BYTES,
      { mode: 0o644 },
    );
    await link(outsidePath, markerPath);
    const beforeBytes = await readFile(outsidePath);

    await expect(
      createFilesystemPublicationJournalStore({ rootDir: root }),
    ).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });

    expect((await lstat(outsidePath)).mode & 0o7777).toBe(0o644);
    expect(await readFile(outsidePath)).toEqual(beforeBytes);
  });

  test("canonicalizes a stable unmanaged macOS /var ancestor", async ({
    skip,
  }) => {
    if (process.platform !== "darwin") skip();
    const varStats = await lstat("/var");
    if (!varStats.isSymbolicLink()) skip();
    const aliasBase = await mkdtemp("/var/tmp/jinn-publication-alias-");
    roots.push(aliasBase);
    const root = join(aliasBase, "journal");

    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());

    expect(await realpath(root)).not.toBe(root);
    await expect(store.load(created.bundleKey)).resolves.toEqual(created);
  });

  test("creates private roots and immutable revision files", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const next = await store.compareAndSwap(created, {
      ...created,
      storedRecords: [{
        reference: created.records[0]!,
        size: 1,
      }],
    });
    expect(next.revision).toBe(1);

    const rootMode = (await lstat(root)).mode & 0o777;
    if (process.platform !== "win32") expect(rootMode).toBe(0o700);
    const hex = created.bundleKey.slice(7);
    const revisionDir = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    expect(await readdir(revisionDir)).toEqual([
      "00000000000000000000.json",
      "00000000000000000001.json",
    ]);
    for (const name of await readdir(revisionDir)) {
      const stats = await lstat(join(revisionDir, name));
      expect(stats.isFile()).toBe(true);
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600);
      }
    }
  });

  test("normalizes every current-user managed directory and file to exact private modes", async ({
    skip,
  }) => {
    if (process.platform === "win32") skip();
    const root = await temporaryRoot();
    await chmod(root, 0o755);
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const hex = created.bundleKey.slice(7);
    const managedDirectories = [
      root,
      join(root, "entries"),
      join(root, "entries", "sha256"),
      join(root, "entries", "sha256", hex.slice(0, 2)),
      join(root, "entries", "sha256", hex.slice(0, 2), hex.slice(2)),
    ];
    const managedFiles = [
      join(root, "publication-journal.json"),
      join(
        root,
        "entries",
        "sha256",
        hex.slice(0, 2),
        hex.slice(2),
        "00000000000000000000.json",
      ),
    ];
    for (const [index, path] of managedDirectories.entries()) {
      await chmod(path, index % 2 === 0 ? 0o755 : 0o500);
    }
    for (const [index, path] of managedFiles.entries()) {
      await chmod(path, index % 2 === 0 ? 0o644 : 0o400);
    }

    await expect(store.load(created.bundleKey)).resolves.toEqual(created);
    for (const path of managedDirectories) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    for (const path of managedFiles) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("removes special permission bits from managed directories and files", async ({
    skip,
  }) => {
    if (process.platform === "win32") skip();
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const markerPath = join(root, "publication-journal.json");
    await chmod(root, 0o1700);
    await chmod(markerPath, 0o1600);
    if (
      ((await lstat(root)).mode & 0o1000) === 0 ||
      ((await lstat(markerPath)).mode & 0o1000) === 0
    ) {
      skip();
    }

    await expect(store.load(created.bundleKey)).resolves.toEqual(created);
    expect((await lstat(root)).mode & 0o7777).toBe(0o700);
    expect((await lstat(markerPath)).mode & 0o7777).toBe(0o600);
  });

  test("has exactly one winner for concurrent same-revision CAS", async () => {
    const root = await temporaryRoot();
    const first = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const second = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await first.create(entry());
    const candidate = {
      ...created,
      storedRecords: [{
        reference: created.records[0]!,
        size: 1,
      }],
    };

    const results = await Promise.allSettled([
      first.compareAndSwap(created, candidate),
      second.compareAndSwap(created, candidate),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "JOURNAL_CONFLICT" },
    });
  });

  test("rejects symlink components before journal I/O", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const linked = join(root, "linked");
    await symlink(outside, linked, "dir");

    await expect(
      createFilesystemPublicationJournalStore({
        rootDir: linked,
      }),
    ).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
    expect(await readdir(outside)).toEqual([]);
  });

  test.each(["entries", "sha256", "prefix", "revision"] as const)(
    "rejects a replay-time %s ancestor symlink before traversal",
    async (level) => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      const store = await createFilesystemPublicationJournalStore({
        rootDir: root,
      });
      const journalEntry = entry();
      await store.create(journalEntry);
      const hex = journalEntry.bundleKey.slice(7);
      const algorithmDir = join(root, "entries", "sha256");
      const prefixDir = join(algorithmDir, hex.slice(0, 2));
      const revisionDir = join(prefixDir, hex.slice(2));
      const target = level === "entries"
        ? join(root, "entries")
        : level === "sha256"
        ? algorithmDir
        : level === "prefix"
        ? prefixDir
        : revisionDir;
      const outsideRevisionDir = level === "entries"
        ? join(outside, "sha256", hex.slice(0, 2), hex.slice(2))
        : level === "sha256"
        ? join(outside, hex.slice(0, 2), hex.slice(2))
        : level === "prefix"
        ? join(outside, hex.slice(2))
        : outside;
      await mkdir(outsideRevisionDir, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(outsideRevisionDir, "00000000000000000000.json"),
        await readFile(join(revisionDir, "00000000000000000000.json")),
        { mode: 0o600 },
      );
      await rm(target, { recursive: true, force: true });
      await symlink(outside, target, "dir");

      await expect(store.load(journalEntry.bundleKey)).rejects.toMatchObject({
        code: "JOURNAL_CORRUPT",
      });
    },
  );

  test("rejects a replay-time root symlink before traversal", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const journalEntry = entry();
    await rm(root, { recursive: true });
    await symlink(outside, root, "dir");

    await expect(store.load(journalEntry.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
  });

  test("rejects a final revision symlink before reading bytes", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const hex = created.bundleKey.slice(7);
    const revisionPath = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
      "00000000000000000000.json",
    );
    const outsideFile = join(outside, "revision.json");
    await writeFile(outsideFile, await readFile(revisionPath), { mode: 0o600 });
    await rm(revisionPath);
    await symlink(outsideFile, revisionPath, "file");

    await expect(store.load(created.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
  });

  test("durably recovers a complete crash-before-link revision zero temp", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const journalEntry = entry();
    const expected = { ...journalEntry, revision: 0 } as const;
    const hex = journalEntry.bundleKey.slice(7);
    const revisionDir = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    await mkdir(revisionDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(
        revisionDir,
        ".tmp-11111111-1111-4111-8111-111111111111.json",
      ),
      encodeVersionedPublicationJournalEntry(expected),
      { mode: 0o600 },
    );

    await expect(store.load(journalEntry.bundleKey)).resolves.toEqual(
      expected,
    );
    expect(await readdir(revisionDir)).toEqual([
      "00000000000000000000.json",
    ]);
    await expect(store.load(journalEntry.bundleKey)).resolves.toEqual(
      expected,
    );
  });

  test("durably recovers a complete crash-before-link later revision temp", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const expected = {
      ...created,
      revision: 1,
      storedRecords: [{
        reference: created.records[0]!,
        size: 1,
      }],
    } as const;
    const hex = created.bundleKey.slice(7);
    const revisionDir = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    await writeFile(
      join(
        revisionDir,
        ".tmp-11111111-1111-4111-8111-111111111111.json",
      ),
      encodeVersionedPublicationJournalEntry(expected),
      { mode: 0o600 },
    );

    await expect(store.load(created.bundleKey)).resolves.toEqual(expected);
    expect(await readdir(revisionDir)).toEqual([
      "00000000000000000000.json",
      "00000000000000000001.json",
    ]);
    await expect(store.load(created.bundleKey)).resolves.toEqual(expected);
  });

  test("repairs one recognized temp/final hard-link pair during replay", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const hex = created.bundleKey.slice(7);
    const revisionDir = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    const finalPath = join(revisionDir, "00000000000000000000.json");
    const temporaryPath = join(
      revisionDir,
      ".tmp-11111111-1111-4111-8111-111111111111.json",
    );
    await link(finalPath, temporaryPath);
    expect((await lstat(finalPath)).nlink).toBe(2);

    await expect(store.load(created.bundleKey)).resolves.toEqual(created);
    expect(await readdir(revisionDir)).toEqual([
      "00000000000000000000.json",
    ]);
    expect((await lstat(finalPath)).nlink).toBe(1);
  });

  test("rejects a hard-linked final revision before changing the outside inode", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const hex = created.bundleKey.slice(7);
    const finalPath = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
      "00000000000000000000.json",
    );
    const outsidePath = join(outside, "outside-revision.json");
    await link(finalPath, outsidePath);
    await chmod(outsidePath, 0o644);
    const beforeBytes = await readFile(outsidePath);

    await expect(store.load(created.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });

    expect((await lstat(outsidePath)).mode & 0o7777).toBe(0o644);
    expect(await readFile(outsidePath)).toEqual(beforeBytes);
  });

  test.each(["active", "temporary"] as const)(
    "rejects a hard-linked recognized %s file before changing the outside inode",
    async (kind) => {
      if (process.platform === "win32") return;
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      const store = await createFilesystemPublicationJournalStore({
        rootDir: root,
      });
      const created = await store.create(entry());
      const hex = created.bundleKey.slice(7);
      const revisionDir = join(
        root,
        "entries",
        "sha256",
        hex.slice(0, 2),
        hex.slice(2),
      );
      const outsidePath = join(outside, `outside-${kind}.json`);
      const managedName = kind === "active"
        ? ".writing-11111111-1111-4111-8111-111111111111.json"
        : ".tmp-11111111-1111-4111-8111-111111111111.json";
      await writeFile(outsidePath, Uint8Array.of(9, 8, 7), {
        mode: 0o644,
      });
      await link(outsidePath, join(revisionDir, managedName));
      const beforeBytes = await readFile(outsidePath);

      await expect(store.load(created.bundleKey)).rejects.toMatchObject({
        code: "JOURNAL_CORRUPT",
      });

      expect((await lstat(outsidePath)).mode & 0o7777).toBe(0o644);
      expect(await readFile(outsidePath)).toEqual(beforeBytes);
    },
  );

  test("replays a final revision after cancellation interrupts temp-link repair", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const hex = created.bundleKey.slice(7);
    const revisionDir = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    const finalPath = join(revisionDir, "00000000000000000000.json");
    const temporaryPath = join(
      revisionDir,
      ".tmp-11111111-1111-4111-8111-111111111111.json",
    );
    await link(finalPath, temporaryPath);
    let aborted = false;
    const signal = {
      get aborted(): boolean {
        aborted ||= !existsSync(temporaryPath);
        return aborted;
      },
    } as AbortSignal;

    await expect(
      store.load(created.bundleKey, { signal }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    await expect(store.load(created.bundleKey)).resolves.toEqual(created);
    expect(await readdir(revisionDir)).toEqual([
      "00000000000000000000.json",
    ]);
  });

  test("rejects malformed or excess recognized replay links", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const hex = created.bundleKey.slice(7);
    const revisionDir = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    const finalPath = join(revisionDir, "00000000000000000000.json");
    const temporaryPath = join(
      revisionDir,
      ".tmp-11111111-1111-4111-8111-111111111111.json",
    );
    await link(finalPath, temporaryPath);
    await link(
      finalPath,
      join(
        revisionDir,
        ".tmp-22222222-2222-4222-8222-222222222222.json",
      ),
    );

    await expect(store.load(created.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
  });

  test.each([
    ["active symlink", ".writing-11111111-1111-4111-8111-111111111111.json"],
    ["active nonregular", ".writing-22222222-2222-4222-8222-222222222222.json"],
    ["multi-temp symlink", ".tmp-33333333-3333-4333-8333-333333333333.json"],
    ["multi-temp nonregular", ".tmp-44444444-4444-4444-8444-444444444444.json"],
  ] as const)(
    "rejects a recognized %s managed node",
    async (kind, managedName) => {
      const root = await temporaryRoot();
      const store = await createFilesystemPublicationJournalStore({
        rootDir: root,
      });
      const created = await store.create(entry());
      const hex = created.bundleKey.slice(7);
      const revisionDir = join(
        root,
        "entries",
        "sha256",
        hex.slice(0, 2),
        hex.slice(2),
      );
      const managedPath = join(revisionDir, managedName);
      if (kind.endsWith("symlink")) {
        await symlink(
          join(revisionDir, "00000000000000000000.json"),
          managedPath,
          "file",
        );
      } else {
        await mkdir(managedPath, { mode: 0o700 });
      }
      if (kind.startsWith("multi-temp")) {
        await writeFile(
          join(
            revisionDir,
            ".tmp-55555555-5555-4555-8555-555555555555.json",
          ),
          Uint8Array.of(1),
          { mode: 0o600 },
        );
      }

      await expect(store.load(created.bundleKey)).rejects.toMatchObject({
        code: "JOURNAL_CORRUPT",
      });
    },
  );

  test("finishes cleanup and durability work before surfacing post-link cancellation", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const journalEntry = entry();
    const hex = journalEntry.bundleKey.slice(7);
    const revisionDir = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    const finalPath = join(revisionDir, "00000000000000000000.json");
    let observedTemporaryAtAbort: boolean | undefined;
    let aborted = false;
    const signal = {
      get aborted(): boolean {
        if (!aborted && existsSync(finalPath)) {
          observedTemporaryAtAbort = readdirSync(revisionDir).some((name) =>
            name.startsWith(".tmp-")
          );
          aborted = true;
        }
        return aborted;
      },
    } as AbortSignal;

    await expect(
      store.create(journalEntry, { signal }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    expect(observedTemporaryAtAbort).toBe(false);
    expect(await readdir(revisionDir)).toEqual([
      "00000000000000000000.json",
    ]);
    expect(await store.load(journalEntry.bundleKey)).toMatchObject({
      revision: 0,
    });
  });

  test("rejects revision gaps, unknown files, and changed revision bytes", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const hex = created.bundleKey.slice(7);
    const revisionDir = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    const revisionZero = join(revisionDir, "00000000000000000000.json");
    const original = await readFile(revisionZero);

    await writeFile(join(revisionDir, "00000000000000000002.json"), original);
    await expect(store.load(created.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
    await rm(join(revisionDir, "00000000000000000002.json"));

    await writeFile(join(revisionDir, "foreign"), new Uint8Array());
    await expect(store.load(created.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
    await rm(join(revisionDir, "foreign"));

    await writeFile(revisionZero, new Uint8Array([0]));
    await expect(store.load(created.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
  });

  test("rejects an already-aborted operation without publishing a revision", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      store.create(entry(), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(await store.load(entry().bundleKey)).toBeNull();
  });

  test("rejects a noncanonical root marker", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "entries"), { mode: 0o700 });
    await writeFile(
      join(root, "publication-journal.json"),
      JSON.stringify({ format: "foreign", version: 1 }),
    );

    await expect(
      createFilesystemPublicationJournalStore({ rootDir: root }),
    ).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
  });

  test.each(["root", "entries", "marker"] as const)(
    "does not treat a missing %s infrastructure component as an absent bundle",
    async (component) => {
      const root = await temporaryRoot();
      const store = await createFilesystemPublicationJournalStore({
        rootDir: root,
      });
      const target = component === "root"
        ? root
        : component === "entries"
        ? join(root, "entries")
        : join(root, "publication-journal.json");
      await rm(target, {
        recursive: component !== "marker",
        force: true,
      });

      await expect(store.load(entry().bundleKey)).rejects.toMatchObject({
        code: "JOURNAL_CORRUPT",
      });
      expect(existsSync(target)).toBe(false);
    },
  );

  test.each(["root", "entries", "marker"] as const)(
    "does not reconstruct missing %s infrastructure during create",
    async (component) => {
      const root = await temporaryRoot();
      const store = await createFilesystemPublicationJournalStore({
        rootDir: root,
      });
      const target = component === "root"
        ? root
        : component === "entries"
        ? join(root, "entries")
        : join(root, "publication-journal.json");
      await rm(target, {
        recursive: component !== "marker",
        force: true,
      });

      await expect(store.create(entry())).rejects.toMatchObject({
        code: "JOURNAL_CORRUPT",
      });
      expect(existsSync(target)).toBe(false);
    },
  );

  test("validates an oversized version marker with a bounded operation read", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    await writeFile(
      join(root, "publication-journal.json"),
      new Uint8Array(2 * 1024 * 1024),
      { mode: 0o600 },
    );

    await expect(store.load(entry().bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
  });

  test("accepts an exact-bound revision and rejects one byte beyond it", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const hex = created.bundleKey.slice(7);
    const revisionPath = join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
      "00000000000000000000.json",
    );
    const original = await readFile(revisionPath);
    const exact = new Uint8Array(
      FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES,
    );
    exact.fill(0x20);
    exact.set(original);
    await writeFile(revisionPath, exact, { mode: 0o600 });
    await expect(store.load(created.bundleKey)).resolves.toEqual(created);

    const oversized = new Uint8Array(
      FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES + 1,
    );
    oversized.fill(0x20);
    oversized.set(original);
    await writeFile(revisionPath, oversized, { mode: 0o600 });
    await expect(store.load(created.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
  });

  test("rejects post-construction replacement of a configured-root ancestor", async () => {
    const base = await temporaryRoot();
    const parent = join(base, "parent");
    const displacedParent = join(base, "parent-original");
    const root = join(parent, "journal");
    await mkdir(parent, { mode: 0o700 });
    const store = await createFilesystemPublicationJournalStore({ rootDir: root });
    const created = await store.create(entry());
    await rename(parent, displacedParent);
    await symlink(displacedParent, parent, "dir");

    await expect(store.load(created.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
  });

  test("rejects an oversized caller revision before base64 allocation", async () => {
    const root = await temporaryRoot();
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const created = await store.create(entry());
    const stored = await store.compareAndSwap(created, {
      ...created,
      storedRecords: [{
        reference: created.records[0]!,
        size: 1,
      }],
    });
    const frameBytes = new Uint8Array(
      FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES + 1,
    );
    const oversized: PublicationJournalEntry = {
      ...stored,
      preparedPartitions: [{
        ordinal: 0,
        prepared: {
          medium: "https://publication.test/medium",
          profile: "https://publication.test/profile/v1",
          members: [{ reference: stored.records[0]! }],
          frameBytes,
          frameDigest: hashExactBytes(frameBytes),
          frameSize: frameBytes.byteLength,
        },
        placement: { status: "unplaced" },
      }],
    };
    const bufferFrom = vi.spyOn(Buffer, "from");
    try {
      await expect(
        store.compareAndSwap(stored, oversized),
      ).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
      expect(
        bufferFrom.mock.calls.some(([value]) => value === frameBytes),
      ).toBe(false);
    } finally {
      bufferFrom.mockRestore();
    }
    expect(await store.load(created.bundleKey)).toEqual(stored);
  });

  test("accepts a caller revision at the exact filesystem write bound", async () => {
    const root = await temporaryRoot();
    const base = entry();
    const baseBytes = encodeVersionedPublicationJournalEntry({
      ...base,
      revision: 0,
    });
    const destination =
      `${base.destination}${"x".repeat(
        FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES -
          baseBytes.byteLength,
      )}`;
    const exact: PublicationJournalEntry = {
      ...base,
      ...derivePublicationIdentities(base.records, base.artifacts, destination),
      destination,
    };
    expect(
      encodeVersionedPublicationJournalEntry({
        ...exact,
        revision: 0,
      }).byteLength,
    ).toBe(FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES);

    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    await expect(store.create(exact)).resolves.toMatchObject({
      revision: 0,
    });
  });
});
