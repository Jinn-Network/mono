// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEnvironmentRecord,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
} from "@jinn-network/chain-environment-record";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import {
  DSSE_PAYLOAD_TYPE,
  dssePreAuthEncoding,
  parseDsseEnvelope,
  recordDigest,
  type DsseSigner,
} from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import {
  buildConformanceChainRecord,
  conformanceArtifactBytes,
} from "./conformance-records.js";
import { fromDigestSet } from "./digests.js";
import { CHAIN_OBSERVATION_SCHEMA_ID } from "./identifiers.js";
import {
  buildCanonicalChainObservation,
  canonicalChainObservationBytes,
  chainObservationDigest,
} from "./observation.js";
import {
  DEFAULT_BLACKHOLE_POLICY,
  type ArtifactStore,
  type ChainRuntime,
  type Clock,
} from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import { verifyChainEnvironment } from "./verify.js";

const eoa = createEoaTestSigner("chain-verification-verify-suite");
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

function createFixedClock(): Clock {
  const fixed = new Date("2026-01-15T12:00:00.000Z");
  return { now: () => fixed };
}

function conformanceArtifactNames(): string[] {
  const record = buildConformanceChainRecord();
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
      egressAttempts: [],
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

interface StubRuntime extends ChainRuntime {
  readonly materializeRequests: MaterializationRequest[];
  stopCount: number;
}

function createStubRuntime(_options: { kind: "sealed-stable" }): StubRuntime {
  const materializeRequests: MaterializationRequest[] = [];
  const counters = { stopCount: 0 };
  const canonicalObservation = buildCanonicalChainObservation(REFERENCE_OBSERVATION_RAW);
  const runtime: StubRuntime = {
    get materializeRequests() {
      return materializeRequests;
    },
    get stopCount() {
      return counters.stopCount;
    },
    materializer: {
      async materialize(request) {
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
          async stop() {
            counters.stopCount += 1;
          },
        };
      },
      async reset(instance) {
        return instance.report!.postFixtureCommitment;
      },
    },
    probes: {
      async execute() {
        return {
          observation: canonicalObservation,
          observationDigest: chainObservationDigest(canonicalObservation),
          timedOut: false,
          cost: { wallSeconds: 0 },
        };
      },
    },
  };
  return runtime;
}

describe("verifyChainEnvironment", () => {
  it("attests closed-reproducible over K fresh instances", async () => {
    const runtime = createStubRuntime({ kind: "sealed-stable" });
    const artifactStore = createStubArtifactStore();
    const attestation = await verifyChainEnvironment(
      { runtime, artifactStore, signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );

    const { predicate } = attestation.statement;
    expect(predicate.outcome).toBe("closed-reproducible");
    expect(predicate.scope).toBe("component");
    expect(predicate.runs?.count).toBe(5);
    expect(predicate.runs?.allObservationsEqual).toBe(true);
    expect(predicate.runs?.freshInstances).toBe(true);
    expect(predicate.isolation.closureEvidenceMode).toBe("sealed-boundary");
    expect(predicate.failure).toBeUndefined();
    expect(attestation.outcome).toBe("closed-reproducible");
    expect(new Set(attestation.instanceIds).size).toBe(5);
    expect(attestation.observations).toHaveLength(5);
  });

  it("materializes K times under the blackhole policy, never once", async () => {
    const runtime = createStubRuntime({ kind: "sealed-stable" });
    await verifyChainEnvironment(
      { runtime, artifactStore: createStubArtifactStore(), signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );
    expect(runtime.materializeRequests).toHaveLength(5);
    for (const request of runtime.materializeRequests) {
      expect(request.networkPolicy).toEqual(DEFAULT_BLACKHOLE_POLICY);
    }
    expect(new Set(runtime.materializeRequests.map((one) => one.instanceId)).size).toBe(5);
    expect(runtime.stopCount).toBe(5);
  });

  it("stores the canonical observation and the resolution log through the artifact port", async () => {
    const artifactStore = createStubArtifactStore();
    const attestation = await verifyChainEnvironment(
      { runtime: createStubRuntime({ kind: "sealed-stable" }), artifactStore, signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );
    const observationDigest = chainObservationDigest(attestation.observations[0]!);
    expect(artifactStore.stored.get(observationDigest))
      .toEqual(canonicalChainObservationBytes(attestation.observations[0]!));
    expect(attestation.statement.predicate.baseline?.observation.digest.sha256)
      .toBe(observationDigest.slice("sha256:".length));
    const logDigest = attestation.statement.predicate.isolation.resolutionLog.digest.sha256;
    expect(artifactStore.stored.has(`sha256:${logDigest}`)).toBe(true);
  });

  it("seals a DSSE envelope whose payload is the statement", async () => {
    const attestation = await verifyChainEnvironment(
      { runtime: createStubRuntime({ kind: "sealed-stable" }), artifactStore: createStubArtifactStore(), signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );
    const envelope = parseDsseEnvelope(attestation.envelopeBytes);
    expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(JSON.parse(new TextDecoder().decode(envelope.payloadBytes)))
      .toEqual(attestation.statement);
    expect(attestation.attestationDigest).toBe(recordDigest(attestation.envelopeBytes));
    const preAuth = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
    expect(preAuth.length).toBeGreaterThan(0);
  });

  it("refuses K below the floor, and refuses an archive-dependent record", async () => {
    const deps = { runtime: createStubRuntime({ kind: "sealed-stable" }), artifactStore: createStubArtifactStore(), signer, clock: createFixedClock(), verifier: VERIFIER };
    await expect(verifyChainEnvironment(deps, buildConformanceChainRecord(), { runCount: 4 }))
      .rejects.toThrow(/at least 5/u);
    const archiveRecord = buildConformanceChainRecord({ closureClass: "archive-dependent" });
    await expect(verifyChainEnvironment(deps, archiveRecord))
      .rejects.toThrow(/observeArchiveEnvironment/u);
  });

  it("is byte-stable across repeated runs of the same scenario", async () => {
    const run = async () => verifyChainEnvironment(
      { runtime: createStubRuntime({ kind: "sealed-stable" }), artifactStore: createStubArtifactStore(), signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );
    const [first, second] = [await run(), await run()];
    expect(second.statement).toEqual(first.statement);
    expect(second.envelopeBytes).toEqual(first.envelopeBytes);
  });
});
