// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEnvironmentRecord,
  CryptoEnvironmentRecord,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
} from "@jinn-network/chain-environment-record";
import {
  chainEnvironmentRecordDigest,
  sealChainEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { recordDigest, type DsseSigner, type Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { assessOriginRouting, verifyCryptoEnvironment } from "./composite.js";
import type { SealedAttestation } from "./verify.js";
import {
  buildConformanceChainRecord,
  buildConformanceCompositeRecord,
  conformanceArtifactBytes,
} from "./conformance-records.js";
import { fromDigestSet } from "./digests.js";
import { CHAIN_OBSERVATION_SCHEMA_ID, COMPOSITE_OBSERVATION_SCHEMA_ID } from "./identifiers.js";
import {
  buildCanonicalChainObservation,
  buildCompositeObservation,
  chainObservationDigest,
} from "./observation.js";
import {
  DEFAULT_BLACKHOLE_POLICY,
  type ArtifactStore,
  type ChainRuntime,
  type Clock,
  type InformationWorldRuntime,
} from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import { attestationMatchesRecord, requiresComponentAttestations } from "./statement.js";

const WORLD_A = `sha256:${"a".repeat(64)}`;
const WORLD_B = `sha256:${"b".repeat(64)}`;

const eoa = createEoaTestSigner("chain-verification-composite-suite");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding),
}];

const VERIFIER: VerifierIdentity = {
  id: "jinn.chain-environment-verification/composite",
  version: "0.0.0",
  digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
};

const REFERENCE_CHAIN_OBSERVATION = buildCanonicalChainObservation({
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
  touchedState: [],
  stateReads: [],
  traceProjectionDigest: `sha256:${"5".repeat(64)}`,
  finalStateCommitment: `0x${"a".repeat(64)}`,
  blocks: [{
    number: "17",
    hash: `0x${"7".repeat(64)}`,
    stateRoot: `0x${"8".repeat(64)}`,
    timestamp: "1900000000",
  }],
});

const REFERENCE_INFORMATION_WORLD = WORLD_A;
const REFERENCE_INFORMATION_OBSERVATION = buildCompositeObservation({
  schema: COMPOSITE_OBSERVATION_SCHEMA_ID,
  chain: REFERENCE_CHAIN_OBSERVATION,
  information: {
    worlds: [{
      world: REFERENCE_INFORMATION_WORLD,
      entries: [{
        requestKey: "GET /status",
        responseDigest: `sha256:${"c".repeat(64)}`,
      }],
      requestKeyEquivalence: "equivalent",
      missPolicyObservation: {
        requestKey: "MISS",
        responseDigest: `sha256:${"d".repeat(64)}`,
      },
    }],
    budget: { requests: 1, bytes: 128, enforced: true },
  },
}).information;

type CompositeScenario =
  | "chain-only-stable"
  | "colliding-origins"
  | "component-needs-network"
  | "information-worlds-without-runtime"
  | "one-information-world";

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

function asPrefixedDigest(digest: string): `sha256:${string}` {
  return digest as `sha256:${string}`;
}

function buildMaterializationReport(
  record: ChainEnvironmentRecord,
  networkPolicy: NetworkPolicy,
  loadedResources: readonly `sha256:${string}`[],
  egressSucceeded = false,
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
      egressAttempts: egressSucceeded
        ? [{ target: "https://example.test/upstream", outcome: "succeeded" as const }]
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

function createStubArtifactStore(
  extras: ReadonlyMap<Sha256Digest, Uint8Array> = new Map(),
): ArtifactStore & { stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  const byDigest = new Map<string, Uint8Array>(extras);
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

function compositeArtifactExtras(composite: CryptoEnvironmentRecord): Map<Sha256Digest, Uint8Array> {
  const extras = new Map<Sha256Digest, Uint8Array>();
  const chainRecord = buildConformanceChainRecord();
  const chainBytes = sealChainEnvironmentRecord(chainRecord);
  const chainDigest = chainEnvironmentRecordDigest(chainBytes);
  extras.set(chainDigest, chainBytes);
  for (const world of composite.informationWorlds) {
    const artifact = stubArtifactBytes({ id: world.id });
    extras.set(embeddedRecordDigestFromComposite(world.record.digest), artifact.bytes);
  }
  for (const runtime of composite.serviceRuntimes) {
    const artifact = stubArtifactBytes({ id: runtime.id });
    extras.set(asPrefixedDigest(runtime.image.manifestDigest), artifact.bytes);
  }
  return extras;
}

function embeddedRecordDigestFromComposite(
  digest: { readonly sha256?: string } | undefined,
): Sha256Digest {
  if (digest?.sha256 === undefined) {
    throw new Error("embedded record digest is missing");
  }
  return asPrefixedDigest(`sha256:${digest.sha256}`);
}

interface StubRuntime extends ChainRuntime {
  readonly materializeRequests: MaterializationRequest[];
  stopCount: number;
}

function createStubRuntime(options: {
  readonly egressSucceeded?: boolean;
}): StubRuntime {
  const materializeRequests: MaterializationRequest[] = [];
  const counters = { stopCount: 0 };
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
          options.egressSucceeded ?? false,
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
          observation: REFERENCE_CHAIN_OBSERVATION,
          observationDigest: chainObservationDigest(REFERENCE_CHAIN_OBSERVATION),
          timedOut: false,
          cost: { wallSeconds: 0 },
        };
      },
    },
  };
  return runtime;
}

function createStubInformationRuntime(): InformationWorldRuntime {
  return {
    async serve() {
      return {
        observation: REFERENCE_INFORMATION_OBSERVATION,
        egressAttempts: [],
      };
    },
  };
}

function stubArtifactBytes(payload: Record<string, unknown>): {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
} {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return { bytes, digest: recordDigest(bytes) };
}

function informationWorldComponent(id: string, name: string) {
  const artifact = stubArtifactBytes({ id });
  return {
    world: {
      id,
      kind: "https://jinn.network/records/information-world/1.0",
      record: {
        name,
        digest: { sha256: artifact.digest.slice("sha256:".length) },
      },
    },
    artifact,
  };
}

function serviceRuntimeComponent(id: string) {
  const artifact = stubArtifactBytes({ id });
  return {
    runtime: {
      id,
      family: "http-replay",
      version: "0.2.0",
      image: {
        manifestDigest: artifact.digest,
        platform: "linux/amd64",
      },
    },
    artifact,
  };
}
function buildCollidingOriginsComposite(): CryptoEnvironmentRecord {
  const worldA = informationWorldComponent("world-a", "a");
  const worldB = informationWorldComponent("world-b", "b");
  const base = buildConformanceCompositeRecord();
  return {
    ...base,
    informationWorlds: [worldA.world, worldB.world],
    composition: {
      ...base.composition,
      endpointAllowlist: ["https://api.llama.fi"],
      originRouting: [
        { origin: "https://api.llama.fi", worldId: "world-a", precedence: 0 },
        { origin: "https://api.llama.fi", worldId: "world-b", precedence: 0 },
      ],
      requestBudget: { maxRequests: 10, maxResponseBytes: 1024 },
    },
  } as CryptoEnvironmentRecord;
}

function buildOneInformationWorldComposite(): CryptoEnvironmentRecord {
  const worldA = informationWorldComponent("world-a", "a");
  const replay = serviceRuntimeComponent("replay");
  const base = buildConformanceCompositeRecord();
  return {
    ...base,
    informationWorlds: [worldA.world],
    serviceRuntimes: [replay.runtime],
    composition: {
      endpointAllowlist: ["https://api.llama.fi"],
      missPolicy: { mode: "declared-response", status: 404 },
      originRouting: [
        { origin: "https://api.llama.fi", worldId: "world-a", precedence: 0 },
      ],
      requestBudget: { maxRequests: 10, maxResponseBytes: 1024 },
    },
  } as CryptoEnvironmentRecord;
}

async function runComposite(options: { readonly kind: CompositeScenario }): Promise<SealedAttestation> {
  const runtime = createStubRuntime({
    egressSucceeded: options.kind === "component-needs-network",
  });
  let composite: CryptoEnvironmentRecord;
  let informationRuntime: InformationWorldRuntime | undefined;

  switch (options.kind) {
    case "chain-only-stable":
      composite = buildConformanceCompositeRecord();
      break;
    case "colliding-origins":
      composite = buildCollidingOriginsComposite();
      informationRuntime = createStubInformationRuntime();
      break;
    case "component-needs-network":
      composite = buildConformanceCompositeRecord();
      break;
    case "information-worlds-without-runtime":
      composite = buildOneInformationWorldComposite();
      informationRuntime = undefined;
      break;
    case "one-information-world":
      composite = buildOneInformationWorldComposite();
      informationRuntime = createStubInformationRuntime();
      break;
  }

  const artifactStore = createStubArtifactStore(compositeArtifactExtras(composite));
  return verifyCryptoEnvironment(
    {
      runtime,
      artifactStore,
      signer,
      clock: createFixedClock(),
      verifier: VERIFIER,
      ...(informationRuntime === undefined ? {} : { informationRuntime }),
    },
    composite,
    { networkPolicy: DEFAULT_BLACKHOLE_POLICY },
  );
}

describe("origin routing", () => {
  it("finds no collision when precedence is declared", () => {
    expect(assessOriginRouting([
      { origin: "api.llama.fi", world: WORLD_A, precedence: 0 },
      { origin: "api.llama.fi", world: WORLD_B, precedence: 1 },
    ])).toEqual([]);
  });

  it("calls two worlds at one origin with equal precedence a collision", () => {
    // Design §4.4: two corpora claiming one origin is a repeatability hazard, not a merge.
    expect(assessOriginRouting([
      { origin: "api.llama.fi", world: WORLD_A, precedence: 0 },
      { origin: "api.llama.fi", world: WORLD_B, precedence: 0 },
    ])).toEqual([{ origin: "api.llama.fi", worlds: [WORLD_A, WORLD_B] }]);
  });

  it("is order-insensitive and reports worlds in code-unit order", () => {
    const forward = assessOriginRouting([
      { origin: "x.test", world: WORLD_B, precedence: 0 },
      { origin: "x.test", world: WORLD_A, precedence: 0 },
    ]);
    expect(forward).toEqual([{ origin: "x.test", worlds: [WORLD_A, WORLD_B] }]);
  });
});

describe("verifyCryptoEnvironment", () => {
  it("attests a chain-only composite closed-reproducible", async () => {
    const attestation = await runComposite({ kind: "chain-only-stable" });
    const { predicate } = attestation.statement;
    expect(predicate.scope).toBe("composite");
    expect(predicate.outcome).toBe("closed-reproducible");
    expect(predicate.composition?.collisions).toEqual([]);
    expect(predicate.composition?.wholeWorldOfflineBoot).toBe(true);
    expect(predicate.composition?.components.filter((one) => one.role === "chain-world"))
      .toHaveLength(1);
    expect(predicate.runs?.count).toBe(5);
  });

  it("does not substitute for its components' attestations", async () => {
    const attestation = await runComposite({ kind: "chain-only-stable" });
    const chainWorld = attestation.statement.predicate.composition!.components[0]!
      .record as Sha256Digest;
    // The composite's subject[0] is the composite; the chain world is subject[1] and can never
    // satisfy a component match (design §5.1 step 6).
    expect(attestationMatchesRecord(attestation.statement, chainWorld)).toBe(false);
    expect(requiresComponentAttestations(attestation.statement)).toContain(chainWorld);
  });

  it("attests capability-mismatch for colliding origins", async () => {
    const { predicate } = (await runComposite({ kind: "colliding-origins" })).statement;
    expect(predicate.outcome).toBe("capability-mismatch");
    expect(predicate.failure?.reason).toBe("origin-routing-collision");
    expect(predicate.composition?.collisions).toHaveLength(1);
  });

  it("attests offline-dependency-detected when a component cannot boot offline", async () => {
    const { predicate } = (await runComposite({ kind: "component-needs-network" })).statement;
    expect(predicate.outcome).toBe("offline-dependency-detected");
    expect(predicate.composition?.wholeWorldOfflineBoot).toBe(false);
  });

  it("fails closed when information worlds are composed with no information runtime", async () => {
    const { predicate } = (await runComposite({
      kind: "information-worlds-without-runtime",
    })).statement;
    expect(predicate.outcome).toBe("verification-infrastructure-failure");
    expect(predicate.failure?.reason).toBe("information-runtime-absent");
  });

  it("covers both planes in the K-run observation when a world is composed", async () => {
    const { predicate } = (await runComposite({ kind: "one-information-world" })).statement;
    expect(predicate.runs?.count).toBe(5);
    expect(predicate.composition?.components.some((one) => one.role === "information-world"))
      .toBe(true);
    // The composite observation spans chain + information; its digest is what the K runs
    // compared, so a corpus that answered differently on run 3 is a probe-divergence.
    expect(predicate.runs?.allObservationsEqual).toBe(true);
  });
});
