// SPDX-License-Identifier: Apache-2.0

import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import {
  checkStatePredicateSpec,
  parseEvaluationSpec,
  sealEvaluationSpec,
  sealTaskProfile,
  STATE_PREDICATE_VERDICT_RULE,
  TaskProfileDocumentSchema,
} from "@jinn-network/task-execution-profiles";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { describe, expect, it } from "vitest";

import { lendingLifecycleTemplate } from "./families/lending-lifecycle.js";
import { createFixtureAddressLedger, type ScenarioAccountPort } from "./fixture-accounts.js";
import { parameterize } from "./parameterize.js";
import {
  buildChainWorkProfile,
  buildScenarioEvaluationSpec,
  buildSealedScenarioPair,
  buildSealedScenarioTask,
} from "./seal-pair.js";
import { syntheticProbeAddress, type ChainDerivationEnvironment } from "./template.js";

const decoder = new TextDecoder();

function roleAddress(byte: string): string {
  return `0x${byte.repeat(20)}`;
}

const BORROWER_PLACEHOLDER = roleAddress("08");

function buildDerivationEnvironment(): ChainDerivationEnvironment {
  const chainRecord = parseChainEnvironmentRecord(sealChainEnvironmentRecord({
    kind: CHAIN_ENVIRONMENT_KIND,
    runtime: {
      family: "anvil",
      version: "1.3.7",
      image: { manifestDigest: `sha256:${"1".repeat(64)}`, platform: "linux/amd64" },
      binary: { name: "anvil", digest: `sha256:${"2".repeat(64)}` },
      evm: { hardfork: "cancun", sandboxChainId: 1, nonDefaultSettings: {} },
      launch: { options: { "no-mining": true } },
    },
    sourceAnchor: {
      caip2ChainId: "eip155:1",
      nativeChainId: 1,
      genesisHash: `0x${"d".repeat(64)}`,
      blockNumber: 21_000_000,
      blockHash: `0x${"e".repeat(64)}`,
      stateRoot: `0x${"f".repeat(64)}`,
      timestamp: 1_735_689_600,
      finalityPolicy: "finalized",
    },
    stateMaterialization: {
      closureClass: "closed-state",
      fidelityClass: "anchored-subset",
      constructionMethod: "archive-extraction",
      materializer: { id: "anvil-state-loader", version: "0.4.1", digest: `sha256:${"3".repeat(64)}` },
      stateArtifact: {
        descriptor: { name: "state.json", digest: { sha256: "4".repeat(64) } },
        format: { id: "jinn.chain-state-slice", version: "1" },
        entryCounts: { accounts: 5, storageSlots: 20, codeEntries: 2 },
      },
      sourceProofManifest: {
        proofFormat: "eip-1186",
        proofs: { name: "proofs.json", digest: { sha256: "5".repeat(64) } },
        coverage: { accounts: 3, storageSlots: 18, codeEntries: 2 },
      },
      fixtureCoverage: {
        manifest: { name: "mutations.json", digest: { sha256: "6".repeat(64) } },
        declared: { accounts: 2, storageSlots: 2, codeEntries: 0 },
        mutatedProofCoveredAccounts: 0,
      },
      mutatesSourceProtocolState: false,
      initialStateCommitment: `0x${"7".repeat(64)}`,
    },
    fixtures: {
      modules: [
        { id: "accounts", kind: "funded-accounts", module: { name: "a", digest: { sha256: "8".repeat(64) } } },
      ],
      accounts: [
        { role: "pool", address: roleAddress("01"), nativeBalanceWei: "10000000000000000000" },
        { role: "collateral-token", address: roleAddress("02"), nativeBalanceWei: "10000000000000000000" },
        { role: "debt-token", address: roleAddress("03"), nativeBalanceWei: "10000000000000000000" },
        { role: "price-oracle", address: roleAddress("04"), nativeBalanceWei: "10000000000000000000" },
        { role: "whale", address: roleAddress("05"), nativeBalanceWei: "10000000000000000000" },
        { role: "treasury", address: roleAddress("06"), nativeBalanceWei: "10000000000000000000" },
        { role: "dex-router", address: roleAddress("07"), nativeBalanceWei: "10000000000000000000" },
        { role: "borrower", address: BORROWER_PLACEHOLDER, nativeBalanceWei: "10000000000000000000" },
      ],
    },
    determinismControls: {
      miningMode: "manual",
      orderingPolicy: "fifo",
      mempoolPolicy: "none",
      initialBlockNumber: 21_000_001,
      initialTimestamp: 1_735_689_612,
      blockTimeProgression: { mode: "fixed-increment", secondsPerBlock: 12 },
      baseFeePolicy: { mode: "fixed", weiPerGas: "1000000000" },
      gasPricePolicy: { mode: "fixed", weiPerGas: "1000000000" },
      blockGasLimit: "30000000",
      perTransactionGasCeiling: "15000000",
      coinbase: `0x${"c0".repeat(20)}`,
      prevrandao: `0x${"9".repeat(64)}`,
      replacementPolicy: "reject",
      noncePolicy: "strict",
      timeoutClock: "chain-time",
      timeWarp: { maxSecondsPerOperation: 86_400, maxAggregateSeconds: 2_592_000, maxBlocksPerOperation: 7200 },
      resetMechanism: "fresh-process",
    },
    capabilityEnvelope: {
      toolInterfaces: [
        { id: "jinn.chain-tools", version: "1.0", schema: { name: "t", digest: { sha256: "a".repeat(64) } } },
      ],
      rpc: { readMethods: ["eth_call"], stateChangingMethods: ["eth_sendRawTransaction"] },
      signerRoles: [{ role: "borrower", accounts: [BORROWER_PLACEHOLDER] }],
      permittedChainId: 1,
      limits: {
        maxTransactions: 25,
        maxAggregateNativeValueWei: "5000000000000000000",
        tokenSpendPolicies: [],
        maxGasPerTransaction: "5000000",
        maxAggregateGas: "60000000",
        maxExecutionDurationMs: 600_000,
        maxBlockAdvance: 500,
        maxChainSecondsAdvance: 604_800,
      },
      egressPolicyId: "jinn.egress.blackhole/1",
    },
    verificationContract: {
      probeSuite: {
        descriptor: { name: "probes", digest: { sha256: "b".repeat(64) } },
        format: { id: "jinn.chain-probes", version: "1" },
      },
      observationSchema: { name: "obs", digest: { sha256: "c".repeat(64) } },
      baselineObservationDigest: `sha256:${"d".repeat(64)}`,
      comparator: { id: "canonical-observation-eq", version: "1.0.0", digest: `sha256:${"e".repeat(64)}` },
      closureCheckRequired: true,
      resetRequirements: { freshInstancePerRun: true, minimumRuns: 5 },
      fixtureProbeCoverage: [{ fixtureId: "accounts", probeIds: ["balances"] }],
      policyId: "jinn.chain-verification-policy/1",
    },
  }));

  const chainBytes = sealChainEnvironmentRecord(chainRecord);
  const chainDigestBare = chainEnvironmentRecordDigest(chainBytes).slice("sha256:".length);
  const compositeBytes = sealCryptoEnvironmentRecord({
    kind: CRYPTO_ENVIRONMENT_KIND,
    chainWorld: {
      kind: CHAIN_ENVIRONMENT_KIND,
      record: { name: "chain", digest: { sha256: chainDigestBare } },
    },
    informationWorlds: [],
    serviceRuntimes: [],
    composition: {
      originRouting: [],
      missPolicy: { mode: "declared-response", status: 404 },
      endpointAllowlist: [],
      requestBudget: { maxRequests: 0, maxResponseBytes: 0 },
    },
  });
  const roleAddresses = Object.fromEntries(
    chainRecord.fixtures.accounts.map((account) => [account.role, account.address]),
  );
  return {
    recordBytes: compositeBytes,
    record: parseCryptoEnvironmentRecord(compositeBytes),
    recordDigest: cryptoEnvironmentRecordDigest(compositeBytes),
    chainRecord,
    roleAddresses,
  };
}

let accountCounter = 0x10;

function freshAccountPort(): ScenarioAccountPort {
  return async (request) => ({
    role: request.role,
    address: syntheticProbeAddress(accountCounter++),
  });
}

async function buildFixtureCandidate() {
  return parameterize(
    { accounts: freshAccountPort(), ledger: createFixtureAddressLedger() },
    lendingLifecycleTemplate,
    {},
    buildDerivationEnvironment(),
  );
}

describe("the chain-work task profile", () => {
  it("validates against profiles' own TaskProfileDocumentSchema", () => {
    expect(TaskProfileDocumentSchema.safeParse(buildChainWorkProfile()).success).toBe(true);
  });

  it("whitelists exactly the state-predicate family", () => {
    expect(buildChainWorkProfile().evaluationFamilies).toStrictEqual(["state-predicate"]);
  });

  it("requires a solution-script output slot and no patch slot", () => {
    const slots = buildChainWorkProfile().outputConventions.slots;
    expect(slots.find((slot) => slot.name === "solution-script")?.required).toBe(true);
    expect(slots.map((slot) => slot.name)).not.toContain("patch");
  });

  it("seals to a stable digest across two builds", () => {
    expect(sealTaskProfile(buildChainWorkProfile()).digest)
      .toBe(sealTaskProfile(buildChainWorkProfile()).digest);
  });
});

describe("the sealed evaluation spec", () => {
  it("declares family state-predicate and validates end to end", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await buildFixtureCandidate();
    const spec = buildScenarioEvaluationSpec(candidate, env);

    expect(spec.document.family).toBe("state-predicate");
    expect(checkStatePredicateSpec(spec.document)).toEqual({ ok: true });
    expect(parseEvaluationSpec(spec.bytes)).toEqual(spec.document);
  });

  it("references the composite record by digest and inlines no environment content", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await buildFixtureCandidate();
    const spec = buildScenarioEvaluationSpec(candidate, env);
    const json = decoder.decode(spec.bytes);

    expect(json).toContain(env.recordDigest.slice("sha256:".length));
    expect(json).not.toContain("anvil");
    expect(json).not.toContain("stateRoot");
  });

  it("carries measurements that never gate", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await buildFixtureCandidate();
    const spec = buildScenarioEvaluationSpec(candidate, env);

    expect(spec.document.verdictRule).toStrictEqual(STATE_PREDICATE_VERDICT_RULE);
    const authorMeasurements = spec.document.measurements.filter(
      (measurement) => !["successPredicatesSatisfied", "safetyConstraintsViolated", "statePredicateUnevaluable"]
        .includes(measurement.name),
    );
    expect(authorMeasurements.length).toBeGreaterThan(0);
    for (const measurement of authorMeasurements) {
      expect(measurement.required).toBe(false);
    }
    expect((spec.document.grader as { accessClass?: string }).accessClass).toBe("public");
    expect(spec.document.evidenceConventions).toEqual({ requiredRefs: ["solution-script"] });
  });

  it("seals bytes whose digest is what the Task references", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await buildFixtureCandidate();
    const spec = buildScenarioEvaluationSpec(candidate, env);
    const task = buildSealedScenarioTask(candidate, env, spec.digest);
    const document = JSON.parse(decoder.decode(task.bytes)) as {
      evaluation: { digest: { sha256: string } };
    };

    expect(document.evaluation.digest.sha256).toBe(spec.digest.slice("sha256:".length));
    expect(sealEvaluationSpec(spec.document).bytes).toEqual(spec.bytes);
  });
});

describe("the sealed task", () => {
  it("references the spec by digest only, never inline", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await buildFixtureCandidate();
    const pair = buildSealedScenarioPair(candidate, env);
    const taskJson = decoder.decode(pair.task.bytes);
    const specJson = decoder.decode(pair.evaluationSpec.bytes);

    expect(taskJson).toContain(pair.evaluationSpec.digest.slice("sha256:".length));
    expect(taskJson).not.toContain(specJson);
  });

  it("carries synthetic provenance with its scenario commitment", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await buildFixtureCandidate();
    const task = buildSealedScenarioTask(
      candidate,
      env,
      buildScenarioEvaluationSpec(candidate, env).digest,
    );
    const document = JSON.parse(decoder.decode(task.bytes)) as {
      payload: {
        provenance: { kind: string; sourceCommitment: string; lineage: unknown };
      };
    };

    expect(document.payload.provenance.kind).toBe("synthetic");
    expect(document.payload.provenance.sourceCommitment).toBe(candidate.sourceCommitment);
    expect(document.payload.provenance.lineage).toEqual(candidate.lineage);
  });

  it("carries rights.sourceLicense", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await buildFixtureCandidate();
    const task = buildSealedScenarioTask(
      candidate,
      env,
      buildScenarioEvaluationSpec(candidate, env).digest,
    );
    const document = JSON.parse(decoder.decode(task.bytes)) as {
      payload: { rights: { sourceLicense: string } };
    };

    expect(document.payload.rights.sourceLicense).toBe(candidate.rights.sourceLicense);
  });

  it("never carries the reference script, in any field", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await buildFixtureCandidate();
    const pair = buildSealedScenarioPair(candidate, env);

    expect(decoder.decode(pair.task.bytes)).not.toContain("transactionIntent");
    expect(decoder.decode(pair.evaluationSpec.bytes)).not.toContain("transactionIntent");
  });

  it("re-seals to identical bytes", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await buildFixtureCandidate();
    const pair = buildSealedScenarioPair(candidate, env);

    expect(sealTask(JSON.parse(decoder.decode(pair.task.bytes)))).toEqual(pair.task.bytes);
  });
});
