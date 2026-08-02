// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEnvironmentRecord,
  ChainInstance,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
} from "@jinn-network/chain-environment-record";
import { BLACKHOLE_EGRESS_POLICY_ID } from "@jinn-network/chain-environment-record";
import * as chainVerification from "@jinn-network/chain-environment-verification";
import { createRequire } from "node:module";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { recordDigest, type DsseSigner, type Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { extractEnvironment } from "./extract.js";
import type { ExtractionRequest } from "./baseline.js";
import { normalizeAddress, normalizeHex32, normalizeSlot } from "./hex.js";
import { differenceKeySets, keySetIsEmpty } from "./key-set.js";
import { stateArtifactKeySet } from "./artifact.js";
import type {
  ArchiveRpcPort,
  ExtractionDeps,
  ScriptReplayer,
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
  id: "jinn.chain-state-extraction/extract",
  version: "0.0.0",
  digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
};

const eoa = createEoaTestSigner("chain-extraction-extract-suite");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding),
}];

function closedStateDraft(): ChainEnvironmentRecord {
  const draft = buildConformanceChainRecord({ closureClass: "archive-dependent" });
  return {
    ...draft,
    capabilityEnvelope: {
      ...draft.capabilityEnvelope,
      egressPolicyId: BLACKHOLE_EGRESS_POLICY_ID,
    },
    determinismControls: {
      ...draft.determinismControls,
      resetMechanism: "fresh-process",
    },
    verificationContract: {
      ...draft.verificationContract,
      closureCheckRequired: true,
    },
  };
}

function conformanceArtifactNames(): string[] {
  const record = buildConformanceChainRecord({ closureClass: "archive-dependent" });
  const names = ["materializer", "probe-suite", "comparator", "state-artifact"];
  record.fixtures.modules.forEach((module, index) => {
    names.push(`fixture-${index}-${module.id}`);
  });
  return names;
}

function createConformanceArtifactStore(): ExtractionDeps["artifactStore"] {
  const byDigest = new Map<string, Uint8Array>();
  for (const name of conformanceArtifactNames()) {
    const bytes = conformanceArtifactBytes(name);
    byDigest.set(recordDigest(bytes), bytes);
  }
  const stored = new Map<Sha256Digest, Uint8Array>();
  return {
    async getArtifact(descriptor) {
      const digest = `sha256:${descriptor.digest.sha256}` as Sha256Digest;
      const bytes = byDigest.get(digest) ?? stored.get(digest);
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
  const entryCounts = record.stateMaterialization.stateArtifact?.entryCounts ?? {
    accounts: 0,
    codeEntries: 0,
    storageSlots: 0,
  };
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
      accounts: Array.from({ length: entryCounts.accounts }, () => normalizeAddress(FAKE_POOL)),
      codeEntries: Array.from({ length: entryCounts.codeEntries }, () => normalizeAddress(FAKE_POOL)),
      storageSlots: Array.from({ length: entryCounts.storageSlots }, () => ({
        address: normalizeAddress(FAKE_POOL),
        slot: normalizeSlot(FAKE_SLOT_1),
      })),
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

function createExtractStubRuntime(
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
      throw new Error("extract tests do not replay scripts");
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

function extractionDeps(
  runtime: ExtractionDeps["runtime"],
  archive: ArchiveRpcPort = buildFakeTrieWorld().archive(),
): ExtractionDeps {
  return {
    archive,
    forkBackend: { kind: "injected-port" },
    runtime,
    replayer: fakeReplayer(),
    artifactStore: createConformanceArtifactStore(),
    signer,
    clock: { now: () => new Date("2026-07-31T09:00:00.000Z") },
    verifier: VERIFIER,
  };
}

function observationFor(world: ReturnType<typeof buildFakeTrieWorld>) {
  const draft = closedStateDraft();
  return chainVerification.buildCanonicalChainObservation({
    schema: chainVerification.CHAIN_OBSERVATION_SCHEMA_ID,
    probes: [],
    touchedState: [],
    stateReads: [],
    traceProjectionDigest: `sha256:${"5".repeat(64)}`,
    finalStateCommitment: draft.stateMaterialization.initialStateCommitment as `0x${string}`,
    blocks: [{
      number: "1",
      hash: `0x${"1".repeat(64)}`,
      stateRoot: world.stateRoot,
      timestamp: "1",
    }],
  });
}

function archiveWithAnchorDrift(inner: ArchiveRpcPort, blockNumber = 1): ArchiveRpcPort {
  let anchorBlockHeaderReads = 0;
  return {
    ...inner,
    async getBlockHeader(selector) {
      const header = await inner.getBlockHeader(selector);
      if (selector === blockNumber) {
        anchorBlockHeaderReads += 1;
        if (anchorBlockHeaderReads > 1) {
          return { ...header, stateRoot: normalizeHex32(`0x${"7".repeat(64)}`) };
        }
      }
      return header;
    },
  };
}

describe("extractEnvironment", () => {
  it("returns a candidate whose artifact covers the harvest journal", async () => {
    const world = buildFakeTrieWorld();
    const deps = extractionDeps(createExtractStubRuntime(observationFor(world)), world.archive());
    const result = await extractEnvironment(deps, extractionRequest(closedStateDraft()));
    if (result.status === "failed") {
      throw new Error(`${result.reason} @ ${result.stage}: ${result.detail}`);
    }
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") return;

    const artifactKeys = stateArtifactKeySet(result.candidate.artifact);
    const uncovered = differenceKeySets(result.candidate.baseline.touched, artifactKeys);
    expect(keySetIsEmpty(uncovered)).toBe(true);
  });

  it("never surfaces closed-reproducible or verified in the returned value", async () => {
    const world = buildFakeTrieWorld();
    const deps = extractionDeps(createExtractStubRuntime(observationFor(world)), world.archive());
    const result = await extractEnvironment(deps, extractionRequest(closedStateDraft()));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/closed-reproducible|"verified"/u);
  });

  it("refuses a bound above the ceiling before touching the archive", async () => {
    const world = buildFakeTrieWorld();
    const deps = extractionDeps(createExtractStubRuntime(observationFor(world)));
    const result = await extractEnvironment(deps, {
      ...extractionRequest(closedStateDraft()),
      maxWidenings: 9,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("widen-bound-above-ceiling");
    expect(result.archiveUsage.calls).toBe(0);
    expect(result.archiveUsage.bytes).toBe(0);
  });

  it("surfaces archive-anchor-pruned as archive-unavailable", async () => {
    const deps = extractionDeps(createExtractStubRuntime(observationFor(buildFakeTrieWorld())), {
      async getBlockHeader() {
        throw new Error("missing trie node 0xabc (path ) state 0xdef");
      },
      async getAccount() { throw new Error("unused"); },
      async getCode() { throw new Error("unused"); },
      async getStorageAt() { throw new Error("unused"); },
      async getProof() { throw new Error("unused"); },
    });
    const result = await extractEnvironment(deps, extractionRequest(closedStateDraft()));
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("archive-anchor-pruned");
    expect(result.disposition).toBe("archive-unavailable");
  });

  it("surfaces anchor drift as provider-disagreement", async () => {
    const world = buildFakeTrieWorld();
    const deps = extractionDeps(
      createExtractStubRuntime(observationFor(world)),
      archiveWithAnchorDrift(world.archive()),
    );
    const result = await extractEnvironment(deps, extractionRequest(closedStateDraft()));
    if (result.status === "failed" && result.reason !== "archive-self-disagreement") {
      throw new Error(`${result.reason} @ ${result.stage}: ${result.detail}`);
    }
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("archive-self-disagreement");
    expect(result.disposition).toBe("provider-disagreement");
  });
});
