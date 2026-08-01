// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEnvironmentRecord,
  ChainInstance,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
  ScriptReplayer,
} from "@jinn-network/chain-environment-record";
import * as chainVerification from "@jinn-network/chain-environment-verification";
import { createRequire } from "node:module";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import {
  recordDigest,
  type DsseSigner,
  type Sha256Digest,
} from "@jinn-network/trust-core";
import { describe, expect, it, vi } from "vitest";

import type { AnchorCapture } from "./anchor.js";
import { establishBaseline, type ExtractionRequest } from "./baseline.js";
import { createBudgetedArchivePort } from "./budget.js";
import { normalizeAddress, normalizeSlot } from "./hex.js";
import { keySetIsEmpty } from "./key-set.js";
import type {
  ArtifactStore,
  Clock,
  ExtractionDeps,
  VerifierIdentity,
} from "./ports.js";
import {
  buildFakeTrieWorld,
  FAKE_POOL,
  FAKE_SLOT_1,
  FAKE_SLOT_2,
} from "./testing.js";

const require = createRequire(import.meta.url);
const { buildConformanceChainRecord, conformanceArtifactBytes } = require(
  "../../chain-verification/dist/conformance-records.js",
) as {
  buildConformanceChainRecord: (options?: { closureClass?: "archive-dependent" }) => ChainEnvironmentRecord;
  conformanceArtifactBytes: (name: string) => Uint8Array;
};

const VERIFIER: VerifierIdentity = {
  id: "jinn.chain-state-extraction/baseline",
  version: "0.0.0",
  digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
};

const eoa = createEoaTestSigner("chain-extraction-baseline-suite");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding),
}];

function createFixedClock(): Clock {
  const fixed = new Date("2026-07-31T09:00:00.000Z");
  return { now: () => fixed };
}

function conformanceArtifactNames(): string[] {
  const record = buildConformanceChainRecord({ closureClass: "archive-dependent" });
  const names = ["materializer", "probe-suite", "comparator", "state-artifact"];
  record.fixtures.modules.forEach((module, index) => {
    names.push(`fixture-${index}-${module.id}`);
  });
  return names;
}

function createConformanceArtifactStore(): ArtifactStore {
  const byDigest = new Map<string, Uint8Array>();
  for (const name of conformanceArtifactNames()) {
    const bytes = conformanceArtifactBytes(name);
    byDigest.set(recordDigest(bytes), bytes);
  }
  const stored = new Map<Sha256Digest, Uint8Array>();
  return {
    async getArtifact(descriptor) {
      const digest = `sha256:${descriptor.digest.sha256}` as Sha256Digest;
      const bytes = byDigest.get(digest);
      if (bytes === undefined) {
        throw new Error(`artifact unavailable for ${digest}`);
      }
      return bytes;
    },
    async putArtifact(bytes) {
      const digest = recordDigest(bytes);
      stored.set(digest, bytes);
      return { digest, size: bytes.length };
    },
  };
}

function buildMaterializationReport(
  record: ChainEnvironmentRecord,
  networkPolicy: NetworkPolicy,
  loadedResources: readonly `sha256:${string}`[],
): MaterializationReport {
  const controls = record.determinismControls;
  return {
    runtimeIdentity: {
      imageManifestDigest: record.runtime.image.manifestDigest as `sha256:${string}`,
      platform: record.runtime.image.platform,
      reportedVersion: record.runtime.version,
      binaryDigest: record.runtime.binary.digest as `sha256:${string}`,
      evmConfigurationDigest: record.runtime.binary.digest as `sha256:${string}`,
      chainId: record.runtime.evm.sandboxChainId,
      appliedControls: {
        miningMode: controls.miningMode,
        orderingPolicy: controls.orderingPolicy,
        resetMechanism: controls.resetMechanism,
      },
      unsupportedControls: [],
    },
    artifactEntries: {
      accounts: [],
      codeEntries: [],
      storageSlots: [],
    },
    postFixtureCommitment: record.stateMaterialization.initialStateCommitment as `0x${string}`,
    loadedResources: [...loadedResources],
    isolation: {
      networkPolicy,
      egressAttempts: networkPolicy.forkBackend === "present"
        ? [{ target: "https://archive.example/rpc", outcome: "refused" as const }]
        : [],
      forbiddenProbes: [],
      exposedSignerAccounts: record.fixtures.accounts
        .filter((account) => account.role === "agent")
        .map((account) => account.address),
      ceilingChecks: [
        { name: "maxTransactions", enforced: true },
        { name: "maxAggregateGas", enforced: true },
        { name: "maxExecutionDurationMs", enforced: true },
      ],
    },
    cost: { wallSeconds: 0 },
  };
}

function createBaselineStubRuntime(
  observation: chainVerification.CanonicalChainObservation,
): ExtractionDeps["runtime"] {
  return {
    materializer: {
      async materialize(request: MaterializationRequest) {
        if (request.stateBackend !== undefined) {
          const blockNumber = request.record.sourceAnchor?.blockNumber ?? 1;
          const pool = normalizeAddress(FAKE_POOL);
          await request.stateBackend.getBlockHeader(blockNumber);
          await request.stateBackend.getAccount(pool, blockNumber);
          await request.stateBackend.getCode(pool, blockNumber);
          await request.stateBackend.getStorageAt(pool, normalizeSlot(FAKE_SLOT_1), blockNumber);
          await request.stateBackend.getStorageAt(pool, normalizeSlot(FAKE_SLOT_2), blockNumber);
        }
        const loadedResources = [...request.resources.byDigest.keys()];
        return {
          instanceId: request.instanceId,
          rpcEndpoint: "http://127.0.0.1:0",
          report: buildMaterializationReport(
            request.record,
            request.networkPolicy,
            loadedResources,
          ),
          async stop() {},
        };
      },
      async reset(instance: ChainInstance) {
        return instance.report!.postFixtureCommitment;
      },
    },
    probes: {
      async execute() {
        return {
          observation,
          observationDigest: chainVerification.chainObservationDigest(observation),
          timedOut: false,
          cost: { wallSeconds: 0 },
        };
      },
    },
  } as unknown as ExtractionDeps["runtime"];
}

function fakeReplayer(): ScriptReplayer {
  return {
    async replay() {
      throw new Error("baseline tests do not replay scripts");
    },
  };
}

function extractionRequest(draft: ChainEnvironmentRecord): ExtractionRequest {
  return {
    draft,
    anchorBlockNumber: 1,
    fidelityClass: "anchored-subset",
    sourceAddresses: [FAKE_POOL],
    fixtureDeclarations: [],
    finalityPolicy: "finalized",
  };
}

function testAnchor(world: ReturnType<typeof buildFakeTrieWorld>): AnchorCapture {
  return {
    blockNumber: 1,
    blockHash: `0x${"1".repeat(64)}`,
    stateRoot: world.stateRoot,
    timestamp: 1,
    finality: {
      observedAt: "2026-07-31T09:00:00.000Z",
      finalizedBlockNumber: 64,
      depthBelowFinalized: 63,
      finalizedAtObservation: true,
    },
    headerProof: undefined,
  };
}

function extractionDeps(runtime: ExtractionDeps["runtime"]): ExtractionDeps {
  return {
    archive: buildFakeTrieWorld().archive(),
    forkBackend: { kind: "injected-port" },
    runtime,
    replayer: fakeReplayer(),
    artifactStore: createConformanceArtifactStore(),
    signer,
    clock: createFixedClock(),
    verifier: VERIFIER,
  };
}

describe("establishBaseline", () => {
  it("agrees with itself and returns two identical run digests", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 1_000_000 });
    const observation = chainVerification.buildCanonicalChainObservation({
      schema: chainVerification.CHAIN_OBSERVATION_SCHEMA_ID,
      probes: [],
      touchedState: [],
      stateReads: [],
      traceProjectionDigest: `sha256:${"5".repeat(64)}`,
      finalStateCommitment: `0x${"a".repeat(64)}`,
      blocks: [{
        number: "1",
        hash: `0x${"1".repeat(64)}`,
        stateRoot: world.stateRoot,
        timestamp: "1",
      }],
    });
    const deps = extractionDeps(createBaselineStubRuntime(observation));
    const draft = buildConformanceChainRecord({ closureClass: "archive-dependent" });
    const outcome = await establishBaseline(
      deps,
      extractionRequest(draft),
      archive,
      testAnchor(world),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.runObservationDigests).toHaveLength(2);
    expect(outcome.value.runObservationDigests[0]).toBe(outcome.value.runObservationDigests[1]);
    expect(outcome.value.attestation.outcome).toBe("archive-observed");
  });

  it("journals the pool account and its storage slots", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 1_000_000 });
    const observation = chainVerification.buildCanonicalChainObservation({
      schema: chainVerification.CHAIN_OBSERVATION_SCHEMA_ID,
      probes: [],
      touchedState: [],
      stateReads: [],
      traceProjectionDigest: `sha256:${"5".repeat(64)}`,
      finalStateCommitment: `0x${"a".repeat(64)}`,
      blocks: [{
        number: "1",
        hash: `0x${"1".repeat(64)}`,
        stateRoot: world.stateRoot,
        timestamp: "1",
      }],
    });
    const deps = extractionDeps(createBaselineStubRuntime(observation));
    const draft = buildConformanceChainRecord({ closureClass: "archive-dependent" });
    const outcome = await establishBaseline(
      deps,
      extractionRequest(draft),
      archive,
      testAnchor(world),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(keySetIsEmpty(outcome.value.touched)).toBe(false);
    const pool = normalizeAddress(FAKE_POOL);
    expect(outcome.value.touched.accounts).toContain(pool);
    expect(outcome.value.touched.code).toContain(pool);
    const storage = outcome.value.touched.storage.find((entry) => entry.address === pool);
    expect(storage?.slots).toEqual([
      normalizeSlot(FAKE_SLOT_1),
      normalizeSlot(FAKE_SLOT_2),
    ]);
  });

  it("maps provider-disagreement to archive-self-disagreement", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 1_000_000 });
    const spy = vi.spyOn(chainVerification, "observeArchiveEnvironment").mockResolvedValue({
      envelopeBytes: new Uint8Array(),
      payloadBytes: new Uint8Array(),
      attestationDigest: `sha256:${"d".repeat(64)}`,
      statement: {} as never,
      outcome: "provider-disagreement",
      instanceIds: [],
      observations: [],
    });
    const deps = extractionDeps(createBaselineStubRuntime(
      chainVerification.buildCanonicalChainObservation({
        schema: chainVerification.CHAIN_OBSERVATION_SCHEMA_ID,
        probes: [],
        touchedState: [],
        stateReads: [],
        traceProjectionDigest: `sha256:${"5".repeat(64)}`,
        finalStateCommitment: `0x${"a".repeat(64)}`,
        blocks: [],
      }),
    ));
    const outcome = await establishBaseline(
      deps,
      extractionRequest(buildConformanceChainRecord({ closureClass: "archive-dependent" })),
      archive,
      testAnchor(world),
    );
    spy.mockRestore();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("archive-self-disagreement");
  });

  it("maps probe-divergence to baseline-unstable", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 1_000_000 });
    const spy = vi.spyOn(chainVerification, "observeArchiveEnvironment").mockResolvedValue({
      envelopeBytes: new Uint8Array(),
      payloadBytes: new Uint8Array(),
      attestationDigest: `sha256:${"e".repeat(64)}`,
      statement: {} as never,
      outcome: "probe-divergence",
      instanceIds: [],
      observations: [],
    });
    const deps = extractionDeps(createBaselineStubRuntime(
      chainVerification.buildCanonicalChainObservation({
        schema: chainVerification.CHAIN_OBSERVATION_SCHEMA_ID,
        probes: [],
        touchedState: [],
        stateReads: [],
        traceProjectionDigest: `sha256:${"5".repeat(64)}`,
        finalStateCommitment: `0x${"a".repeat(64)}`,
        blocks: [],
      }),
    ));
    const outcome = await establishBaseline(
      deps,
      extractionRequest(buildConformanceChainRecord({ closureClass: "archive-dependent" })),
      archive,
      testAnchor(world),
    );
    spy.mockRestore();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("baseline-unstable");
  });

  it("surfaces archive budget exhaustion without crashing", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 1_000_000 });
    const budgetMessage = "Archive budget exhausted: maxCalls=5 reached after 5 calls.";
    const spy = vi.spyOn(chainVerification, "observeArchiveEnvironment").mockRejectedValue(
      new Error(budgetMessage),
    );
    const observation = chainVerification.buildCanonicalChainObservation({
      schema: chainVerification.CHAIN_OBSERVATION_SCHEMA_ID,
      probes: [],
      touchedState: [],
      stateReads: [],
      traceProjectionDigest: `sha256:${"5".repeat(64)}`,
      finalStateCommitment: `0x${"a".repeat(64)}`,
      blocks: [{
        number: "1",
        hash: `0x${"1".repeat(64)}`,
        stateRoot: world.stateRoot,
        timestamp: "1",
      }],
    });
    const deps = extractionDeps(createBaselineStubRuntime(observation));
    const outcome = await establishBaseline(
      deps,
      extractionRequest(buildConformanceChainRecord({ closureClass: "archive-dependent" })),
      archive,
      testAnchor(world),
    );
    spy.mockRestore();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("archive-budget-exhausted");
    expect(outcome.detail).toContain("Archive budget exhausted");
  });
});
