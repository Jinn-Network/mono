// SPDX-License-Identifier: Apache-2.0
import { recordDigest } from "@jinn-network/evidence-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { createCorpusCapability } from "./capability.js";
import { createNodeCorpusFilesystem } from "./node-fs.test.js";
import { buildFixtureArchive, fixtureTrustDsseVerifier } from "./testing-fixture.js";

const corpusFs = createNodeCorpusFilesystem();

let home: string;

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
};

function log() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-e2e-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("corpus end to end", () => {
  test("follow → sync → filter → read → fetch, with an admitted producer", async () => {
    const archive = buildFixtureArchive(source, ["https://agents.test/alice"]);

    const capability = createCorpusCapability({
      transport: archive.transport,
      fs: corpusFs,
      dsseVerifier: fixtureTrustDsseVerifier,
      readPolicyVersions: async () => archive.policyVersions,
      now: () => new Date("2026-07-30T00:00:00Z"),
    });

    const config = resolveRuntimeConfig({
      env: {},
      homeDirectory: home,
      file: {
        corpus: {
          sources: [source],
          acknowledgeUnverifiedChain: true,
          trust: { genesisDigest: archive.genesisDigest, policyDirectory: "policy" },
        },
      },
    });

    await capability.start!({ config, log: log() });

    // 1. Sync.
    const outcome = await capability.mirror.syncOnce();
    expect(outcome.status).toBe("synced");
    expect(outcome.sources[0]!.indexed).toBeGreaterThan(0);

    // 2. Read — trust filtering has already run.
    const page = await capability.reader.listRecords({ limit: 10 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.plane === "public")).toBe(true);

    // 3. Fetch exact bytes.
    const fetched = await capability.retrieval.fetchRecord(page.items[0]!.reference);
    expect(fetched.status).toBe("fetched");
    if (fetched.status !== "fetched") throw new Error("unreachable");
    expect(recordDigest(fetched.result.canonicalBytes)).toBe(page.items[0]!.reference.digest);

    // 4. Offline: the mirror still serves after the archive goes away.
    const offline = createCorpusCapability({
      transport: {
        async fetch() {
          throw new Error("archive unreachable");
        },
      },
      fs: corpusFs,
      dsseVerifier: fixtureTrustDsseVerifier,
      readPolicyVersions: async () => archive.policyVersions,
      now: () => new Date("2026-07-30T00:00:00Z"),
    });
    await offline.start!({ config, log: log() });
    expect((await offline.reader.listRecords({ limit: 10 })).items.length).toBeGreaterThan(0);
    expect((await offline.mirror.syncOnce()).status).toBe("failed");
  });

  test("FAIL-CLOSED: an unadmitted producer is mirrored but never read or fetched", async () => {
    const archive = buildFixtureArchive(source, []); // policy lists nobody

    const capability = createCorpusCapability({
      transport: archive.transport,
      fs: corpusFs,
      dsseVerifier: fixtureTrustDsseVerifier,
      readPolicyVersions: async () => archive.policyVersions,
      now: () => new Date("2026-07-30T00:00:00Z"),
    });
    const config = resolveRuntimeConfig({
      env: {},
      homeDirectory: home,
      file: {
        corpus: {
          sources: [source],
          acknowledgeUnverifiedChain: true,
          trust: { genesisDigest: archive.genesisDigest, policyDirectory: "policy" },
        },
      },
    });
    await capability.start!({ config, log: log() });

    expect((await capability.mirror.syncOnce()).sources[0]!.indexed).toBeGreaterThan(0);

    const page = await capability.reader.listRecords({ limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.excludedByTrust).toBeGreaterThan(0);

    const fetched = await capability.retrieval.fetchRecord(archive.reference);
    expect(fetched.status).toBe("failed");
  });

  test("FAIL-OPEN on absence: an empty corpus reads empty and work proceeds", async () => {
    const capability = createCorpusCapability({
      transport: { async fetch() { return { status: 404, bytes: new Uint8Array() }; } },
      fs: corpusFs,
      dsseVerifier: () => ({ validSignerKeyids: [] }),
      readPolicyVersions: async () => [],
    });
    const config = resolveRuntimeConfig({ env: {}, homeDirectory: home });
    await capability.start!({ config, log: log() });

    const page = await capability.reader.listRecords();
    expect(page).toEqual({ items: [], excludedByTrust: 0 });
    // No throw: absence of results is not an error.
  });

  test("CONCURRENCY: two runtimes, one syncs and one skips; both read", async () => {
    const archive = buildFixtureArchive(source, ["https://agents.test/alice"]);
    const config = resolveRuntimeConfig({
      env: {},
      homeDirectory: home,
      file: {
        corpus: {
          sources: [source],
          acknowledgeUnverifiedChain: true,
          trust: { genesisDigest: archive.genesisDigest, policyDirectory: "policy" },
        },
      },
    });

    const build = () =>
      createCorpusCapability({
        transport: archive.slowTransport,
        fs: corpusFs,
        dsseVerifier: fixtureTrustDsseVerifier,
        readPolicyVersions: async () => archive.policyVersions,
        now: () => new Date("2026-07-30T00:00:00Z"),
      });

    const first = build();
    const second = build();
    await first.start!({ config, log: log() });
    await second.start!({ config, log: log() });

    const [a, b] = await Promise.all([first.mirror.syncOnce(), second.mirror.syncOnce()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["skipped-locked", "synced"]);

    // Both readers serve the mirror regardless of who won the lock.
    expect((await first.reader.listRecords()).items.length).toBeGreaterThan(0);
    expect((await second.reader.listRecords()).items.length).toBeGreaterThan(0);
  });
});
