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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openLocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";
import { headPath } from "@jinn-network/record-discovery-protocol";
import type { FetchLike } from "@jinn-network/record-discovery-transport-http";
import type { DsseSigner } from "@jinn-network/trust-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildMirrorCapabilities, type BinIo } from "../bin.js";
import {
  createNodeRuntimeConfigFileReader,
  nodeIndexDatabaseIo,
  nodeSensitivityNonceIo,
} from "../bin-node-fs.js";
import { resolveRuntimeConfig, type MirrorSourceConfig, type RuntimeConfig } from "../config.js";
import type { HealthCheck } from "../health.js";
import type { RuntimeLogger } from "../logger.js";
import { createMcpCapability } from "../mcp/capability.js";
import { TOOL_NAMES } from "../mcp/identifiers.js";
import { createCorpusAdmissionFilter } from "../relevance/admission.js";
import { createSensitivityClassifier, openRelevanceIndex } from "../relevance/index.js";
import { createPluginRuntime, type PluginRuntime } from "../runtime.js";
import {
  createLocalCorpusPorts,
  resolveCorpusBinIoFields,
  type LocalCorpusPorts,
} from "../session-host-corpus.js";
import { didKeyFromEd25519PublicKey } from "../session-host-crypto.js";
import { RUNTIME_VERSION } from "../version.js";
import { createCorpusCapability, type CorpusCapability } from "./capability.js";
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
      },
    },
  });
}

/** Exactly the `BinIo` the `mirror` command hands `buildMirrorCapabilities`. */
function binIo(config: RuntimeConfig, fetchLike: FetchLike): BinIo {
  return {
    writeOut: () => {},
    writeErr: () => {},
    homeDirectory: home,
    untilShutdown: () => new Promise<void>(() => {}),
    ...createLocalCorpusPorts({ config, fetchLike }),
  };
}

/**
 * One standing mirror service, started and run through its first cycle — the
 * production composition, not a hand-built stand-in.
 */
async function startMirrorService(config: RuntimeConfig, fetchLike: FetchLike) {
  const recorder = cycleRecorder();
  const capabilities = buildMirrorCapabilities(binIo(config, fetchLike));
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
 * A second, independent runtime over the SAME home, composed the way
 * `bin.buildServeCapabilities("tools", io, …)` composes one — the corpus
 * capability plus the MCP capability, whose transport seam is bound to a
 * linked in-memory pair instead of stdio.
 */
async function connectToolsClient(config: RuntimeConfig, fetchLike: FetchLike) {
  const ports = createLocalCorpusPorts({ config, fetchLike });
  const corpus = createCorpusCapability({
    transport: ports.corpusTransport,
    fs: ports.corpusFs,
    dsseVerifier: ports.dsseVerifier,
    readPolicyVersions: ports.readPolicyVersions,
    verifyDriver: ports.corpusVerifyDriver,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let runtime: PluginRuntime;
  const mcp = createMcpCapability({
    role: "tools",
    version: RUNTIME_VERSION,
    transport: serverTransport,
    resolve: async (context) => ({
      index: await openRelevanceIndex({
        databasePath: context.config.indexPath,
        classifier: await createSensitivityClassifier({
          noncePath: context.config.sensitivity.noncePath,
          knownIdentities: context.config.sensitivity.knownIdentities,
          nonceIo: nodeSensitivityNonceIo,
        }),
        indexIo: nodeIndexDatabaseIo,
      }),
      retrieval: corpus.retrieval,
      classifier: { classify: async () => ({ excluded: false }) },
      admission: createCorpusAdmissionFilter({
        admitProducer: async (producerId) => ({
          admitted: corpus.admission.admitProducer(producerId).status === "admitted",
        }),
      }),
      archiveDirectory: context.config.archiveDirectory,
      openLocalRuntime: () => openLocalEvidenceRuntime({ rootDir: context.config.archiveDirectory }),
      mirror: corpus.mirror,
      health: () => runtime.health(),
    }),
  });
  runtime = createPluginRuntime({
    config,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    capabilities: [corpus, mcp],
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

    const first = await startMirrorService(config, counting);
    await first.recorder.waitFor(1);
    const recordsAfterFirst = (await first.corpus.reader.listRecords({ limit: 50 })).items.length;
    const recordFetchesAfterFirst = recordFetches(served);
    const markAfterFirst = await readMark(config);
    await first.runtime.stop();

    // A genuinely fresh service over the same home: new capabilities, new
    // stores, new index handle. Everything it knows about where it left off
    // comes off disk.
    const second = await startMirrorService(config, counting);
    await second.recorder.waitFor(1);

    // Nothing above the mark to walk, so nothing was walked. The loop reports
    // only its cycle status, so the walk itself is read off the mirror the
    // restarted service is driving.
    const resumed = await second.corpus.mirror.syncOnce();
    expect(resumed.status).toBe("synced");
    expect(resumed.sources[0]!.entriesWalked).toBe(0);
    expect(resumed.sources[0]!.indexed).toBe(0);

    const recordsAfterSecond = (await second.corpus.reader.listRecords({ limit: 50 })).items.length;
    await second.runtime.stop();

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

  test("the service follows the archives the home's configuration file declares", async () => {
    // The last link in the chain. Everything above resolves its configuration
    // in the test; a CLI-launched `mirror` resolves its own, and until the
    // entry points read a document it followed nothing at all (F-C7-1).
    const { archive, didKey } = await buildArchive();
    await writeFile(
      join(home, "config.json"),
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
