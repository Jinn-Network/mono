// SPDX-License-Identifier: Apache-2.0
import { recordDigest } from "@jinn-network/evidence-protocol";
import {
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  archivePagePath,
  headPath,
  sealJson,
} from "@jinn-network/record-discovery-protocol";
import type { Transport, TransportResponse, VerifyDriver } from "@jinn-network/record-discovery-client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createFollowedSourceAdmission } from "./admission.js";
import {
  UNVERIFIED_CHAIN_ACKNOWLEDGEMENT,
  createDriverChainVerification,
  createRejectingChainVerification,
  createUnverifiedChainVerification,
} from "./chain-verification.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import { tryAcquireSyncLock } from "./lock.js";
import { createCorpusMirror } from "./mirror.js";
import { createNodeCorpusFilesystem } from "./node-fs.test.js";
import { withCorpusMirrorStore } from "./store.js";
import type { CorpusFilesystem } from "./fs.js";

const corpusFs = createNodeCorpusFilesystem();

// A minimal, well-formed execution-evidence record is loaded from the fixture
// built in Task 14; this suite only needs bytes whose digest is stable and a
// projection outcome, so it uses the shared fixture loader.
import { executionEvidenceFixture } from "./testing-fixture.js";

const AGENT = "https://agents.test/alice";
const NAME = "attempts";

const source = {
  agent: AGENT,
  name: NAME,
  servingRoot: "https://archive.test",
  archiveRootUrl: `https://archive.test${archivePagePath(NAME, "0000000000000001")}`,
  repositoryId: "archive.test/attempts",
  signingKeys: [],
};

let directory: string;
let paths: { catalogPath: string; objectsDirectory: string; fs: CorpusFilesystem };
let lockPath: string;
let statePath: string;

function buildArchive(
  recordBytes: Uint8Array,
  headOverrides: Partial<{ origin: string; sequence: string; entry: string; issuedAt: string; refreshBy: string }> = {},
): { transport: Transport; entryDigest: string } {
  const digest = recordDigest(recordBytes);
  const entry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: AGENT, name: NAME },
    sequence: "0000000000000001",
    previous: null,
    timestamp: "2026-07-30T00:00:00Z",
    announcements: [
      {
        announcementId: "ann-1",
        action: "available",
        record: { kind: RECORD_KINDS.executionEvidence, digest },
      },
    ],
  };
  const entryDigest = sealJson(entry).digest;
  const head = {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: `${AGENT}/${NAME}`,
    sequence: "0000000000000001",
    entry: entryDigest,
    issuedAt: "2026-07-30T00:00:00Z",
    refreshBy: "2026-08-30T00:00:00Z",
    ...headOverrides,
  };
  const page = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: `${AGENT}/${NAME}`,
    page: "0000000000000001",
    prevArchive: null,
    entries: [{ entry }],
  };

  const json = (value: unknown): TransportResponse => ({
    status: 200,
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  });

  return {
    entryDigest,
    transport: {
      async fetch(url: string): Promise<TransportResponse> {
        if (url === `https://archive.test${headPath(NAME)}`) return json(head);
        if (url === source.archiveRootUrl) return json(page);
        if (url === `https://archive.test/records/${digest.slice("sha256:".length)}`) {
          return { status: 200, bytes: recordBytes };
        }
        return { status: 404, bytes: new Uint8Array() };
      },
    },
  };
}

function log() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mirror(overrides: Partial<Parameters<typeof createCorpusMirror>[0]> = {}) {
  const { transport } = buildArchive(executionEvidenceFixture.bytes);
  return createCorpusMirror({
    sources: [source],
    maxEntriesPerSync: 500,
    lockPath,
    fs: corpusFs,
    storePaths: paths,
    highWaterMarks: createFileHighWaterMarkStore({ filePath: statePath, fs: corpusFs }),
    admission: createFollowedSourceAdmission([source]),
    chainVerification: createUnverifiedChainVerification(UNVERIFIED_CHAIN_ACKNOWLEDGEMENT),
    transport,
    log: log(),
    ...overrides,
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-mirror-"));
  paths = {
    catalogPath: join(directory, "mirror", "catalog.sqlite"),
    objectsDirectory: join(directory, "mirror", "objects"),
    fs: corpusFs,
  };
  lockPath = join(directory, "mirror-sync.lock");
  statePath = join(directory, "mirror-state.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("mirror sync", () => {
  test("mirrors an announced record from a fixture archive into the catalog", async () => {
    const outcome = await mirror().syncOnce();
    expect(outcome.status).toBe("synced");
    expect(outcome.sources[0]).toMatchObject({ status: "synced", entriesWalked: 1, indexed: 1 });

    await withCorpusMirrorStore(paths, async (store) => {
      const page = await store.catalog.findExecutions({ limit: 10 });
      expect(page.items).toHaveLength(1);
    });
  });

  test("mirrors the record BYTES, not just the projection", async () => {
    await mirror().syncOnce();
    await withCorpusMirrorStore(paths, async (store) => {
      const bytes = await store.repository.getRecord({
        family: "execution-evidence",
        digest: recordDigest(executionEvidenceFixture.bytes),
      });
      expect(bytes).toEqual(executionEvidenceFixture.bytes);
    });
  });

  test("advances the high-water mark to the newest walked entry", async () => {
    const store = createFileHighWaterMarkStore({ filePath: statePath, fs: corpusFs });
    await mirror({ highWaterMarks: store }).syncOnce();
    const mark = await store.get({ agent: AGENT, name: NAME });
    expect(mark?.sequence).toBe("0000000000000001");
    expect(mark?.issuedAt).toBe("2026-07-30T00:00:00Z");
  });

  test("a second pass walks nothing new", async () => {
    const marks = createFileHighWaterMarkStore({ filePath: statePath, fs: corpusFs });
    await mirror({ highWaterMarks: marks }).syncOnce();
    const second = await mirror({ highWaterMarks: marks }).syncOnce();
    expect(second.sources[0]!.entriesWalked).toBe(0);
    expect(second.status).toBe("synced");
  });

  describe("a head at the position already on file is revalidated, not re-walked (#3443, #3468)", () => {
    /**
     * A posture that records which of its two entry points the mirror chose.
     * Which path a re-served head takes is the whole subject here: the
     * revalidation path exists so a healthy mirror stops reporting
     * `broken-chain` between publishes, and the chain path has to keep every
     * head that is making a chain claim.
     */
    function spyPosture(outcomes: {
      verify?: { status: "ok" } | { status: "rejected"; reason: string };
      revalidate?: { status: "ok" } | { status: "rejected"; reason: string };
    } = {}) {
      const verify = vi.fn(async () => outcomes.verify ?? ({ status: "ok" } as const));
      const revalidateHead = vi.fn(async () => outcomes.revalidate ?? ({ status: "ok" } as const));
      return { mode: "verified" as const, verify, revalidateHead };
    }

    async function seeded() {
      const marks = createFileHighWaterMarkStore({ filePath: statePath, fs: corpusFs });
      await mirror({ highWaterMarks: marks }).syncOnce();
      return marks;
    }

    test("a re-served identical head revalidates and reports a clean, empty sync", async () => {
      const marks = await seeded();
      const posture = spyPosture();

      const second = await mirror({ highWaterMarks: marks, chainVerification: posture }).syncOnce();

      expect(posture.revalidateHead).toHaveBeenCalledTimes(1);
      expect(posture.verify).not.toHaveBeenCalled();
      expect(second.status).toBe("synced");
      expect(second.sources[0]).toMatchObject({ status: "synced", entriesWalked: 0, indexed: 0 });
      expect(second.sources[0]!.failure).toBeUndefined();
    });

    test("a refused revalidation is still a chain-verification failure", async () => {
      const marks = await seeded();
      const posture = spyPosture({ revalidate: { status: "rejected", reason: "stale" } });

      const second = await mirror({ highWaterMarks: marks, chainVerification: posture }).syncOnce();

      expect(second.status).toBe("failed");
      expect(second.sources[0]!.failure).toEqual({
        code: "chain-verification-rejected",
        message: "stale",
      });
    });

    test("revalidating an IDENTICAL head does not rewrite the mark, so the floor survives", async () => {
      const marks = await seeded();
      const before = await marks.get({ agent: AGENT, name: NAME });

      await mirror({ highWaterMarks: marks, chainVerification: spyPosture() }).syncOnce();

      expect(await marks.get({ agent: AGENT, name: NAME })).toEqual(before);
    });

    test("a head whose issuedAt REGRESSED is a chain claim and keeps the chain path", async () => {
      const marks = await seeded();
      const posture = spyPosture();
      const { transport } = buildArchive(executionEvidenceFixture.bytes, { issuedAt: "2026-07-29T00:00:00Z" });

      await mirror({ highWaterMarks: marks, chainVerification: posture, transport }).syncOnce();

      expect(posture.verify).toHaveBeenCalledTimes(1);
      expect(posture.revalidateHead).not.toHaveBeenCalled();
    });

    test("a re-signed head at the same position revalidates too, and does NOT take the chain path (#3468)", async () => {
      const marks = await seeded();
      const posture = spyPosture();
      const { transport } = buildArchive(executionEvidenceFixture.bytes, { issuedAt: "2026-07-31T00:00:00Z" });

      const outcome = await mirror({ highWaterMarks: marks, chainVerification: posture, transport }).syncOnce();

      expect(posture.revalidateHead).toHaveBeenCalledTimes(1);
      expect(posture.verify).not.toHaveBeenCalled();
      expect(outcome.sources[0]).toMatchObject({ status: "synced", entriesWalked: 0, indexed: 0 });
      expect(outcome.sources[0]!.failure).toBeUndefined();
    });

    test("a re-signed head advances the mark's instant, leaving its position alone (#3468)", async () => {
      const marks = await seeded();
      const before = await marks.get({ agent: AGENT, name: NAME });
      const { transport } = buildArchive(executionEvidenceFixture.bytes, { issuedAt: "2026-07-31T00:00:00Z" });

      await mirror({ highWaterMarks: marks, chainVerification: spyPosture(), transport }).syncOnce();

      expect(await marks.get({ agent: AGENT, name: NAME })).toEqual({
        ...before,
        issuedAt: "2026-07-31T00:00:00Z",
      });
    });

    test("a refused revalidation of a re-signed head leaves the mark exactly where it was (#3468)", async () => {
      const marks = await seeded();
      const before = await marks.get({ agent: AGENT, name: NAME });
      const posture = spyPosture({ revalidate: { status: "rejected", reason: "unauthorized-signer" } });
      const { transport } = buildArchive(executionEvidenceFixture.bytes, { issuedAt: "2026-07-31T00:00:00Z" });

      const outcome = await mirror({ highWaterMarks: marks, chainVerification: posture, transport }).syncOnce();

      expect(outcome.sources[0]!.failure).toEqual({
        code: "chain-verification-rejected",
        message: "unauthorized-signer",
      });
      // The instant advances only for an ACCEPTED re-sign. A refused one must
      // not raise the floor, or a rejected head would still move the record
      // the next verification is monotonic against.
      expect(await marks.get({ agent: AGENT, name: NAME })).toEqual(before);
    });

    test("replaying the head the re-sign replaced is then a chain claim, not a revalidation (#3468)", async () => {
      const marks = await seeded();
      const resigned = buildArchive(executionEvidenceFixture.bytes, { issuedAt: "2026-07-31T00:00:00Z" });
      await mirror({ highWaterMarks: marks, chainVerification: spyPosture(), transport: resigned.transport }).syncOnce();

      // The ORIGINAL head, re-served after the mark advanced past it: same
      // position, a now-lower `issuedAt`. The advanced floor is what makes it
      // a regression rather than the byte-identical head it once was.
      const posture = spyPosture();
      await mirror({ highWaterMarks: marks, chainVerification: posture }).syncOnce();

      expect(posture.verify).toHaveBeenCalledTimes(1);
      expect(posture.revalidateHead).not.toHaveBeenCalled();
    });

    test("a head whose issuedAt is unparseable is never revalidated (#3468)", async () => {
      const marks = await seeded();
      const posture = spyPosture();
      const { transport } = buildArchive(executionEvidenceFixture.bytes, { issuedAt: "not-a-date" });

      await mirror({ highWaterMarks: marks, chainVerification: posture, transport }).syncOnce();

      expect(posture.verify).toHaveBeenCalledTimes(1);
      expect(posture.revalidateHead).not.toHaveBeenCalled();
    });

    test("a head naming a different chain position keeps the chain path", async () => {
      const marks = await seeded();
      const posture = spyPosture();
      const { transport } = buildArchive(executionEvidenceFixture.bytes, { sequence: "0000000000000002" });

      await mirror({ highWaterMarks: marks, chainVerification: posture, transport }).syncOnce();

      expect(posture.verify).toHaveBeenCalledTimes(1);
      expect(posture.revalidateHead).not.toHaveBeenCalled();
    });

    test("a FORKED head — same sequence, a different entry, a later instant — keeps the chain path (#3468)", async () => {
      // The half of the position check `sequence` alone cannot pin: this head
      // clears the sequence comparison and the strict-increase rule, and is
      // still a chain claim because it cites an entry the mark does not name.
      const marks = await seeded();
      const posture = spyPosture();
      const { transport } = buildArchive(executionEvidenceFixture.bytes, {
        entry: "sha256:" + "ff".repeat(32),
        issuedAt: "2026-07-31T00:00:00Z",
      });

      await mirror({ highWaterMarks: marks, chainVerification: posture, transport }).syncOnce();

      expect(posture.verify).toHaveBeenCalledTimes(1);
      expect(posture.revalidateHead).not.toHaveBeenCalled();
    });

    test("a head whose origin names another source keeps the chain path", async () => {
      const marks = await seeded();
      const posture = spyPosture();
      const { transport } = buildArchive(executionEvidenceFixture.bytes, {
        origin: "https://agents.test/mallory/attempts",
      });

      await mirror({ highWaterMarks: marks, chainVerification: posture, transport }).syncOnce();

      expect(posture.verify).toHaveBeenCalledTimes(1);
      expect(posture.revalidateHead).not.toHaveBeenCalled();
    });

    test("a FIRST sync never revalidates: there is no mark to be unchanged against", async () => {
      const posture = spyPosture();
      await mirror({ chainVerification: posture }).syncOnce();

      expect(posture.verify).toHaveBeenCalledTimes(1);
      expect(posture.revalidateHead).not.toHaveBeenCalled();
    });
  });

  test("SKIPS without waiting when the lock is held, and never throws", async () => {
    const held = await tryAcquireSyncLock({ path: lockPath, fs: corpusFs });
    try {
      const started = Date.now();
      const outcome = await mirror().syncOnce();
      expect(outcome).toEqual({ status: "skipped-locked", sources: [] });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await held!.close();
    }
  });

  test("TRUST: an unverified chain posture that is not acknowledged indexes nothing", async () => {
    const outcome = await mirror({ chainVerification: createRejectingChainVerification() }).syncOnce();
    expect(outcome.status).toBe("failed");
    expect(outcome.sources[0]).toMatchObject({
      status: "failed",
      indexed: 0,
      failure: { code: "chain-verification-rejected" },
    });

    await withCorpusMirrorStore(paths, async (store) => {
      expect((await store.catalog.findExecutions({ limit: 10 })).items).toEqual([]);
    });
  });

  test("TRUST: an archive this runtime does not follow contributes nothing", async () => {
    const outcome = await mirror({ admission: createFollowedSourceAdmission([]) }).syncOnce();
    expect(outcome.sources[0]).toMatchObject({ indexed: 0, excluded: 1 });
    await withCorpusMirrorStore(paths, async (store) => {
      expect((await store.catalog.findExecutions({ limit: 10 })).items).toEqual([]);
    });
  });

  test("reports a transport failure as a value instead of throwing", async () => {
    const outcome = await mirror({
      transport: {
        async fetch(): Promise<never> {
          throw new Error("network down");
        },
      },
    }).syncOnce();
    expect(outcome.status).toBe("failed");
    expect(outcome.sources[0]!.failure?.message).toContain("network down");
  });

  test("one bad record does not wedge the rest of a source's entries", async () => {
    const { transport } = buildArchive(new TextEncoder().encode("not an evidence record"));
    const outcome = await mirror({ transport }).syncOnce();
    expect(outcome.status).toBe("synced");
    expect(outcome.sources[0]).toMatchObject({ entriesWalked: 1, indexed: 0, rejected: 1 });
  });

  test("honours the per-pass entry bound", async () => {
    const outcome = await mirror({ maxEntriesPerSync: 0 }).syncOnce();
    expect(outcome.sources[0]!.entriesWalked).toBe(0);
  });

  // #3252: the walk yields oldest-first, so the entries the bound drops are
  // the NEWEST ones -- including the one the head cites. Handing that cut
  // chain to a verifying driver gets `broken-chain` back for a chain this
  // mirror is the one that cut, and because the mark only advances on a clean
  // verification the next pass cuts it identically. The bound is a fact about
  // the walk, so it travels with the walk to whatever posture judges it.
  test("a walk cut by the per-pass bound is never handed to the verification driver", async () => {
    const verifySource = vi.fn(async () => ({ status: "broken-chain" }) as never);
    const outcome = await mirror({
      maxEntriesPerSync: 0,
      chainVerification: createDriverChainVerification({ verifySource } as unknown as VerifyDriver),
    }).syncOnce();

    expect(verifySource).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(outcome.sources[0]!.failure).toEqual({
      code: "chain-verification-rejected",
      message: "sync-truncated",
    });
  });

  // The gate is specific to truncation: an uncut walk is judged on the
  // source's own evidence, which for this fixture's bare head is its missing
  // head signature.
  test("an uncut walk is judged on the source's evidence, not refused as truncated", async () => {
    const verifySource = vi.fn(async () => ({ status: "ok" }) as never);
    const outcome = await mirror({
      chainVerification: createDriverChainVerification({ verifySource } as unknown as VerifyDriver),
    }).syncOnce();

    expect(outcome.sources[0]!.failure?.message).toBe("head-unsigned");
  });

  test("reports partial when one of two sources fails", async () => {
    const other = { ...source, name: "evaluations", repositoryId: "archive.test/evaluations" };
    const outcome = await mirror({
      sources: [source, other],
      admission: createFollowedSourceAdmission([source, other]),
    }).syncOnce();
    expect(outcome.status).toBe("partial");
    expect(outcome.sources.map((report) => report.status)).toEqual(["synced", "failed"]);
  });
});
