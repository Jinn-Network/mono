// SPDX-License-Identifier: Apache-2.0

// The published conformance kit. `node:fs/promises` appears here (fixture loading only) and
// is allowlisted for this file in the tree guard.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  ChainEnvironmentRecord,
  ChainStateBackend,
  CryptoEnvironmentRecord,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
} from "@jinn-network/chain-environment-record";
import {
  chainEnvironmentRecordDigest,
  sealChainEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import {
  DSSE_PAYLOAD_TYPE,
  canonicalJsonBytes,
  dssePreAuthEncoding,
  parseDsseEnvelope,
  recordDigest,
  type DsseSigner,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { observeArchiveEnvironment } from "./archive.js";
import { verifyCryptoEnvironment } from "./composite.js";
import {
  buildConformanceChainRecord,
  buildConformanceCompositeRecord,
  CONFORMANCE_COUNTERPARTY_ACCOUNT,
  CONFORMANCE_PROTOCOL_ACCOUNT_A,
  CONFORMANCE_PROTOCOL_SLOT_1,
  conformanceArtifactBytes,
  conformanceSourceProofManifest,
} from "./conformance-records.js";
import { fromDigestSet, type DigestSet } from "./digests.js";
import { CHAIN_OBSERVATION_SCHEMA_ID } from "./identifiers.js";
import {
  buildCanonicalChainObservation,
  chainObservationDigest,
  type CanonicalChainObservation,
} from "./observation.js";
import { isRunBearingOutcome } from "./outcomes.js";
import {
  DEFAULT_BLACKHOLE_POLICY,
  type ArtifactStore,
  type ChainRuntime,
  type Clock,
  type InformationWorldRuntime,
} from "./ports.js";
import type {
  ChainEnvironmentVerificationPredicate,
  VerifierIdentity,
} from "./predicate.js";
import {
  attestationMatchesRecord,
  parseChainEnvironmentVerificationStatement,
  requiresComponentAttestations,
} from "./statement.js";
import { verifyChainEnvironment, type SealedAttestation } from "./verify.js";

export const CHAIN_CONFORMANCE_SCENARIOS = [
  "sealed-stable",
  "fork-backend-refusal",
  "divergent-on-run-3",
  "artifact-unavailable",
  "upstream-fetch-succeeds",
  "coverage-incomplete",
  "composite-chain-only",
  "composite-colliding-origins",
] as const;
export type ScriptedChainScenario = (typeof CHAIN_CONFORMANCE_SCENARIOS)[number];

export const CONFORMANCE_VERIFIER_IDENTITY: VerifierIdentity = Object.freeze({
  id: "https://jinn.network/chain-environment-verification/conformance-verifier",
  version: "0.1.0",
  digest: `sha256:${"7".repeat(64)}`,
}) as VerifierIdentity;

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

export interface ScriptedChainRuntime extends ChainRuntime {
  /** Instance ids handed out, in run order. Distinct ids prove each run was its own
   * materialization rather than a snapshot revert. */
  readonly instanceIds: readonly string[];
  readonly materializeRequests: readonly { readonly networkPolicy: NetworkPolicy }[];
  readonly stopCount: number;
}

function asPrefixedDigest(digest: string): `sha256:${string}` {
  return digest as `sha256:${string}`;
}

function recordForScenario(scenario: ScriptedChainScenario): ChainEnvironmentRecord {
  if (scenario === "coverage-incomplete") {
    return buildConformanceChainRecord({ fidelityClass: "anchored-subset" });
  }
  return buildConformanceChainRecord();
}

function artifactNamesForRecord(record: ChainEnvironmentRecord): string[] {
  const names = ["materializer", "probe-suite", "comparator", "state-artifact"];
  if (record.stateMaterialization.sourceProofManifest !== undefined) {
    names.push("source-proof-manifest");
  }
  if (record.stateMaterialization.fixtureCoverage?.manifest !== undefined) {
    names.push("fixture-coverage-manifest");
  }
  if (record.sourceAnchor?.headerProof !== undefined) {
    names.push("header-proof");
  }
  record.fixtures.modules.forEach((module, index) => {
    names.push(`fixture-${index}-${module.id}`);
  });
  return names;
}

function anchoredArtifactEntries(complete: boolean) {
  const entries = {
    accounts: [
      CONFORMANCE_PROTOCOL_ACCOUNT_A,
      "0x00000000000000000000000000000000000000bb",
      CONFORMANCE_COUNTERPARTY_ACCOUNT,
    ],
    codeEntries: [CONFORMANCE_PROTOCOL_ACCOUNT_A],
    storageSlots: [
      { address: CONFORMANCE_PROTOCOL_ACCOUNT_A, slot: CONFORMANCE_PROTOCOL_SLOT_1 },
      { address: "0x00000000000000000000000000000000000000bb", slot: `0x${"0".repeat(63)}2` },
    ],
  };
  if (!complete) {
    entries.storageSlots = [
      ...entries.storageSlots,
      { address: "0x00000000000000000000000000000000000000bb", slot: `0x${"0".repeat(63)}9` },
    ];
  }
  return entries;
}

function buildMaterializationReport(
  record: ChainEnvironmentRecord,
  networkPolicy: NetworkPolicy,
  loadedResources: readonly `sha256:${string}`[],
  scenario: ScriptedChainScenario,
): MaterializationReport {
  const controls = record.determinismControls;
  const anchored = record.stateMaterialization.fidelityClass !== "local";
  const artifactEntries = anchored
    ? anchoredArtifactEntries(scenario !== "coverage-incomplete")
    : { accounts: [], codeEntries: [], storageSlots: [] };

  const isolation: MaterializationReport["isolation"] = {
    networkPolicy,
    egressAttempts: scenario === "upstream-fetch-succeeds"
      ? [{ target: "https://archive.example/rpc", outcome: "succeeded" as const }]
      : networkPolicy.forkBackend === "present"
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
  };

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
    artifactEntries,
    postFixtureCommitment: record.stateMaterialization.initialStateCommitment as `0x${string}`,
    loadedResources: [...loadedResources],
    isolation,
    cost: { wallSeconds: 0 },
  };
}

function networkPolicyForScenario(scenario: ScriptedChainScenario): NetworkPolicy {
  if (scenario === "fork-backend-refusal") {
    return { ...DEFAULT_BLACKHOLE_POLICY, forkBackend: "present" };
  }
  return DEFAULT_BLACKHOLE_POLICY;
}

/** A fake chain runtime with scripted observations. It touches nothing. */
export function createScriptedChainRuntime(
  scenario: ScriptedChainScenario,
): ScriptedChainRuntime {
  const materializeRequests: MaterializationRequest[] = [];
  const instanceIds: string[] = [];
  const counters = { stopCount: 0 };
  const referenceObservation = buildCanonicalChainObservation(REFERENCE_OBSERVATION_RAW);
  const divergentObservation = buildCanonicalChainObservation(DIVERGENT_OBSERVATION_RAW);
  let runIndex = 0;

  return {
    get instanceIds() {
      return instanceIds;
    },
    get materializeRequests() {
      return materializeRequests;
    },
    get stopCount() {
      return counters.stopCount;
    },
    materializer: {
      async materialize(request) {
        materializeRequests.push(request);
        instanceIds.push(request.instanceId);
        const loadedResources = [...request.resources.byDigest.keys()];
        const report = buildMaterializationReport(
          request.record,
          request.networkPolicy,
          loadedResources,
          scenario,
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
        const index = runIndex;
        runIndex += 1;
        let observation: CanonicalChainObservation = referenceObservation;
        if (scenario === "divergent-on-run-3" && index === 2) {
          observation = divergentObservation;
        }
        return {
          observation,
          observationDigest: chainObservationDigest(observation),
          timedOut: false,
          cost: { wallSeconds: 0 },
        };
      },
    },
  };
}

export interface InMemoryArtifactStore extends ArtifactStore {
  readonly artifacts: ReadonlyMap<Sha256Digest, Uint8Array>;
}

export function createInMemoryArtifactStore(
  options?: { readonly missing?: readonly Sha256Digest[] },
): InMemoryArtifactStore {
  const artifacts = new Map<Sha256Digest, Uint8Array>();
  const missing = new Set(options?.missing ?? []);
  const record = buildConformanceChainRecord();
  const byDigest = new Map<string, Uint8Array>();
  for (const name of artifactNamesForRecord(record)) {
    const bytes = conformanceArtifactBytes(name);
    byDigest.set(recordDigest(bytes), bytes);
  }
  return {
    artifacts,
    async getArtifact(descriptor) {
      const digest = fromDigestSet(descriptor.digest);
      if (missing.has(digest)) {
        throw new Error(`artifact unavailable for ${digest}`);
      }
      const bytes = byDigest.get(digest);
      if (bytes === undefined) {
        throw new Error(`artifact unavailable for ${digest}`);
      }
      return bytes;
    },
    async putArtifact(bytes) {
      const digest = recordDigest(bytes);
      artifacts.set(digest, bytes);
      return { digest, size: bytes.length };
    },
  };
}

function createScenarioArtifactStore(
  scenario: ScriptedChainScenario,
  record: ChainEnvironmentRecord,
): InMemoryArtifactStore {
  const missing: Sha256Digest[] = [];
  if (scenario === "artifact-unavailable" && record.stateMaterialization.stateArtifact !== undefined) {
    missing.push(fromDigestSet(
      record.stateMaterialization.stateArtifact.descriptor.digest as DigestSet,
    ));
  }
  const store = createInMemoryArtifactStore({ missing });
  if (scenario === "coverage-incomplete") {
    const manifestBytes = canonicalJsonBytes(conformanceSourceProofManifest());
    const manifestDigest = fromDigestSet(
      record.stateMaterialization.sourceProofManifest!.proofs.digest as DigestSet,
    );
    const byDigest = new Map<string, Uint8Array>();
    for (const name of artifactNamesForRecord(record)) {
      const bytes = conformanceArtifactBytes(name);
      byDigest.set(recordDigest(bytes), bytes);
    }
    byDigest.set(manifestDigest, manifestBytes);
    return {
      ...store,
      async getArtifact(descriptor) {
        const digest = fromDigestSet(descriptor.digest);
        if (missing.includes(digest)) {
          throw new Error(`artifact unavailable for ${digest}`);
        }
        const bytes = byDigest.get(digest);
        if (bytes === undefined) {
          throw new Error(`artifact unavailable for ${digest}`);
        }
        return bytes;
      },
    };
  }
  return store;
}

/** Yields the window's start, then its end, then repeats the end. */
export function createFixedClock(
  startedAt = "2026-07-31T09:00:00.000Z",
  endedAt = "2026-07-31T09:04:00.000Z",
): Clock {
  const instants = [new Date(startedAt), new Date(endedAt)];
  let index = 0;
  return { now: () => instants[Math.min(index++, instants.length - 1)]! };
}

function stubArtifactBytes(payload: Record<string, unknown>): {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
} {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return { bytes, digest: recordDigest(bytes) };
}

function embeddedRecordDigestFromComposite(
  digest: { readonly sha256?: string } | undefined,
): Sha256Digest {
  if (digest?.sha256 === undefined) {
    throw new Error("embedded record digest is missing");
  }
  return asPrefixedDigest(`sha256:${digest.sha256}`);
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

function createStubInformationRuntime(): InformationWorldRuntime {
  return {
    async serve() {
      return {
        observation: { worlds: [], budget: { requests: 0, bytes: 0, enforced: true } },
        egressAttempts: [],
      };
    },
  };
}

function createCompositeArtifactStore(composite: CryptoEnvironmentRecord): InMemoryArtifactStore {
  const extras = compositeArtifactExtras(composite);
  const stored = new Map<Sha256Digest, Uint8Array>();
  const byDigest = new Map<string, Uint8Array>(extras);
  for (const name of artifactNamesForRecord(buildConformanceChainRecord())) {
    const bytes = conformanceArtifactBytes(name);
    byDigest.set(recordDigest(bytes), bytes);
  }
  return {
    artifacts: stored,
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

function createArchiveStubBackend(): ChainStateBackend {
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

function archiveConformanceArtifactNames(): string[] {
  const record = buildConformanceChainRecord({ closureClass: "archive-dependent" });
  const names = ["materializer", "probe-suite", "comparator", "state-artifact"];
  record.fixtures.modules.forEach((module, index) => {
    names.push(`fixture-${index}-${module.id}`);
  });
  return names;
}

function createArchiveConformanceArtifactStore(): InMemoryArtifactStore {
  const byDigest = new Map<string, Uint8Array>();
  for (const name of archiveConformanceArtifactNames()) {
    const bytes = conformanceArtifactBytes(name);
    byDigest.set(recordDigest(bytes), bytes);
  }
  const stored = new Map<Sha256Digest, Uint8Array>();
  return {
    artifacts: stored,
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

function buildArchiveConformanceMaterializationReport(
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

function createArchiveStubRuntime(): ChainRuntime {
  const canonicalObservation = buildCanonicalChainObservation(REFERENCE_OBSERVATION_RAW);
  const materializeRequests: MaterializationRequest[] = [];
  const archiveNetworkPolicy = {
    egress: "denied" as const,
    dns: "absent" as const,
    archiveRpc: "unreachable" as const,
    forkBackend: "present" as const,
  };

  return {
    materializer: {
      async materialize(request) {
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
        const report = buildArchiveConformanceMaterializationReport(
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
        return {
          observation: canonicalObservation,
          observationDigest: chainObservationDigest(canonicalObservation),
          timedOut: false,
          cost: { wallSeconds: 0 },
        };
      },
    },
  };
}

/** Produces the archive-observed predicate frozen in `fixtures/predicate-v1/`. */
export async function runArchiveObservedGolden(
  signer: DsseSigner,
): Promise<ChainEnvironmentVerificationPredicate> {
  const attestation = await observeArchiveEnvironment(
    {
      runtime: createArchiveStubRuntime(),
      artifactStore: createArchiveConformanceArtifactStore(),
      signer,
      clock: createFixedClock(),
      verifier: CONFORMANCE_VERIFIER_IDENTITY,
    },
    buildConformanceChainRecord({ closureClass: "archive-dependent" }),
    {
      providers: [
        { id: "provider-a", stateBackend: createArchiveStubBackend() },
        { id: "provider-b", stateBackend: createArchiveStubBackend() },
      ],
    },
  );
  return attestation.statement.predicate;
}

async function executeScenario(
  scenario: ScriptedChainScenario,
  runtime: ScriptedChainRuntime,
  signer: DsseSigner,
): Promise<SealedAttestation> {
  const clock = createFixedClock();
  const deps = {
    runtime,
    signer,
    clock,
    verifier: CONFORMANCE_VERIFIER_IDENTITY,
  };

  if (scenario === "composite-chain-only") {
    const composite = buildConformanceCompositeRecord();
    return verifyCryptoEnvironment(
      { ...deps, artifactStore: createCompositeArtifactStore(composite) },
      composite,
      { networkPolicy: networkPolicyForScenario(scenario) },
    );
  }

  if (scenario === "composite-colliding-origins") {
    const composite = buildCollidingOriginsComposite();
    return verifyCryptoEnvironment(
      {
        ...deps,
        artifactStore: createCompositeArtifactStore(composite),
        informationRuntime: createStubInformationRuntime(),
      },
      composite,
      { networkPolicy: networkPolicyForScenario(scenario) },
    );
  }

  const record = recordForScenario(scenario);
  return verifyChainEnvironment(
    { ...deps, artifactStore: createScenarioArtifactStore(scenario, record) },
    record,
    { networkPolicy: networkPolicyForScenario(scenario) },
  );
}

export async function runConformanceScenario(
  scenario: ScriptedChainScenario,
  signer: DsseSigner,
): Promise<SealedAttestation> {
  return executeScenario(scenario, createScriptedChainRuntime(scenario), signer);
}

export type GoldenStatementName = ScriptedChainScenario;

export async function loadGoldenStatement(name: GoldenStatementName): Promise<unknown> {
  const path = fileURLToPath(
    new URL(`attestations-v1/${name}.json`, new URL("../fixtures/", import.meta.url)),
  );
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export interface DsseSignatureCheck {
  /** Re-derived by the kit from the sealed envelope, never taken on trust. */
  readonly preAuthEncoding: Uint8Array;
  readonly signature: Uint8Array;
  readonly keyid?: string;
}

export interface ChainVerificationConformanceOptions {
  /** The host's signer. The kit holds no key material of its own. */
  readonly signer: DsseSigner;
  /** Optional: turns on the DSSE verification leg for the host's key type. */
  readonly verifySignature?: (check: DsseSignatureCheck) => boolean;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Runs the capability against the fake runtime for each scripted scenario and asserts the
 * exact statement it produces against the committed golden. Requires `vitest` (an optional
 * peer) with `globals: true` -- the suite functions are read off `globalThis` at call time so
 * importing this module outside a test run (the golden generator does exactly that) never
 * pulls vitest's worker state into a plain Node process.
 */
export function describeChainVerificationConformance(
  options: ChainVerificationConformanceOptions,
): void {
  const { describe, expect, it } = globalThis as unknown as typeof import("vitest");

  describe("chain verification conformance", () => {
    async function runWithRuntime(scenario: ScriptedChainScenario) {
      const runtime = createScriptedChainRuntime(scenario);
      const attestation = await executeScenario(scenario, runtime, options.signer);
      return { attestation, runtime };
    }

    for (const scenario of CHAIN_CONFORMANCE_SCENARIOS) {
      it(`${scenario}: exact golden statement`, async () => {
        const { attestation, runtime } = await runWithRuntime(scenario);
        expect(attestation.statement).toEqual(await loadGoldenStatement(scenario));

        if (isRunBearingOutcome(attestation.statement.predicate.outcome)) {
          expect(new Set(attestation.instanceIds).size).toBe(5);
        }
        expect(runtime.stopCount).toBe(runtime.materializeRequests.length);

        const declaredPolicy = attestation.statement.predicate.isolation.networkPolicy;
        for (const request of runtime.materializeRequests) {
          expect(request.networkPolicy).toEqual(declaredPolicy);
        }

        const envelope = parseDsseEnvelope(attestation.envelopeBytes);
        expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE);
        expect(envelope.signatures.length).toBeGreaterThan(0);
        expect(parseChainEnvironmentVerificationStatement(
          JSON.parse(new TextDecoder().decode(envelope.payloadBytes)),
        )).toEqual(attestation.statement);
        expect(attestation.attestationDigest).toBe(recordDigest(attestation.envelopeBytes));
      });
    }

    it("checks every signature digest against the re-derived pre-authentication encoding",
      async function checkSignatures() {
        const { verifySignature } = options;
        if (verifySignature === undefined) return;
        const { attestation } = await runWithRuntime("sealed-stable");
        const envelope = parseDsseEnvelope(attestation.envelopeBytes);
        const preAuthEncoding = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);

        for (const signature of envelope.signatures) {
          expect(verifySignature({
            preAuthEncoding,
            signature: decodeBase64(signature.sig),
            ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
          })).toBe(true);
        }

        const tampered = new Uint8Array(envelope.payloadBytes);
        tampered[tampered.length - 1] = (tampered[tampered.length - 1]! + 1) % 256;
        const tamperedEncoding = dssePreAuthEncoding(envelope.payloadType, tampered);
        for (const signature of envelope.signatures) {
          expect(verifySignature({
            preAuthEncoding: tamperedEncoding,
            signature: decodeBase64(signature.sig),
            ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
          })).toBe(false);
        }
      });

    it("both closure modes produce closed-reproducible with the mode the instance dictates",
      async () => {
        const sealed = await runConformanceScenario("sealed-stable", options.signer);
        const fork = await runConformanceScenario("fork-backend-refusal", options.signer);
        expect(sealed.statement.predicate.outcome).toBe("closed-reproducible");
        expect(fork.statement.predicate.outcome).toBe("closed-reproducible");
        expect(sealed.statement.predicate.isolation.closureEvidenceMode).toBe("sealed-boundary");
        expect(fork.statement.predicate.isolation.closureEvidenceMode).toBe("fork-backend-refusal");
        expect(sealed.statement.predicate.isolation.boundaryProbe?.readsEmptyOutsideSlice)
          .toBe(true);
        expect(sealed.statement.predicate.isolation.egressAttempts).toEqual([]);
        expect(fork.statement.predicate.isolation.boundaryProbe).toBeUndefined();
        expect(fork.statement.predicate.isolation.egressAttempts
          .some((attempt) => attempt.outcome === "refused")).toBe(true);
      });

    it("the composite never substitutes for its chain world", async () => {
      const chainWorld = chainEnvironmentRecordDigest(
        sealChainEnvironmentRecord(buildConformanceChainRecord()),
      );
      const { attestation } = await runWithRuntime("composite-chain-only");
      expect(attestationMatchesRecord(attestation.statement, chainWorld)).toBe(false);
      expect(requiresComponentAttestations(attestation.statement)).toContain(chainWorld);
    });

    it("is stable across repeated runs of the same scenario", async () => {
      const first = await runConformanceScenario("sealed-stable", options.signer);
      const second = await runConformanceScenario("sealed-stable", options.signer);
      expect(second.statement).toEqual(first.statement);
      expect(second.envelopeBytes).toEqual(first.envelopeBytes);
    });
  });
}
