// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEnvironmentRecord,
  ChainStateBackend,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
} from "@jinn-network/chain-environment-record";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import {
  recordDigest,
  type DsseSigner,
} from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { observeArchiveEnvironment } from "./archive.js";
import {
  buildConformanceChainRecord,
  conformanceArtifactBytes,
} from "./conformance-records.js";
import { fromDigestSet } from "./digests.js";
import { CHAIN_OBSERVATION_SCHEMA_ID } from "./identifiers.js";
import {
  buildCanonicalChainObservation,
  chainObservationDigest,
} from "./observation.js";
import {
  type ArtifactStore,
  type ChainRuntime,
  type ChainVerificationDeps,
  type Clock,
} from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import type { SealedAttestation } from "./verify.js";

const RECORD = () => buildConformanceChainRecord({ closureClass: "archive-dependent" });

const eoa = createEoaTestSigner("chain-verification-archive-suite");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding),
}];

const VERIFIER: VerifierIdentity = {
  id: "jinn.chain-environment-verification/conformance",
  version: "0.0.0",
  digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
};

const REFERENCE_OBSERVATION_RAW = {
  schema: CHAIN_OBSERVATION_SCHEMA_ID,
  probes: [
    {
      id: "transfer-happy-path",
      transactionDigest: `sha256:${"1".repeat(64)}`,
      receiptStatus: "success",
      gasUsed: "51234",
      logs: [{
        address: "0x00000000000000000000000000000000000000aa",
        topics: [`0x${"2".repeat(64)}`],
        data: "0x00",
      }],
      returnData: "0x",
    },
    {
      id: "out-of-slice-read-is-empty",
      receiptStatus: "not-executed",
      gasUsed: "0",
      logs: [],
      returnData: "0x",
      expectedErrorClass: "empty-account",
      observedErrorClass: "empty-account",
    },
  ],
  touchedState: [
    {
      address: "0x00000000000000000000000000000000000000bb",
      nonce: "1",
      balance: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      codeHash: `0x${"3".repeat(64)}`,
      storage: [
        { slot: `0x${"0".repeat(63)}2`, value: `0x${"0".repeat(63)}9` },
        { slot: `0x${"0".repeat(63)}1`, value: `0x${"0".repeat(63)}7` },
      ],
    },
    {
      address: "0x00000000000000000000000000000000000000aa",
      nonce: "0",
      balance: "0",
      codeHash: `0x${"4".repeat(64)}`,
      storage: [],
    },
  ],
  stateReads: [],
  traceProjectionDigest: `sha256:${"5".repeat(64)}`,
  finalStateCommitment: `0x${"a".repeat(64)}`,
  blocks: [{
    number: "17",
    hash: `0x${"7".repeat(64)}`,
    stateRoot: `0x${"8".repeat(64)}`,
    timestamp: "1900000000",
  }],
} as const;

const DIVERGENT_OBSERVATION_RAW = {
  ...REFERENCE_OBSERVATION_RAW,
  finalStateCommitment: `0x${"b".repeat(64)}`,
};

type ArchiveScenario = "two-agreeing-providers" | "providers-disagree" | "single-provider";

function createFixedClock(): Clock {
  const fixed = new Date("2026-01-15T12:00:00.000Z");
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

function createStubArtifactStore(): ArtifactStore & { stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  const byDigest = new Map<string, Uint8Array>();
  for (const name of conformanceArtifactNames()) {
    const bytes = conformanceArtifactBytes(name);
    byDigest.set(recordDigest(bytes), bytes);
  }
  return {
    stored,
    async getArtifact(descriptor) {
      const digest = fromDigestSet(descriptor.digest);
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

function asPrefixedDigest(digest: string): `sha256:${string}` {
  return digest as `sha256:${string}`;
}

function buildMaterializationReport(
  record: ChainEnvironmentRecord,
  networkPolicy: NetworkPolicy,
  loadedResources: readonly `sha256:${string}`[],
): MaterializationReport {
  const controls = record.determinismControls;
  return {
    runtimeIdentity: {
      imageManifestDigest: asPrefixedDigest(record.runtime.image.manifestDigest),
      platform: record.runtime.image.platform,
      reportedVersion: record.runtime.version,
      binaryDigest: asPrefixedDigest(record.runtime.binary.digest),
      evmConfigurationDigest: asPrefixedDigest(record.runtime.binary.digest),
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

function createStubBackend(): ChainStateBackend {
  return {
    async getAccount() {
      return {
        nonce: "0",
        balanceWei: "0",
        codeHash: `0x${"0".repeat(64)}`,
      };
    },
    async getCode() {
      return `0x${"0".repeat(64)}`;
    },
    async getStorageAt() {
      return `0x${"0".repeat(64)}`;
    },
    async getBlockHeader() {
      return {
        hash: `0x${"7".repeat(64)}`,
        stateRoot: `0x${"8".repeat(64)}`,
        timestamp: 1_900_000_000,
      };
    },
  };
}

interface ArchiveStubRuntime extends ChainRuntime {
  readonly materializeRequests: MaterializationRequest[];
  locatorReads: number;
}

function createArchiveStubRuntime(scenario: ArchiveScenario): ArchiveStubRuntime {
  const materializeRequests: MaterializationRequest[] = [];
  const counters = { locatorReads: 0 };
  const canonicalObservation = buildCanonicalChainObservation(REFERENCE_OBSERVATION_RAW);
  const divergentObservation = buildCanonicalChainObservation(DIVERGENT_OBSERVATION_RAW);
  const archiveNetworkPolicy = {
    egress: "denied" as const,
    dns: "absent" as const,
    archiveRpc: "unreachable" as const,
    forkBackend: "present" as const,
  };

  const runtime: ArchiveStubRuntime = {
    get materializeRequests() {
      return materializeRequests;
    },
    get locatorReads() {
      return counters.locatorReads;
    },
    set locatorReads(value: number) {
      counters.locatorReads = value;
    },
    materializer: {
      async materialize(request) {
        const materialization = request.record.stateMaterialization as {
          readonly providerLocators?: unknown;
        };
        if (materialization.providerLocators !== undefined) {
          counters.locatorReads += 1;
        }
        if (request.stateBackend !== undefined) {
          const blockNumber = 17;
          const address = "0x00000000000000000000000000000000000000aa";
          await request.stateBackend.getBlockHeader(blockNumber);
          await request.stateBackend.getAccount(address, blockNumber);
          await request.stateBackend.getCode(address, blockNumber);
          await request.stateBackend.getStorageAt(address, `0x${"0".repeat(64)}`, blockNumber);
        }
        materializeRequests.push(request);
        const loadedResources = [...request.resources.byDigest.keys()];
        const report = buildMaterializationReport(
          request.record,
          request.networkPolicy,
          loadedResources,
        );
        return {
          instanceId: request.instanceId,
          rpcEndpoint: "http://127.0.0.1:0",
          report,
          async stop() {},
        };
      },
      async reset(instance) {
        return instance.report!.postFixtureCommitment;
      },
    },
    probes: {
      async execute(request) {
        const observation = scenario === "providers-disagree"
          && request.instance.instanceId.includes("provider-b")
          ? divergentObservation
          : canonicalObservation;
        return {
          observation,
          observationDigest: chainObservationDigest(observation),
          timedOut: false,
          cost: { wallSeconds: 0 },
        };
      },
    },
  };
  return runtime;
}

function archiveDeps(
  scenario: ArchiveScenario = "two-agreeing-providers",
  runtime?: ArchiveStubRuntime,
): ChainVerificationDeps {
  return {
    runtime: runtime ?? createArchiveStubRuntime(scenario),
    artifactStore: createStubArtifactStore(),
    signer,
    clock: createFixedClock(),
    verifier: VERIFIER,
  };
}

function defaultProviders(scenario: ArchiveScenario) {
  if (scenario === "single-provider") {
    return [{ id: "provider-a", stateBackend: createStubBackend() }];
  }
  return [
    { id: "provider-a", stateBackend: createStubBackend() },
    { id: "provider-b", stateBackend: createStubBackend() },
  ];
}

async function runArchive(
  scenario: ArchiveScenario,
  runtime?: ArchiveStubRuntime,
): Promise<SealedAttestation> {
  return observeArchiveEnvironment(
    archiveDeps(scenario, runtime),
    RECORD(),
    { providers: defaultProviders(scenario) },
  );
}

async function runArchiveWithRuntime(scenario: ArchiveScenario): Promise<{
  runtime: ArchiveStubRuntime;
  attestation: SealedAttestation;
}> {
  const runtime = createArchiveStubRuntime(scenario);
  const attestation = await runArchive(scenario, runtime);
  return { runtime, attestation };
}

describe("observeArchiveEnvironment", () => {
  it("attests archive-observed, never closed-reproducible", async () => {
    const attestation = await runArchive("two-agreeing-providers");
    const { predicate } = attestation.statement;
    expect(predicate.outcome).toBe("archive-observed");
    expect(predicate.environment.closureClass).toBe("archive-dependent");
    expect(predicate.runs?.count).toBe(5);
    expect(predicate.providers).toHaveLength(2);
    expect(predicate.cost.rpcCalls).toBeGreaterThan(0);
  });

  it("records providers, observation time, and RPC cost per provider", async () => {
    const { predicate } = (await runArchive("two-agreeing-providers")).statement;
    for (const provider of predicate.providers ?? []) {
      expect(provider.id).toMatch(/provider-/u);
      expect(provider.observedAt).toMatch(/Z$/u);
      expect(provider.rpcCalls).toBeGreaterThan(0);
      expect(provider.rpcBytes).toBeGreaterThan(0);
    }
  });

  it("attests provider-disagreement when providers do not agree", async () => {
    const { predicate } = (await runArchive("providers-disagree")).statement;
    expect(predicate.outcome).toBe("provider-disagreement");
    expect(predicate.failure?.reason).toBe("provider-observation-disagreement");
    expect(new Set((predicate.providers ?? []).map((one) => one.observationDigest)).size)
      .toBe(2);
  });

  it("refuses a closed-state record", async () => {
    await expect(observeArchiveEnvironment(archiveDeps(), buildConformanceChainRecord()))
      .rejects.toThrow(/verifyChainEnvironment/u);
  });

  it("refuses a provider with no caller-owned state backend, and never reads the locators",
    async () => {
      await expect(observeArchiveEnvironment(
        archiveDeps(), RECORD(), { providers: [{ id: "provider-a" } as never] },
      )).rejects.toThrow(/stateBackend/u);
      const { runtime } = await runArchiveWithRuntime("two-agreeing-providers");
      for (const request of runtime.materializeRequests) {
        expect(request.stateBackend).toBeDefined();
      }
      expect(runtime.locatorReads).toBe(0);
    });

  it("never claims closure: no boundary probe, no closed-reproducible outcome", async () => {
    const { predicate } = (await runArchive("two-agreeing-providers")).statement;
    expect(predicate.isolation.closureEvidenceMode).toBe("fork-backend-refusal");
    expect(predicate.isolation.boundaryProbe).toBeUndefined();
    expect(predicate.outcome).not.toBe("closed-reproducible");
  });

  it("warns in the detail when only one provider was available", async () => {
    const { predicate } = (await runArchive("single-provider")).statement;
    expect(predicate.outcome).toBe("archive-observed");
    expect(predicate.providers).toHaveLength(1);
    expect(predicate.evidence?.some((one) => one.name === "provider-availability-note"))
      .toBe(true);
  });
});
