// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const { verifyChainEnvironmentMock, setDefaultVerify, restoreVerify } = vi.hoisted(() => {
  let defaultImpl: (
    ...args: Parameters<typeof import("@jinn-network/chain-environment-verification").verifyChainEnvironment>
  ) => ReturnType<typeof import("@jinn-network/chain-environment-verification").verifyChainEnvironment>;
  const mock = vi.fn();
  return {
    verifyChainEnvironmentMock: mock,
    setDefaultVerify: (
      impl: typeof defaultImpl,
    ) => {
      defaultImpl = impl;
      mock.mockImplementation(impl);
    },
    restoreVerify: () => {
      mock.mockImplementation(defaultImpl);
    },
  };
});

vi.mock("@jinn-network/chain-environment-verification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jinn-network/chain-environment-verification")>();
  setDefaultVerify(actual.verifyChainEnvironment);
  return {
    ...actual,
    verifyChainEnvironment: verifyChainEnvironmentMock,
  };
});

import type {
  ChainEnvironmentRecord,
  ChainInstance,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
  ScriptReplayer,
} from "@jinn-network/chain-environment-record";
import { BLACKHOLE_EGRESS_POLICY_ID } from "@jinn-network/chain-environment-record";
import * as chainVerification from "@jinn-network/chain-environment-verification";
import { CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE } from "@jinn-network/chain-environment-verification";
import { createRequire } from "node:module";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { recordDigest, type DsseSigner, type Sha256Digest } from "@jinn-network/trust-core";

import type { AnchorCapture } from "./anchor.js";
import type { ConnectedBaseline, ExtractionRequest } from "./baseline.js";
import { assembleCandidate } from "./candidate.js";
import { createBudgetedArchivePort } from "./budget.js";
import {
  buildCoverageArtifacts,
  collectSourceProofs,
} from "./coverage.js";
import { extractEnvironment } from "./extract.js";
import { BASELINE_RUN_COUNT } from "./identifiers.js";
import { keySetIsEmpty } from "./key-set.js";
import { normalizeAddress, normalizeHex32, normalizeSlot } from "./hex.js";
import type { ArchiveRpcPort, ExtractionDeps, VerifierIdentity } from "./ports.js";
import {
  buildFakeTrieWorld,
  fakeStateArtifact,
  FAKE_ACTOR,
  FAKE_ORACLE,
  FAKE_POOL,
  FAKE_SLOT_1,
  FAKE_SLOT_2,
} from "./testing.js";
import { widenAndReverify } from "./widen.js";

const require = createRequire(import.meta.url);
const { buildConformanceChainRecord, conformanceArtifactBytes } = require(
  "../../chain-verification/dist/conformance-records.js",
) as {
  buildConformanceChainRecord: (options?: { closureClass?: "archive-dependent" }) => ChainEnvironmentRecord;
  conformanceArtifactBytes: (name: string) => Uint8Array;
};

const VERIFIER: VerifierIdentity = {
  id: "jinn.chain-state-extraction/widen",
  version: "0.0.0",
  digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
};

const eoa = createEoaTestSigner("chain-extraction-widen-suite");
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

function observationFor(
  world: ReturnType<typeof buildFakeTrieWorld>,
  commitment?: `0x${string}`,
): chainVerification.CanonicalChainObservation {
  const draft = closedStateDraft();
  return chainVerification.buildCanonicalChainObservation({
    schema: chainVerification.CHAIN_OBSERVATION_SCHEMA_ID,
    probes: [],
    touchedState: [],
    stateReads: [],
    traceProjectionDigest: `sha256:${"5".repeat(64)}`,
    finalStateCommitment: commitment ?? draft.stateMaterialization.initialStateCommitment as `0x${string}`,
    blocks: [{
      number: "1",
      hash: `0x${"1".repeat(64)}`,
      stateRoot: world.stateRoot,
      timestamp: "1",
    }],
  });
}

function wrongObservation(world: ReturnType<typeof buildFakeTrieWorld>): chainVerification.CanonicalChainObservation {
  return observationFor(world, `0x${"d".repeat(64)}`);
}

function makeAttestation(
  outcome: chainVerification.ChainVerificationOutcome,
  observation: chainVerification.CanonicalChainObservation,
): chainVerification.SealedAttestation {
  return {
    envelopeBytes: new Uint8Array(),
    payloadBytes: new Uint8Array(),
    attestationDigest: `sha256:${"e".repeat(64)}`,
    statement: { predicateType: CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE } as never,
    outcome,
    instanceIds: ["closed-0"],
    observations: [observation],
  };
}

function createWidenStubRuntime(
  observation: chainVerification.CanonicalChainObservation,
  options: {
    readonly localizeReads?: "default" | "pool-then-oracle";
  } = {},
): ExtractionDeps["runtime"] {
  let connectedMaterializations = 0;
  return {
    materializer: {
      async materialize(request: MaterializationRequest) {
        if (request.stateBackend !== undefined) {
          connectedMaterializations += 1;
          const blockNumber = request.record.sourceAnchor?.blockNumber ?? 1;
          await request.stateBackend.getBlockHeader(blockNumber);
          const pool = normalizeAddress(FAKE_POOL);
          await request.stateBackend.getAccount(pool, blockNumber);
          await request.stateBackend.getCode(pool, blockNumber);
          await request.stateBackend.getStorageAt(pool, normalizeSlot(FAKE_SLOT_1), blockNumber);
          await request.stateBackend.getStorageAt(pool, normalizeSlot(FAKE_SLOT_2), blockNumber);
          if (
            options.localizeReads === "pool-then-oracle"
            && connectedMaterializations > BASELINE_RUN_COUNT + 1
          ) {
            const oracle = normalizeAddress(FAKE_ORACLE);
            await request.stateBackend.getAccount(oracle, blockNumber);
            await request.stateBackend.getCode(oracle, blockNumber);
            await request.stateBackend.getStorageAt(oracle, normalizeSlot(FAKE_SLOT_1), blockNumber);
          }
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
      return {
        status: "replayed",
        observation: {},
        observationDigest: `sha256:${"f".repeat(64)}`,
        reportedValues: {},
      };
    },
  };
}

function extractionRequest(draft: ChainEnvironmentRecord): ExtractionRequest {
  return {
    draft,
    anchorBlockNumber: 1,
    fidelityClass: "anchored-subset",
    sourceAddresses: [FAKE_POOL],
    fixtureDeclarations: [{ address: FAKE_ACTOR, kind: "account" }],
    finalityPolicy: "finalized",
    budget: { maxCalls: 500, maxBytes: 5_000_000 },
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

async function extractCandidate(deps: ExtractionDeps) {
  const result = await extractEnvironment(deps, extractionRequest(closedStateDraft()));
  if (result.status === "failed") {
    throw new Error(`${result.reason} @ ${result.stage}: ${result.detail}`);
  }
  return { candidate: result.candidate, request: extractionRequest(closedStateDraft()) };
}

async function actorOnlyCandidate(
  deps: Pick<ExtractionDeps, "artifactStore">,
  baseline: ConnectedBaseline,
  request: ExtractionRequest,
  world: ReturnType<typeof buildFakeTrieWorld>,
) {
  const full = fakeStateArtifact(world.stateRoot);
  const artifact = {
    ...full,
    accounts: full.accounts.filter((account) => account.address === normalizeAddress(FAKE_ACTOR)),
  };
  const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 500, maxBytes: 5_000_000 });
  const proofs = await collectSourceProofs(archive, artifact, {
    addresses: [],
    stateRoot: world.stateRoot,
  });
  if (!proofs.ok) throw new Error(proofs.detail);
  const coverage = buildCoverageArtifacts({
    artifact,
    fidelityClass: "anchored-subset",
    bundle: proofs.value,
    declarations: request.fixtureDeclarations,
  });
  if (!coverage.ok) throw new Error(coverage.detail);
  const outcome = await assembleCandidate(deps, {
    request,
    anchor: testAnchor(world),
    baseline,
    artifact,
    coverage: coverage.value,
    initialStateCommitment: `0x${"a".repeat(64)}`,
  });
  if (!outcome.ok) throw new Error(outcome.detail);
  return outcome.value;
}

afterEach(() => {
  restoreVerify();
});

describe("widenAndReverify", () => {
  it("converges on the first pass", async () => {
    const world = buildFakeTrieWorld();
    const baselineObservation = observationFor(world);
    const deps = extractionDeps(createWidenStubRuntime(baselineObservation));
    const { candidate, request } = await extractCandidate(deps);

    verifyChainEnvironmentMock.mockResolvedValue(
      makeAttestation("closed-reproducible", candidate.baseline.observation),
    );

    const result = await widenAndReverify(deps, { candidate, request });
    expect(verifyChainEnvironmentMock).toHaveBeenCalled();
    expect(result.status).toBe("converged");
    if (result.status !== "converged") return;
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.matchedBaseline).toBe(true);
    expect(result.attestation.outcome).toBe("closed-reproducible");
  });

  it("converges after two widenings with distinct record digests", async () => {
    const world = buildFakeTrieWorld();
    const baselineObservation = observationFor(world);
    const deps = extractionDeps(
      createWidenStubRuntime(baselineObservation, { localizeReads: "pool-then-oracle" }),
      world.archive(),
    );
    const extracted = await extractCandidate(deps);
    const candidate = await actorOnlyCandidate(
      deps,
      extracted.candidate.baseline,
      extracted.request,
      world,
    );
    const startDigest = candidate.recordDigest;

    let verifyCalls = 0;
    verifyChainEnvironmentMock.mockImplementation(async () => {
      verifyCalls += 1;
      if (verifyCalls <= 2) {
        return makeAttestation("closed-reproducible", wrongObservation(world));
      }
      return makeAttestation("closed-reproducible", baselineObservation);
    });

    const result = await widenAndReverify(deps, { candidate, request: extracted.request }, {
      maxWidenings: 2,
    });
    expect(result.status).toBe("converged");
    if (result.status !== "converged") return;
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds[0]!.widenedBy).toBeDefined();
    expect(result.rounds[1]!.widenedBy).toBeDefined();
    expect(keySetIsEmpty(result.rounds[0]!.widenedBy!)).toBe(false);
    expect(keySetIsEmpty(result.rounds[1]!.widenedBy!)).toBe(false);
    expect(result.candidate.recordDigest).not.toBe(startDigest);
  });

  it("terminates at the bound with archive usage under the ceiling", async () => {
    const world = buildFakeTrieWorld();
    const baselineObservation = observationFor(world);
    const deps = extractionDeps(
      createWidenStubRuntime(baselineObservation),
      world.archive(),
    );
    const extracted = await extractCandidate(deps);
    const candidate = await actorOnlyCandidate(
      deps,
      extracted.candidate.baseline,
      extracted.request,
      world,
    );

    verifyChainEnvironmentMock.mockResolvedValue(
      makeAttestation("initial-state-mismatch", wrongObservation(world)),
    );

    const result = await widenAndReverify(deps, { candidate, request: extracted.request }, {
      maxWidenings: 1,
      budget: { maxCalls: 500, maxBytes: 5_000_000 },
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("widen-bound-exhausted");
    expect(result.archiveUsage.calls).toBeLessThan(result.archiveUsage.limits.maxCalls);
    expect(result.archiveUsage.bytes).toBeLessThan(result.archiveUsage.limits.maxBytes);
  });

  it("maps probe-divergence to divergence-unexplained without archive calls", async () => {
    const world = buildFakeTrieWorld();
    const deps = extractionDeps(createWidenStubRuntime(observationFor(world)));
    const { candidate, request } = await extractCandidate(deps);

    verifyChainEnvironmentMock.mockResolvedValue(
      makeAttestation("probe-divergence", wrongObservation(world)),
    );

    const result = await widenAndReverify(deps, { candidate, request });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("divergence-unexplained");
    expect(result.archiveUsage.calls).toBe(0);
  });

  it("terminates with no out-of-slice read detail when localization finds nothing", async () => {
    const world = buildFakeTrieWorld();
    const deps = extractionDeps(
      createWidenStubRuntime(observationFor(world)),
    );
    const { candidate, request } = await extractCandidate(deps);

    const divergent = wrongObservation(world);
    verifyChainEnvironmentMock.mockResolvedValue(
      makeAttestation("closed-reproducible", divergent),
    );

    const result = await widenAndReverify(deps, { candidate, request });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toBe("divergence-unexplained");
    expect(result.detail).toMatch(/no out-of-slice read/u);
  });

  it("carries CE3 attestation without surfacing closed-reproducible in the result", async () => {
    const world = buildFakeTrieWorld();
    const baselineObservation = observationFor(world);
    const deps = extractionDeps(createWidenStubRuntime(baselineObservation));
    const { candidate, request } = await extractCandidate(deps);

    verifyChainEnvironmentMock.mockResolvedValue(
      makeAttestation("closed-reproducible", candidate.baseline.observation),
    );

    const result = await widenAndReverify(deps, { candidate, request });
    expect(result.status).toBe("converged");
    if (result.status !== "converged") return;
    expect(result.attestation.outcome).toBe("closed-reproducible");
    expect("outcome" in result).toBe(false);
    expect(result.attestation.outcome).toBe("closed-reproducible");
  });
});
