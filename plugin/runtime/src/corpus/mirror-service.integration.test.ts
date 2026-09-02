// SPDX-License-Identifier: Apache-2.0
/**
 * The mirror as a standing SERVICE, end to end, through the real composition
 * root — `bin.buildMirrorCapabilities` composing the real corpus capability and
 * the real sync loop into a real `PluginRuntime`, over a real SQLite relevance
 * index, a real HTTP transport, real Ed25519, and a real `VerifyDriver`. The
 * only fake is the socket: an in-memory `fetchLike` serves the archive, so the
 * suite acquires no ambient network.
 *
 * This is where #3222's acceptance criteria are proven: a fresh client answers
 * `corpus_search` over what the service mirrored, a restart resumes from the
 * high-water mark, health reports source freshness beside the live
 * verification posture, and a failing source leaves the loop alive.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { headPath } from "@jinn-network/record-discovery-protocol";
import type { FetchLike } from "@jinn-network/record-discovery-transport-http";
import type { VerifyDriver } from "@jinn-network/record-discovery-client";
import type { DsseSigner } from "@jinn-network/trust-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildMirrorCapabilities, buildServeCapabilities, type BinIo } from "../bin.js";
import { createNodeRuntimeConfigFileReader } from "../bin-node-fs.js";
import { resolveRuntimeConfig, type MirrorSourceConfig, type RuntimeConfig } from "../config.js";
import type { HealthCheck } from "../health.js";
import type { RuntimeLogger } from "../logger.js";
import { TOOL_NAMES } from "../mcp/identifiers.js";
import { createPluginRuntime, type PluginRuntime } from "../runtime.js";
import {
  createLocalCorpusPorts,
  resolveCorpusBinIoFields,
  type LocalCorpusPorts,
} from "../session-host-corpus.js";
import { didKeyFromEd25519PublicKey } from "../session-host-crypto.js";
import type { CorpusCapability } from "./capability.js";
import { buildSignedFixtureArchive, loopbackFetch } from "./testing-fixture.js";

const NOW = new Date("2026-07-30T00:00:00Z");

const source: MirrorSourceConfig = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
  signingKeys: [],
};

const SOURCE_KEY = `${source.agent}/${source.name}`;
const HEAD_URL = `${source.servingRoot}${headPath(source.name)}`;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-mirror-service-"));
  // Only the clock is faked, never the timers. The whole composition — the
  // verify driver, the mirror, the sync loop's own freshness arithmetic —
  // reads `new Date()`, and `buildMirrorCapabilities` injects no clock into
  // the loop, so this is the seam that puts every one of them at the instant
  // the fixture archive's head was signed for. The loop's reschedule stays on
  // real time, so cycles fire when a real install's would.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

/**
 * A real Ed25519 signer whose keyid is the did:key its own public half encodes.
 *
 * It stays here rather than beside `loopbackFetch` in `testing-fixture.js`:
 * that module is scanned as production source, and the custody gate's
 * key-material canary refuses a private key there. Test files are exempt.
 */
function archiveSigner(): { readonly didKey: string; readonly signer: DsseSigner } {
  const pair = generateKeyPairSync("ed25519");
  const didKey = didKeyFromEd25519PublicKey(pair.publicKey);
  return {
    didKey,
    signer: async (request) => [
      { signature: new Uint8Array(sign(null, request.preAuthEncoding, pair.privateKey)), keyid: didKey },
    ],
  };
}

/** Records every `corpus.mirror.cycle` line so a test can await the Nth cycle. */
function cycleRecorder(): {
  readonly log: RuntimeLogger;
  readonly cycles: readonly Readonly<Record<string, unknown>>[];
  waitFor(count: number): Promise<void>;
} {
  const cycles: Readonly<Record<string, unknown>>[] = [];
  let waiting: { readonly count: number; readonly resolve: () => void } | undefined;
  return {
    cycles,
    log: {
      debug: () => {},
      warn: () => {},
      error: () => {},
      info: (message, fields) => {
        if (message !== "corpus.mirror.cycle") return;
        cycles.push(fields ?? {});
        if (waiting !== undefined && cycles.length >= waiting.count) {
          const { resolve } = waiting;
          waiting = undefined;
          resolve();
        }
      },
    },
    async waitFor(count: number): Promise<void> {
      if (cycles.length >= count) return;
      await new Promise<void>((resolve) => {
        waiting = { count, resolve };
      });
    },
  };
}

async function buildArchive() {
  const { didKey, signer } = archiveSigner();
  const archive = await buildSignedFixtureArchive({
    source,
    admittedProducers: [source.agent],
    signerKeyid: didKey,
    signer,
  });
  const policyDirectory = join(home, "policy");
  await mkdir(policyDirectory, { recursive: true });
  await writeFile(join(policyDirectory, "001.dsse"), archive.policyVersions[0]!);
  return { archive, didKey };
}

function resolveConfig(options: {
  readonly didKey: string;
  readonly genesisDigest: string;
  readonly syncIntervalMs?: number;
  readonly syncTimeoutMs?: number;
}): RuntimeConfig {
  return resolveRuntimeConfig({
    env: {},
    homeDirectory: home,
    file: {
      corpus: {
        sources: [
          {
            ...source,
            signingKeys: [{ keyid: options.didKey, validFrom: "2026-01-01T00:00:00.000Z" }],
          },
        ],
        chainVerification: "verified",
        trust: { genesisDigest: options.genesisDigest, policyDirectory: "policy" },
        ...(options.syncIntervalMs === undefined ? {} : { syncIntervalMs: options.syncIntervalMs }),
        ...(options.syncTimeoutMs === undefined ? {} : { syncTimeoutMs: options.syncTimeoutMs }),
      },
    },
  });
}

/** Exactly the `BinIo` the `mirror` command hands `buildMirrorCapabilities`. */
function binIo(
  config: RuntimeConfig,
  fetchLike: FetchLike,
  overrides: Partial<LocalCorpusPorts> = {},
): BinIo {
  return {
    writeOut: () => {},
    writeErr: () => {},
    homeDirectory: home,
    untilShutdown: () => new Promise<void>(() => {}),
    ...createLocalCorpusPorts({ config, fetchLike }),
    ...overrides,
  };
}

/**
 * Counts which of the verification driver's two source-level entry points the
 * mirror reached.
 *
 * This is the discriminator between a COLD source and a RESUMED one, and there
 * is no other: a resumed source whose head sits at the position already on
 * file revalidates (`verifyHead`), a cold one walks and verifies the chain
 * (`verifySource`). Everything else a restart can be measured on is blind for
 * structural reasons — the fixture archive is a single page with
 * `prevArchive: null`, so a genesis re-walk fetches only the head and the
 * archive root, and record BYTES come from the local mirror store either way.
 */
function countingDriver(driver: VerifyDriver): {
  readonly driver: VerifyDriver;
  readonly calls: { verifySource: number; verifyHead: number };
} {
  const calls = { verifySource: 0, verifyHead: 0 };
  return {
    calls,
    driver: {
      ...driver,
      verifySource: (...args: Parameters<VerifyDriver["verifySource"]>) => {
        calls.verifySource += 1;
        return driver.verifySource(...args);
      },
      verifyHead: (...args: Parameters<VerifyDriver["verifyHead"]>) => {
        calls.verifyHead += 1;
        return driver.verifyHead(...args);
      },
    },
  };
}

/**
 * One standing mirror service, started and run through its first cycle — the
 * production composition, not a hand-built stand-in.
 */
async function startMirrorService(
  config: RuntimeConfig,
  fetchLike: FetchLike,
  overrides: Partial<LocalCorpusPorts> = {},
) {
  const recorder = cycleRecorder();
  const capabilities = buildMirrorCapabilities(binIo(config, fetchLike, overrides));
  const runtime = createPluginRuntime({ config, log: recorder.log, capabilities });
  await runtime.start();
  return {
    runtime,
    recorder,
    corpus: capabilities[0] as CorpusCapability,
    async health(name: string): Promise<HealthCheck> {
      return (await runtime.health()).checks.find((check) => check.name === name)!;
    },
  };
}

/**
 * A second, independent runtime over the SAME home, composed by the REAL
 * `bin.buildServeCapabilities("tools", …)` — the same call `main` makes on the
 * serve path, with only the MCP transport swapped for a linked in-memory pair.
 *
 * Deliberately not a hand-assembled equivalent. One of those drifted from
 * production the moment it was written: it stubbed the search-time sensitivity
 * classifier out (`{ classify: async () => ({ excluded: false }) }`) and
 * re-implemented the admission filter inline, so the test claiming a
 * production-shaped client was exercising neither gate.
 */
async function connectToolsClient(config: RuntimeConfig, fetchLike: FetchLike) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let runtime: PluginRuntime;
  const capabilities = buildServeCapabilities(
    "tools",
    { ...binIo(config, fetchLike), mcpTransport: serverTransport },
    () => runtime.health(),
  );
  runtime = createPluginRuntime({
    config,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    capabilities,
  });
  const client = new Client({ name: "mirror-service-test", version: "0.0.0" });
  await Promise.all([runtime.start(), client.connect(clientTransport)]);
  return { client, runtime };
}

/**
 * Serving-plane record reads — the fetches an import performs, and a resume
 * does not. The head and the archive page are the only other routes this
 * archive serves, so everything else is a record.
 */
function recordFetches(served: readonly string[]): number {
  return served.filter((url) => url !== HEAD_URL && url !== source.archiveRootUrl).length;
}

async function readMark(config: RuntimeConfig): Promise<unknown> {
  const state = JSON.parse(await readFile(config.mirrorStatePath, "utf8")) as {
    readonly marks: Record<string, unknown>;
  };
  return state.marks[SOURCE_KEY];
}

describe("the mirror as a standing service", () => {
  test("a fresh client answers corpus_search over the mirrored record", async () => {
    // The point of the feature. Before #3222 `indexPublicPlane` had no
    // production caller, so a perfectly synced mirror answered nothing: the
    // records were in the catalog and the relevance index was empty. The
    // service is what closes that gap, and a SECOND process reading the same
    // home is the only way to show the gap is closed durably rather than in
    // the syncing process's own memory.
    const { archive, didKey } = await buildArchive();
    const config = resolveConfig({ didKey, genesisDigest: archive.genesisDigest });
    const service = await startMirrorService(config, loopbackFetch(archive.routes));
    await service.recorder.waitFor(1);
    expect(service.recorder.cycles[0]).toMatchObject({ status: "synced", indexed: true });
    await service.runtime.stop();

    const { client, runtime } = await connectToolsClient(config, loopbackFetch(archive.routes));
    try {
      const response = (await client.callTool({
        name: TOOL_NAMES.corpusSearch,
        arguments: { query: "implement deterministic slug normalization" },
      })) as { readonly content: readonly { readonly text: string }[] };
      const answer = JSON.parse(response.content[0]!.text) as {
        readonly count: number;
        readonly candidates: readonly { readonly digest: string; readonly plane: string }[];
      };

      expect(answer.count).toBeGreaterThanOrEqual(1);
      expect(answer.candidates.map((candidate) => candidate.digest)).toContain(
        archive.reference.digest,
      );
      expect(answer.candidates.every((candidate) => candidate.plane === "public")).toBe(true);
    } finally {
      await client.close();
      await runtime.stop();
    }
  });

  test("a restart resumes from the high-water mark without re-indexing", async () => {
    const { archive, didKey } = await buildArchive();
    const config = resolveConfig({ didKey, genesisDigest: archive.genesisDigest });

    const served: string[] = [];
    const inner = loopbackFetch(archive.routes);
    const counting: FetchLike = async (url) => {
      served.push(url);
      return inner(url);
    };

    const coldSpy = countingDriver(createLocalCorpusPorts({ config }).corpusVerifyDriver);
    const first = await startMirrorService(config, counting, {
      corpusVerifyDriver: coldSpy.driver,
    });
    await first.recorder.waitFor(1);
    const recordsAfterFirst = (await first.corpus.reader.listRecords({ limit: 50 })).items.length;
    const recordFetchesAfterFirst = recordFetches(served);
    const markAfterFirst = await readMark(config);
    await first.runtime.stop();

    // The cold service walked and verified the chain, and never revalidated.
    // The contrast is the whole assertion below.
    expect(coldSpy.calls).toEqual({ verifySource: 1, verifyHead: 0 });

    // A genuinely fresh service over the same home: new capabilities, new
    // stores, new index handle. Everything it knows about where it left off
    // comes off disk.
    const resumedSpy = countingDriver(createLocalCorpusPorts({ config }).corpusVerifyDriver);
    const second = await startMirrorService(config, counting, {
      corpusVerifyDriver: resumedSpy.driver,
    });
    await second.recorder.waitFor(1);
    const recordsAfterSecond = (await second.corpus.reader.listRecords({ limit: 50 })).items.length;
    await second.runtime.stop();

    // The restarted service's OWN FIRST cycle, which is the only cycle that
    // can distinguish a resume from a re-adoption: by cycle two the service
    // has re-established the mark itself, and every later measurement is
    // identical whether or not the mark survived the restart.
    //
    // A resumed source finds its head at the position already on file and
    // REVALIDATES it; a cold one walks from genesis and verifies the chain.
    // Delete `config.mirrorStatePath` between the two services and this
    // flips to `{ verifySource: 1, verifyHead: 0 }` — which is what makes it
    // an assertion about the feature rather than about the fixture.
    expect(resumedSpy.calls).toEqual({ verifySource: 0, verifyHead: 1 });

    expect(recordsAfterSecond).toBe(recordsAfterFirst);
    expect(await readMark(config)).toEqual(markAfterFirst);
    // The head is re-read every cycle, and so is the archive page the head
    // names — that is how an unchanged head is revalidated rather than
    // remembered as accepted (#3443). RECORD bytes are what an import fetches,
    // and not one was fetched again after the restart.
    expect(served.filter((url) => url === HEAD_URL).length).toBeGreaterThanOrEqual(2);
    expect(recordFetches(served)).toBe(recordFetchesAfterFirst);
    expect(recordFetchesAfterFirst).toBe(recordsAfterFirst);
  });

  test("health reports source freshness and the live verification posture", async () => {
    const { archive, didKey } = await buildArchive();
    const config = resolveConfig({ didKey, genesisDigest: archive.genesisDigest });
    const service = await startMirrorService(config, loopbackFetch(archive.routes));
    try {
      await service.recorder.waitFor(1);

      expect(await service.health("corpus-mirror-freshness")).toMatchObject({
        ok: true,
        remedy: null,
      });
      expect(await service.health("corpus-chain-verification")).toMatchObject({
        ok: true,
        detail: "Announcement chains are verified before indexing.",
      });

      // The loop's reschedule is on the real 5-minute interval, so no second
      // cycle fires while the clock jumps and the row goes stale exactly as it
      // would on an install whose source stopped answering.
      const threshold = Math.max(
        2 * config.corpus.syncIntervalMs,
        config.corpus.syncIntervalMs + config.corpus.syncTimeoutMs,
      );
      vi.setSystemTime(new Date(NOW.getTime() + threshold + 60_000));

      const stale = await service.health("corpus-mirror-freshness");
      expect(stale.ok).toBe(false);
      expect(stale.detail).toContain(`${SOURCE_KEY} last synced`);
      expect(stale.detail).toMatch(/last synced \d+[smhd] ago/u);
      // Staleness is reported as staleness. The row does not restate the
      // verification posture; it points at the row that owns it.
      expect(stale.remedy).toContain("corpus-chain-verification");
    } finally {
      await service.runtime.stop();
    }
  });

  test("a failing source leaves the loop alive and the freshness row red with the reason", async () => {
    const { archive, didKey } = await buildArchive();
    // The floor the config schema allows, so a second cycle lands inside the
    // test rather than five minutes after it.
    const config = resolveConfig({
      didKey,
      genesisDigest: archive.genesisDigest,
      syncIntervalMs: 1_000,
    });

    const inner = loopbackFetch(archive.routes);
    const failing: FetchLike = async (url) =>
      url === HEAD_URL ? new Response(null, { status: 500 }) : inner(url);

    const service = await startMirrorService(config, failing);
    try {
      await service.recorder.waitFor(1);
      expect(service.recorder.cycles[0]).toMatchObject({ status: "failed" });

      // The loop is a timer, and a cycle that throws inside a timer would take
      // the process with it. It rescheduled instead.
      await service.recorder.waitFor(2);
      expect(service.recorder.cycles[1]).toMatchObject({ status: "failed" });

      const check = await service.health("corpus-mirror-freshness");
      expect(check.ok).toBe(false);
      expect(check.detail).toContain(SOURCE_KEY);
      expect(check.detail).toContain("source-sync-failed");
      expect(check.detail).toContain("HTTP 500");
    } finally {
      await service.runtime.stop();
    }
  });

  test("a peer that accepts the connection and never answers cannot wedge the service", async () => {
    // The failure this bounds, reproduced against the real composition: with
    // no signal on `Transport.fetch`, `fetchHead` sat inside a single network
    // read forever. `runCycle`'s `finally` never ran, so the loop never
    // rescheduled — a standing mirror that stops permanently and silently,
    // holding an O_EXCL lock a SIGKILL does not release.
    const { archive, didKey } = await buildArchive();
    const config = resolveConfig({
      didKey,
      genesisDigest: archive.genesisDigest,
      syncIntervalMs: 1_000,
      syncTimeoutMs: 1_000,
    });

    // The black hole: never resolves on its own, and ends only when the
    // caller's signal says so — which is what a real `fetch` does, and what
    // this transport had no way to ask for.
    const blackHole: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });

    const service = await startMirrorService(config, blackHole);
    try {
      // Two cycles, so this is the loop still running rather than one cycle
      // that happened to end.
      await service.recorder.waitFor(2);
      expect(service.recorder.cycles[0]).toMatchObject({ status: "failed" });
      expect(service.recorder.cycles[1]).toMatchObject({ status: "failed" });
    } finally {
      await service.runtime.stop();
    }
  }, 20_000);

  test("the service follows the archives the home's configuration file declares", async () => {
    // The last link in the chain. Everything above resolves its configuration
    // in the test; a CLI-launched `mirror` resolves its own, and until the
    // entry points read a document it followed nothing at all (F-C7-1).
    const { archive, didKey } = await buildArchive();
    const configPath = join(home, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        corpus: {
          sources: [
            {
              ...source,
              signingKeys: [{ keyid: didKey, validFrom: "2026-01-01T00:00:00.000Z" }],
            },
          ],
          chainVerification: "verified",
          trust: { genesisDigest: archive.genesisDigest, policyDirectory: "policy" },
        },
      }),
    );
    // The reader refuses a config file other local users can write: it is the
    // only place the followed sources and their signing keys are declared.
    await chmod(configPath, 0o600);

    // The one document both entry-point paths resolve over, read exactly as
    // `bin.ts` reads it.
    const readConfigFile = createNodeRuntimeConfigFileReader(home);
    const config = resolveRuntimeConfig({ env: {}, homeDirectory: home, file: readConfigFile() });
    expect(config.corpus.sources.map((followed) => followed.repositoryId)).toEqual([
      source.repositoryId,
    ]);

    // The corpus composition root resolves the SAME document. Its verify
    // driver is the observable: the declared signing key is what the head
    // resolves against, so a driver built over an empty document would refuse
    // this chain `unauthorized-signer` and the cycle below would fail.
    const ports = resolveCorpusBinIoFields({ env: {}, homeDirectory: home, readConfigFile });
    expect(Object.keys(ports)).toContain("corpusVerifyDriver");

    const recorder = cycleRecorder();
    const runtime = createPluginRuntime({
      config,
      log: recorder.log,
      capabilities: buildMirrorCapabilities({
        ...binIo(config, loopbackFetch(archive.routes)),
        corpusVerifyDriver: (ports as LocalCorpusPorts).corpusVerifyDriver,
      }),
    });
    await runtime.start();
    try {
      await recorder.waitFor(1);
      expect(recorder.cycles[0]).toMatchObject({ status: "synced", indexed: true });
    } finally {
      await runtime.stop();
    }
  });
});
