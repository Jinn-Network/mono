// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig, type RuntimeConfig } from "../config.js";
import type { RelevanceIndex } from "../relevance/index.js";
import type { TraceSpanSource } from "../relevance/index.js";
import type { CorpusFilesystem } from "./fs.js";
import type { CorpusMirror, MirrorSourceSyncReport, MirrorSyncOutcome } from "./mirror.js";
import type { CorpusReader, MirrorSourceStatus } from "./read.js";
import type { CorpusRetrieval } from "./retrieve.js";
import { createCorpusSyncCapability } from "./sync-loop.js";
import {
  MIRROR_SYNC_STATUS_FILENAME,
  MIRROR_SYNC_STATUS_FORMAT,
  createFileMirrorSyncStatusStore,
  type MirrorSyncStatusRecord,
} from "./sync-status.js";

const HOME = "/home/agent/.jinn-plugin";
const STATUS_PATH = `${HOME}/${MIRROR_SYNC_STATUS_FILENAME}`;
const INTERVAL = 60_000;
const TIMEOUT = 10_000;
const THRESHOLD = Math.max(2 * INTERVAL, INTERVAL + TIMEOUT);

const ALICE = { agent: "https://agents.test/alice", name: "attempts" };
const BOB = { agent: "https://agents.test/bob", name: "attempts" };
const key = (source: { agent: string; name: string }) => `${source.agent}/${source.name}`;

const START = new Date("2026-09-01T00:00:00.000Z");

function memoryFilesystem(): CorpusFilesystem & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  const enoent = (path: string) =>
    Object.assign(new Error(`ENOENT: no such file, ${path}`), { code: "ENOENT" });
  return {
    files,
    async mkdir() {
      return undefined;
    },
    async readFile(path: string) {
      const value = files.get(path);
      if (value === undefined) throw enoent(path);
      return value;
    },
    async open(path: string) {
      if (files.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      let buffered = "";
      return {
        async writeFile(data: string) {
          buffered = data;
        },
        async sync() {},
        async close() {
          files.set(path, buffered);
        },
      };
    },
    async rename(from: string, to: string) {
      const value = files.get(from);
      if (value === undefined) throw enoent(from);
      files.delete(from);
      files.set(to, value);
    },
    async unlink(path: string) {
      files.delete(path);
    },
    async lstat(path: string) {
      if (!files.has(path)) throw enoent(path);
      return {};
    },
    constants: { O_CREAT: 0, O_EXCL: 0, O_RDWR: 0 },
  };
}

type LogFn = (message: string, fields?: Readonly<Record<string, unknown>>) => void;

function loggerDouble() {
  return { debug: vi.fn<LogFn>(), info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

function indexDouble(): RelevanceIndex & { closed: number } {
  return {
    closed: 0,
    databasePath: `${HOME}/index.sqlite`,
    put: vi.fn(),
    remove: vi.fn(),
    has: () => false,
    stats: () => ({ local: 0, public: 0, excludedByTrust: 0 }),
    recordTrustExclusions: vi.fn(),
    search: async () => [],
    close(this: { closed: number }) {
      this.closed += 1;
    },
  } as unknown as RelevanceIndex & { closed: number };
}

const report = (
  source: { agent: string; name: string },
  over: Partial<MirrorSourceSyncReport> = {},
): MirrorSourceSyncReport => ({
  source,
  status: "synced",
  entriesWalked: 0,
  indexed: 0,
  rejected: 0,
  withdrawn: 0,
  excluded: 0,
  ...over,
});

interface Harness {
  readonly capability: ReturnType<typeof createCorpusSyncCapability>;
  readonly start: () => Promise<void>;
  readonly signals: AbortSignal[];
  readonly syncCalls: () => number;
  readonly listCalls: () => number;
  readonly index: RelevanceIndex & { closed: number };
  readonly fs: ReturnType<typeof memoryFilesystem>;
  readonly log: ReturnType<typeof loggerDouble>;
  readonly setNow: (value: Date) => void;
  readonly setSources: (value: readonly MirrorSourceStatus[]) => void;
  readonly config: RuntimeConfig;
}

function harness(options: {
  readonly outcomes?: readonly (MirrorSyncOutcome | "slow")[];
  readonly sources?: readonly Record<string, unknown>[];
  readonly seed?: MirrorSyncStatusRecord;
  readonly listRecordsThrows?: boolean;
  readonly timeoutMs?: number;
} = {}): Harness {
  const fs = memoryFilesystem();
  const index = indexDouble();
  const log = loggerDouble();
  const signals: AbortSignal[] = [];
  const queue = [...(options.outcomes ?? [{ status: "synced", sources: [] } as MirrorSyncOutcome])];
  let syncCalls = 0;
  let listCalls = 0;
  let now = START;
  let sourceStatuses: readonly MirrorSourceStatus[] = [];

  const mirror: CorpusMirror = {
    async syncOnce(operation) {
      syncCalls += 1;
      if (operation?.signal !== undefined) signals.push(operation.signal);
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      // A real `syncOnce` never throws and always honors the signal, so the
      // slow double resolves on abort rather than hanging forever — otherwise
      // this double, not the code under test, would be what `stop` waits on.
      if (next === "slow") {
        return new Promise<MirrorSyncOutcome>((resolve) => {
          operation!.signal!.addEventListener("abort", () =>
            resolve({ status: "failed", sources: [] }),
          );
        });
      }
      return next;
    },
  };

  const reader: CorpusReader = {
    async listRecords() {
      listCalls += 1;
      if (options.listRecordsThrows === true) throw new Error("the index pass exploded");
      return { items: [], excludedByTrust: 0 };
    },
    async getRecord() {
      return null;
    },
    async describeSources() {
      return sourceStatuses;
    },
  };

  const retrieval: CorpusRetrieval = {
    fetchRecord: async () => {
      throw new Error("unreachable: no candidate is ever returned");
    },
  };

  const config = resolveRuntimeConfig({
    env: {},
    homeDirectory: HOME,
    file: {
      corpus: {
        syncIntervalMs: INTERVAL,
        syncTimeoutMs: options.timeoutMs ?? TIMEOUT,
        ...(options.sources === undefined ? {} : { sources: options.sources }),
      },
    },
  });

  if (options.seed !== undefined) {
    fs.files.set(STATUS_PATH, `${JSON.stringify(options.seed, null, 2)}\n`);
  }

  const capability = createCorpusSyncCapability({
    mirror: () => mirror,
    reader: () => reader,
    retrieval: () => retrieval,
    fs,
    openIndex: async () => index,
    spanSource: { spansFor: () => [] } as TraceSpanSource,
    openLocalRuntime: async () => {
      throw new Error("unreachable: the local plane is never opened by the public pass");
    },
    now: () => now,
  });

  return {
    capability,
    start: () => capability.start!({ config, log }),
    signals,
    syncCalls: () => syncCalls,
    listCalls: () => listCalls,
    index,
    fs,
    log,
    setNow: (value) => {
      now = value;
    },
    setSources: (value) => {
      sourceStatuses = value;
    },
    config,
  };
}

/** Drains the cycle in flight without advancing the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

async function statusOf(built: Harness): Promise<MirrorSyncStatusRecord | undefined> {
  return createFileMirrorSyncStatusStore({
    filePath: STATUS_PATH,
    fs: built.fs,
    log: built.log,
  }).read();
}

const cycleLines = (built: Harness) =>
  built.log.info.mock.calls.filter(([message]) => message === "corpus.mirror.cycle");

const source = (agent: string) => ({
  agent,
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: `archive.test/${agent.slice(agent.lastIndexOf("/") + 1)}`,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the corpus-sync capability", () => {
  test("is named corpus-sync", () => {
    expect(harness().capability.name).toBe("corpus-sync");
  });

  test("start returns before the first cycle settles", async () => {
    const built = harness({ outcomes: ["slow"] });
    await built.start();
    expect(built.syncCalls()).toBe(1);
    await built.capability.stop!();
  });

  test("reschedules one interval after the cycle it just finished", async () => {
    const built = harness();
    await built.start();
    expect(built.syncCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(built.syncCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(built.syncCalls()).toBe(2);

    await built.capability.stop!();
  });

  test("a slow cycle never overlaps the next one", async () => {
    const built = harness({ outcomes: ["slow"], timeoutMs: 600_000 });
    await built.start();
    await vi.advanceTimersByTimeAsync(2 * INTERVAL + 1);
    expect(built.syncCalls()).toBe(1);
    await built.capability.stop!();
  });

  test("stop aborts the in-flight cycle, clears the timer and closes the index", async () => {
    const built = harness({ outcomes: ["slow"] });
    await built.start();
    expect(built.signals[0]!.aborted).toBe(false);

    await built.capability.stop!();

    expect(built.signals[0]!.aborted).toBe(true);
    expect(built.index.closed).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(built.syncCalls()).toBe(1);
  });

  test("a cycle that outruns corpus.syncTimeoutMs is aborted and the loop proceeds", async () => {
    const built = harness({ outcomes: ["slow"] });
    await built.start();
    expect(built.signals[0]!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(built.signals[0]!.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(built.syncCalls()).toBe(2);
    await built.capability.stop!();
  });

  test("a synced cycle records success per source and runs the public-plane index pass", async () => {
    const built = harness({
      outcomes: [{ status: "synced", sources: [report(ALICE, { indexed: 2 })] }],
    });
    await built.start();
    await settle();

    expect(built.listCalls()).toBe(1);
    expect(await statusOf(built)).toEqual({
      format: MIRROR_SYNC_STATUS_FORMAT,
      lastCycle: { completedAt: START.toISOString(), status: "synced" },
      sources: { [key(ALICE)]: { lastSyncedAt: START.toISOString() } },
    });
    await built.capability.stop!();
  });

  test("a partial cycle records only the synced reports, keeps the failures, and still indexes", async () => {
    const built = harness({
      outcomes: [
        {
          status: "partial",
          sources: [
            report(ALICE, { indexed: 1 }),
            report(BOB, {
              status: "failed",
              failure: { code: "TRANSPORT", message: "unreachable" },
            }),
          ],
        },
      ],
    });
    await built.start();
    await settle();

    expect(built.listCalls()).toBe(1);
    expect(await statusOf(built)).toEqual({
      format: MIRROR_SYNC_STATUS_FORMAT,
      lastCycle: { completedAt: START.toISOString(), status: "partial" },
      sources: {
        [key(ALICE)]: { lastSyncedAt: START.toISOString() },
        [key(BOB)]: {
          lastFailure: {
            code: "TRANSPORT",
            message: "unreachable",
            at: START.toISOString(),
          },
        },
      },
    });
    await built.capability.stop!();
  });

  test("a failed cycle records the failure, does not index, and the loop continues", async () => {
    const built = harness({
      outcomes: [
        {
          status: "failed",
          sources: [
            report(ALICE, { status: "failed", failure: { code: "LOCK_IO", message: "denied" } }),
          ],
        },
        { status: "synced", sources: [] },
      ],
    });
    await built.start();
    await settle();

    expect(built.listCalls()).toBe(0);
    expect((await statusOf(built))?.sources[key(ALICE)]).toEqual({
      lastFailure: { code: "LOCK_IO", message: "denied", at: START.toISOString() },
    });

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(built.syncCalls()).toBe(2);
    await built.capability.stop!();
  });

  test("a skipped-locked cycle is neither success nor fault, logs at debug, and does not index", async () => {
    const built = harness({
      outcomes: [{ status: "skipped-locked", sources: [] }],
      seed: {
        format: MIRROR_SYNC_STATUS_FORMAT,
        sources: { [key(ALICE)]: { lastSyncedAt: "2026-08-31T00:00:00.000Z" } },
      },
    });
    await built.start();
    await settle();

    expect(built.listCalls()).toBe(0);
    expect((await statusOf(built))?.sources).toEqual({
      [key(ALICE)]: { lastSyncedAt: "2026-08-31T00:00:00.000Z" },
    });
    expect(built.log.debug.mock.calls.some(([message]) => message === "corpus.mirror.skipped")).toBe(
      true,
    );
    await built.capability.stop!();
  });

  test("the first cycle always indexes; later cycles index only when something was indexed", async () => {
    const built = harness({
      outcomes: [
        { status: "synced", sources: [report(ALICE)] },
        { status: "synced", sources: [report(ALICE)] },
        { status: "synced", sources: [report(ALICE, { indexed: 1 })] },
      ],
    });
    await built.start();
    await settle();
    expect(built.listCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(built.listCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(built.listCalls()).toBe(2);
    await built.capability.stop!();
  });

  test("a throwing index pass is caught and the next cycle still runs", async () => {
    const built = harness({
      outcomes: [{ status: "synced", sources: [report(ALICE, { indexed: 1 })] }],
      listRecordsThrows: true,
    });
    await built.start();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(built.syncCalls()).toBe(2);
    expect(await statusOf(built)).toBeDefined();
    await built.capability.stop!();
  });

  test("every cycle writes the status file and start seeds from an existing one", async () => {
    const built = harness({
      outcomes: [{ status: "synced", sources: [report(BOB)] }],
      seed: {
        format: MIRROR_SYNC_STATUS_FORMAT,
        lastCycle: { completedAt: "2026-08-31T00:00:00.000Z", status: "synced" },
        sources: { [key(ALICE)]: { lastSyncedAt: "2026-08-31T00:00:00.000Z" } },
      },
    });
    await built.start();
    await settle();

    expect(await statusOf(built)).toEqual({
      format: MIRROR_SYNC_STATUS_FORMAT,
      lastCycle: { completedAt: START.toISOString(), status: "synced" },
      sources: {
        [key(ALICE)]: { lastSyncedAt: "2026-08-31T00:00:00.000Z" },
        [key(BOB)]: { lastSyncedAt: START.toISOString() },
      },
    });
    await built.capability.stop!();
  });

  test("emits exactly one corpus.mirror.cycle line per cycle", async () => {
    const built = harness();
    await built.start();
    await settle();
    expect(cycleLines(built)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(cycleLines(built)).toHaveLength(2);
    await built.capability.stop!();
  });
});

describe("corpus-mirror-freshness", () => {
  async function rowOf(built: Harness) {
    const checks = await built.capability.healthChecks!();
    expect(checks).toHaveLength(1);
    return checks[0]!;
  }

  test("is green when no archives are followed", async () => {
    const built = harness();
    await built.start();
    expect(await rowOf(built)).toMatchObject({
      name: "corpus-mirror-freshness",
      ok: true,
      remedy: null,
    });
    await built.capability.stop!();
  });

  test("is green before the first cycle has completed", async () => {
    const built = harness({ outcomes: ["slow"], sources: [source(ALICE.agent)] });
    await built.start();
    expect(await rowOf(built)).toMatchObject({ ok: true, remedy: null });
    await built.capability.stop!();
  });

  test("is green while every followed source is fresh", async () => {
    const built = harness({
      outcomes: ["slow"],
      sources: [source(ALICE.agent)],
      seed: {
        format: MIRROR_SYNC_STATUS_FORMAT,
        lastCycle: { completedAt: START.toISOString(), status: "synced" },
        sources: { [key(ALICE)]: { lastSyncedAt: START.toISOString() } },
      },
    });
    await built.start();
    expect(await rowOf(built)).toMatchObject({ ok: true, remedy: null });
    await built.capability.stop!();
  });

  test("is fresh exactly at the threshold and stale one millisecond past it", async () => {
    const built = harness({
      outcomes: ["slow"],
      sources: [source(ALICE.agent)],
      seed: {
        format: MIRROR_SYNC_STATUS_FORMAT,
        lastCycle: { completedAt: START.toISOString(), status: "synced" },
        sources: { [key(ALICE)]: { lastSyncedAt: START.toISOString() } },
      },
    });
    await built.start();

    built.setNow(new Date(START.getTime() + THRESHOLD));
    expect((await rowOf(built)).ok).toBe(true);

    built.setNow(new Date(START.getTime() + THRESHOLD + 1));
    expect((await rowOf(built)).ok).toBe(false);
    await built.capability.stop!();
  });

  test("names a stale source, its age and its last failure, and points at corpus-chain-verification", async () => {
    const built = harness({
      outcomes: ["slow"],
      sources: [source(ALICE.agent)],
      seed: {
        format: MIRROR_SYNC_STATUS_FORMAT,
        lastCycle: { completedAt: START.toISOString(), status: "partial" },
        sources: {
          [key(ALICE)]: {
            lastSyncedAt: START.toISOString(),
            lastFailure: { code: "CHAIN_REJECTED", message: "head signature", at: START.toISOString() },
          },
        },
      },
    });
    await built.start();
    built.setNow(new Date(START.getTime() + THRESHOLD + 60_000));

    const row = await rowOf(built);
    expect(row.ok).toBe(false);
    expect(row.detail).toContain(key(ALICE));
    expect(row.detail).toContain("CHAIN_REJECTED");
    expect(row.detail).toContain("head signature");
    expect(row.detail).toMatch(/\bago\b/u);
    expect(row.remedy).toContain("corpus-chain-verification");
    await built.capability.stop!();
  });

  test("is red on a failed last cycle, naming the failure and the cycle log line", async () => {
    const built = harness({
      outcomes: ["slow"],
      sources: [source(ALICE.agent)],
      seed: {
        format: MIRROR_SYNC_STATUS_FORMAT,
        lastCycle: { completedAt: START.toISOString(), status: "failed" },
        sources: {
          [key(ALICE)]: {
            lastFailure: { code: "LOCK_IO", message: "denied", at: START.toISOString() },
          },
        },
      },
    });
    await built.start();

    const row = await rowOf(built);
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("LOCK_IO");
    expect(row.detail).toContain("denied");
    expect(row.remedy).toContain("corpus.mirror.cycle");
    await built.capability.stop!();
  });

  test("names the mirror lock when staleness accumulated under skipped-locked cycles", async () => {
    const built = harness({
      outcomes: ["slow"],
      sources: [source(ALICE.agent)],
      seed: {
        format: MIRROR_SYNC_STATUS_FORMAT,
        lastCycle: { completedAt: START.toISOString(), status: "skipped-locked" },
        sources: { [key(ALICE)]: { lastSyncedAt: START.toISOString() } },
      },
    });
    await built.start();
    built.setNow(new Date(START.getTime() + THRESHOLD + 1));

    const row = await rowOf(built);
    expect(row.ok).toBe(false);
    expect(row.remedy).toContain(built.config.mirrorLockPath);
    expect(row.remedy).toMatch(/stale lock/u);
    await built.capability.stop!();
  });

  test("reports head age in the detail but never lets it gate ok", async () => {
    const built = harness({
      outcomes: ["slow"],
      sources: [source(ALICE.agent)],
      seed: {
        format: MIRROR_SYNC_STATUS_FORMAT,
        lastCycle: { completedAt: START.toISOString(), status: "synced" },
        sources: { [key(ALICE)]: { lastSyncedAt: START.toISOString() } },
      },
    });
    built.setSources([
      {
        source: ALICE,
        servingRoot: "https://archive.test",
        repositoryId: "archive.test/alice",
        highWaterMark: {
          sequence: "0000000000000001",
          entry: `sha256:${"a".repeat(64)}`,
          issuedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    await built.start();

    const row = await rowOf(built);
    expect(row.ok).toBe(true);
    expect(row.detail).toContain("head");
    await built.capability.stop!();
  });
});
