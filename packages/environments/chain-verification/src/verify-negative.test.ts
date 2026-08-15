// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEnvironmentRecord,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
} from "@jinn-network/chain-environment-record";
import {
  parseChainEnvironmentRecord,
  sealChainEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import {
  canonicalJsonBytes,
  recordDigest,
  type DsseSigner,
} from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import {
  buildConformanceChainRecord,
  CONFORMANCE_AGENT_ACCOUNT,
  CONFORMANCE_COUNTERPARTY_ACCOUNT,
  CONFORMANCE_PROTOCOL_ACCOUNT_A,
  CONFORMANCE_PROTOCOL_ACCOUNT_B,
  CONFORMANCE_PROTOCOL_SLOT_1,
  CONFORMANCE_PROTOCOL_SLOT_2,
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
import { CHAIN_VERIFICATION_OUTCOMES } from "./outcomes.js";
import {
  DEFAULT_BLACKHOLE_POLICY,
  type ArtifactStore,
  type ChainRuntime,
  type Clock,
} from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import { parseChainEnvironmentVerificationStatement } from "./statement.js";
import { verifyChainEnvironment, type SealedAttestation } from "./verify.js";

const eoa = createEoaTestSigner("chain-verification-negative-suite");
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

const OUT_OF_SLICE_OBSERVATION_RAW = {
  ...REFERENCE_OBSERVATION_RAW,
  probes: [
    REFERENCE_OBSERVATION_RAW.probes[0],
    {
      ...REFERENCE_OBSERVATION_RAW.probes[1],
      observedErrorClass: "non-empty-account",
    },
  ],
};

type ScenarioName = (typeof CASES)[number][0];

const CASES: readonly (readonly [string, string, string])[] = [
  ["artifact-missing", "artifact-unavailable", "resource-unresolvable"],
  ["artifact-wrong-bytes", "artifact-unavailable", "resource-digest-mismatch"],
  ["runtime-version-drift", "runtime-identity-mismatch", "runtime-version-mismatch"],
  ["unsupported-prevrandao", "runtime-identity-mismatch", "determinism-control-unsupported"],
  ["anchor-root-drift", "source-anchor-mismatch", "anchor-root-mismatch"],
  ["bad-state-proof", "source-proof-invalid", "state-proof-invalid"],
  ["coverage-incomplete", "source-coverage-incomplete", "artifact-entry-uncovered"],
  ["undeclared-mutation", "source-coverage-incomplete", "undeclared-source-mutation"],
  ["post-fixture-drift", "initial-state-mismatch", "post-fixture-commitment-mismatch"],
  ["upstream-fetch-succeeds", "offline-dependency-detected", "egress-succeeded"],
  ["loads-uncommitted-resource", "offline-dependency-detected", "uncommitted-resource-loaded"],
  ["fork-backend-unrefused", "offline-dependency-detected", "fork-backend-fetch-unrefused"],
  ["out-of-slice-not-empty", "offline-dependency-detected", "out-of-slice-read-not-empty"],
  ["forbidden-method-allowed", "capability-mismatch", "rpc-allowlist-violation"],
  ["extra-signer-exposed", "capability-mismatch", "signer-scope-violation"],
  ["divergent-on-run-3", "probe-divergence", "probe-observation-divergence"],
  ["reset-drifts", "reset-divergence", "reset-observation-divergence"],
  ["materializer-explodes", "verification-infrastructure-failure", "materializer-failed"],
  ["materializer-omits-report", "verification-infrastructure-failure", "materialization-report-absent"],
  ["probe-times-out", "verification-infrastructure-failure", "run-timeout"],
];

function createFixedClock(): Clock {
  const fixed = new Date("2026-01-15T12:00:00.000Z");
  return { now: () => fixed };
}

function asPrefixedDigest(digest: string): `sha256:${string}` {
  return digest as `sha256:${string}`;
}

function recordForScenario(scenario: ScenarioName): ChainEnvironmentRecord {
  const anchored = [
    "anchor-root-drift",
    "bad-state-proof",
    "coverage-incomplete",
    "undeclared-mutation",
  ].includes(scenario);
  if (scenario === "bad-state-proof") {
    const manifest = {
      ...conformanceSourceProofManifest(),
      anchorStateRoot: `0x${"3".repeat(64)}`,
    };
    const manifestBytes = canonicalJsonBytes(manifest);
    const manifestDigest = recordDigest(manifestBytes).slice("sha256:".length);
    const record = buildConformanceChainRecord({ fidelityClass: "anchored-subset" });
    const sealed = structuredClone(record) as unknown as Record<string, unknown>;
    const sourceProofManifest = (sealed.stateMaterialization as {
      sourceProofManifest?: { proofs: { digest: { sha256: string } } };
    }).sourceProofManifest;
    if (sourceProofManifest !== undefined) {
      sourceProofManifest.proofs.digest.sha256 = manifestDigest;
    }
    return parseChainEnvironmentRecord(sealChainEnvironmentRecord(sealed));
  }
  if (scenario === "undeclared-mutation") {
    const document = {
      format: "jinn.chain-fixture-coverage/1",
      declarations: [
        { address: CONFORMANCE_COUNTERPARTY_ACCOUNT, kind: "account" },
        {
          address: CONFORMANCE_PROTOCOL_ACCOUNT_A,
          kind: "storage",
          slot: CONFORMANCE_PROTOCOL_SLOT_1,
        },
      ],
    };
    const documentBytes = canonicalJsonBytes(document);
    const documentDigest = recordDigest(documentBytes).slice("sha256:".length);
    const record = buildConformanceChainRecord({
      fidelityClass: "anchored-subset",
      mutatesSourceProtocolState: false,
      mutatedProofCoveredAccounts: 0,
    });
    const sealed = structuredClone(record) as unknown as Record<string, unknown>;
    const fixtureCoverage = (sealed.stateMaterialization as {
      fixtureCoverage?: { manifest?: { digest: { sha256: string } } };
    }).fixtureCoverage;
    if (fixtureCoverage?.manifest !== undefined) {
      fixtureCoverage.manifest.digest.sha256 = documentDigest;
    }
    return parseChainEnvironmentRecord(sealChainEnvironmentRecord(sealed));
  }
  if (anchored) {
    return buildConformanceChainRecord({
      fidelityClass: "anchored-subset",
      mutatesSourceProtocolState: scenario === "undeclared-mutation" ? false : true,
      ...(scenario === "undeclared-mutation"
        ? { mutatedProofCoveredAccounts: 0 }
        : {}),
    });
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
      CONFORMANCE_PROTOCOL_ACCOUNT_B,
      CONFORMANCE_COUNTERPARTY_ACCOUNT,
    ],
    codeEntries: [CONFORMANCE_PROTOCOL_ACCOUNT_A],
    storageSlots: [
      { address: CONFORMANCE_PROTOCOL_ACCOUNT_A, slot: CONFORMANCE_PROTOCOL_SLOT_1 },
      { address: CONFORMANCE_PROTOCOL_ACCOUNT_B, slot: CONFORMANCE_PROTOCOL_SLOT_2 },
    ],
  };
  if (!complete) {
    entries.storageSlots = [
      ...entries.storageSlots,
      { address: CONFORMANCE_PROTOCOL_ACCOUNT_B, slot: `0x${"0".repeat(63)}9` },
    ];
  }
  return entries;
}

function buildMaterializationReport(
  record: ChainEnvironmentRecord,
  networkPolicy: NetworkPolicy,
  loadedResources: readonly `sha256:${string}`[],
  scenario: ScenarioName,
): MaterializationReport {
  const controls = record.determinismControls;
  const appliedControls: Record<string, string> = {
    miningMode: controls.miningMode,
    orderingPolicy: controls.orderingPolicy,
    resetMechanism: controls.resetMechanism,
  };
  if (record.sourceAnchor !== undefined) {
    appliedControls.anchorStateRoot = scenario === "anchor-root-drift"
      ? `0x${"e".repeat(64)}`
      : record.sourceAnchor.stateRoot;
  }

  const anchored = record.stateMaterialization.fidelityClass !== "local";
  const artifactEntries = anchored
    ? anchoredArtifactEntries(scenario !== "coverage-incomplete")
    : { accounts: [], codeEntries: [], storageSlots: [] };

  const isolation: MaterializationReport["isolation"] = {
    networkPolicy,
    egressAttempts: scenario === "upstream-fetch-succeeds"
      ? [{ target: "https://archive.example/rpc", outcome: "succeeded" as const }]
      : scenario === "fork-backend-unrefused"
        ? []
        : networkPolicy.forkBackend === "present"
          ? [{ target: "https://archive.example/rpc", outcome: "refused" as const }]
          : [],
    forbiddenProbes: scenario === "forbidden-method-allowed"
      ? [{
        method: "eth_sendRawTransaction",
        expectedClass: "denied",
        observedClass: "allowed",
      }]
      : [],
    exposedSignerAccounts: scenario === "extra-signer-exposed"
      ? [...record.fixtures.accounts
        .filter((account) => account.role === "agent")
        .map((account) => account.address), "0x000000000000000000000000000000000000dead"]
      : record.fixtures.accounts
        .filter((account) => account.role === "agent")
        .map((account) => account.address),
    ceilingChecks: [
      { name: "maxTransactions", enforced: true },
      { name: "maxAggregateGas", enforced: true },
      { name: "maxExecutionDurationMs", enforced: true },
    ],
  };

  const loaded = scenario === "loads-uncommitted-resource"
    ? [...loadedResources, `sha256:${"9".repeat(64)}` as `sha256:${string}`]
    : [...loadedResources];

  return {
    runtimeIdentity: {
      imageManifestDigest: asPrefixedDigest(record.runtime.image.manifestDigest),
      platform: record.runtime.image.platform,
      reportedVersion: scenario === "runtime-version-drift"
        ? `${record.runtime.version}-drift`
        : record.runtime.version,
      binaryDigest: asPrefixedDigest(record.runtime.binary.digest),
      evmConfigurationDigest: asPrefixedDigest(record.runtime.binary.digest),
      chainId: record.runtime.evm.sandboxChainId,
      appliedControls,
      unsupportedControls: scenario === "unsupported-prevrandao" ? ["prevrandao"] : [],
    },
    artifactEntries,
    postFixtureCommitment: scenario === "post-fixture-drift"
      ? (`0x${"c".repeat(64)}` as `0x${string}`)
      : record.stateMaterialization.initialStateCommitment as `0x${string}`,
    loadedResources: loaded,
    isolation,
    cost: { wallSeconds: 0 },
  };
}

interface StubRuntime extends ChainRuntime {
  readonly materializeRequests: MaterializationRequest[];
  stopCount: number;
}

function createScenarioRuntime(scenario: ScenarioName): StubRuntime {
  const materializeRequests: MaterializationRequest[] = [];
  const counters = { stopCount: 0 };
  const referenceObservation = buildCanonicalChainObservation(REFERENCE_OBSERVATION_RAW);
  const divergentObservation = buildCanonicalChainObservation(DIVERGENT_OBSERVATION_RAW);
  const outOfSliceObservation = buildCanonicalChainObservation(OUT_OF_SLICE_OBSERVATION_RAW);
  let runIndex = 0;

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
        if (scenario === "materializer-explodes") {
          throw new Error("materializer exploded");
        }
        const loadedResources = [...request.resources.byDigest.keys()];
        const report = scenario === "materializer-omits-report"
          ? undefined
          : buildMaterializationReport(
            request.record,
            request.networkPolicy,
            loadedResources,
            scenario,
          );
        return {
          instanceId: request.instanceId,
          rpcEndpoint: "http://127.0.0.1:0",
          ...(report === undefined ? {} : { report }),
          async stop() {
            counters.stopCount += 1;
          },
        };
      },
      async reset(instance) {
        if (scenario === "reset-drifts") {
          return `0x${"d".repeat(64)}` as `0x${string}`;
        }
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
        if (scenario === "out-of-slice-not-empty") {
          observation = outOfSliceObservation;
        }
        return {
          observation,
          observationDigest: chainObservationDigest(observation),
          timedOut: scenario === "probe-times-out",
          cost: { wallSeconds: 0 },
        };
      },
    },
  };
  return runtime;
}

function createScenarioArtifactStore(
  scenario: ScenarioName,
  record: ChainEnvironmentRecord,
): ArtifactStore & { stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  const byDigest = new Map<string, Uint8Array>();
  const stateArtifactExpectedDigest = record.stateMaterialization.stateArtifact === undefined
    ? undefined
    : fromDigestSet(
      record.stateMaterialization.stateArtifact.descriptor.digest as DigestSet,
    );
  for (const name of artifactNamesForRecord(record)) {
    const bytes = conformanceArtifactBytes(name);
    const expectedDigest = recordDigest(bytes);
    if (scenario === "bad-state-proof" && name === "source-proof-manifest") {
      const manifest = {
        ...conformanceSourceProofManifest(),
        anchorStateRoot: `0x${"3".repeat(64)}`,
      };
      const manifestBytes = canonicalJsonBytes(manifest);
      const manifestDigest = fromDigestSet(
        record.stateMaterialization.sourceProofManifest!.proofs.digest as DigestSet,
      );
      byDigest.set(manifestDigest, manifestBytes);
      continue;
    }
    if (scenario === "undeclared-mutation" && name === "fixture-coverage-manifest") {
      const document = {
        format: "jinn.chain-fixture-coverage/1",
        declarations: [
          { address: CONFORMANCE_COUNTERPARTY_ACCOUNT, kind: "account" },
          {
            address: CONFORMANCE_PROTOCOL_ACCOUNT_A,
            kind: "storage",
            slot: CONFORMANCE_PROTOCOL_SLOT_1,
          },
        ],
      };
      const documentBytes = canonicalJsonBytes(document);
      const manifestDigest = fromDigestSet(
        record.stateMaterialization.fixtureCoverage!.manifest!.digest as DigestSet,
      );
      byDigest.set(manifestDigest, documentBytes);
      continue;
    }
    byDigest.set(expectedDigest, bytes);
  }
  return {
    stored,
    async getArtifact(descriptor) {
      const digest = fromDigestSet(descriptor.digest);
      if (scenario === "artifact-missing" && digest === stateArtifactExpectedDigest) {
        throw new Error(`artifact unavailable for ${digest}`);
      }
      let bytes = byDigest.get(digest);
      if (scenario === "artifact-wrong-bytes" && digest === stateArtifactExpectedDigest) {
        bytes = canonicalJsonBytes({ wrong: true });
      }
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

function networkPolicyForScenario(scenario: ScenarioName): NetworkPolicy {
  if (scenario === "fork-backend-unrefused") {
    return { ...DEFAULT_BLACKHOLE_POLICY, forkBackend: "present" };
  }
  return DEFAULT_BLACKHOLE_POLICY;
}

async function run(scenario: ScenarioName): Promise<SealedAttestation> {
  const record = recordForScenario(scenario);
  const runtime = createScenarioRuntime(scenario);
  const artifactStore = createScenarioArtifactStore(scenario, record);
  return verifyChainEnvironment(
    { runtime, artifactStore, signer, clock: createFixedClock(), verifier: VERIFIER },
    record,
    { networkPolicy: networkPolicyForScenario(scenario) },
  );
}

async function runWithStore(scenario: ScenarioName) {
  const record = recordForScenario(scenario);
  const runtime = createScenarioRuntime(scenario);
  const artifactStore = createScenarioArtifactStore(scenario, record);
  const attestation = await verifyChainEnvironment(
    { runtime, artifactStore, signer, clock: createFixedClock(), verifier: VERIFIER },
    record,
    { networkPolicy: networkPolicyForScenario(scenario) },
  );
  return { artifactStore, attestation };
}

async function runWithRuntime(scenario: ScenarioName) {
  const record = recordForScenario(scenario);
  const runtime = createScenarioRuntime(scenario);
  const artifactStore = createScenarioArtifactStore(scenario, record);
  const attestation = await verifyChainEnvironment(
    { runtime, artifactStore, signer, clock: createFixedClock(), verifier: VERIFIER },
    record,
    { networkPolicy: networkPolicyForScenario(scenario) },
  );
  return { runtime, attestation };
}

describe("negative outcomes are signed attestations, not exceptions", () => {
  it.each(CASES)("%s attests %s / %s", async (scenario, outcome, reason) => {
    const attestation = await run(scenario as ScenarioName);
    const { predicate } = attestation.statement;
    expect(predicate.outcome).toBe(outcome);
    expect(predicate.failure?.reason).toBe(reason);
    expect(parseChainEnvironmentVerificationStatement(attestation.statement))
      .toEqual(attestation.statement);
    expect(attestation.envelopeBytes.length).toBeGreaterThan(0);
    expect(attestation.outcome).toBe(outcome);
  });

  it("carries runs and baseline for divergence, and neither for pre-run failures", async () => {
    const divergent = await run("divergent-on-run-3");
    expect(divergent.statement.predicate.runs?.count).toBe(5);
    expect(divergent.statement.predicate.runs?.allObservationsEqual).toBe(false);
    expect(divergent.statement.predicate.baseline).toBeDefined();
    expect(divergent.statement.predicate.failure?.divergence?.divergentRuns)
      .toEqual([expect.objectContaining({ index: 2 })]);

    const early = await run("artifact-missing");
    expect(early.statement.predicate.runs).toBeUndefined();
    expect(early.statement.predicate.baseline).toBeUndefined();
    expect(early.observations).toEqual([]);
  });

  it("stores every divergent observation so a third party can re-compare", async () => {
    const { artifactStore, attestation } = await runWithStore("divergent-on-run-3");
    for (const divergentRun of attestation.statement.predicate.failure!.divergence!.divergentRuns) {
      expect(artifactStore.stored.has(`sha256:${divergentRun.observation.digest.sha256}`))
        .toBe(true);
    }
  });

  it("covers every outcome the closed-state protocol can reach", () => {
    const covered = new Set(CASES.map(([, outcome]) => outcome));
    covered.add("closed-reproducible");
    covered.add("archive-observed");
    covered.add("provider-disagreement");
    expect([...CHAIN_VERIFICATION_OUTCOMES].filter((outcome) => !covered.has(outcome)))
      .toEqual([]);
  });

  it("dismantles every instance it created, even on the failing path", async () => {
    const { runtime } = await runWithRuntime("post-fixture-drift");
    expect(runtime.stopCount).toBe(runtime.materializeRequests.length);
  });
});
