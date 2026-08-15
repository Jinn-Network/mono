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
import type { DerivationStrategy } from "@jinn-network/task-derivation";
import { describe, expect, it } from "vitest";

import { lendingLifecycleTemplate } from "./families/lending-lifecycle.js";
import { createFixtureAddressLedger, type ScenarioAccountPort } from "./fixture-accounts.js";
import {
  CHAIN_SCENARIO_STRATEGY_ID,
  chainScenarioStrategy,
  loadChainDerivationEnvironment,
  type ChainScenarioInputs,
} from "./strategy.js";
import type { ChainDerivationEnvironment, ChainScenarioCandidate } from "./template.js";
import { syntheticProbeAddress } from "./template.js";

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function roleAddress(byte: string): string {
  return `0x${byte.repeat(20)}`;
}

export function buildFixtureDerivationEnvironment(): ChainDerivationEnvironment {
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
        { role: "borrower", address: roleAddress("08"), nativeBalanceWei: "10000000000000000000" },
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
      signerRoles: [{ role: "borrower", accounts: [roleAddress("08")] }],
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
  const compositeBytes = sealCryptoEnvironmentRecord({
    kind: CRYPTO_ENVIRONMENT_KIND,
    chainWorld: {
      kind: CHAIN_ENVIRONMENT_KIND,
      record: {
        name: "chain",
        digest: { sha256: chainEnvironmentRecordDigest(chainBytes).slice("sha256:".length) },
      },
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

  return loadChainDerivationEnvironment(compositeBytes, chainBytes);
}

let accountCounter = 0x10;

function freshAccountPort(): ScenarioAccountPort {
  return async (request) => ({
    role: request.role,
    address: syntheticProbeAddress(accountCounter++),
  });
}

function fixtureInputs(parameterSets: readonly unknown[]): ChainScenarioInputs {
  return {
    template: lendingLifecycleTemplate as unknown as ChainScenarioInputs["template"],
    parameterSets,
    ledger: createFixtureAddressLedger(),
    accounts: freshAccountPort(),
  };
}

describe("chainScenarioStrategy plugs into the existing derivation seam", () => {
  it("is assignable to DerivationStrategy with this family's candidate and environment", () => {
    const seam: DerivationStrategy<ChainScenarioInputs, ChainScenarioCandidate, ChainDerivationEnvironment>
      = chainScenarioStrategy;
    expect(seam.id).toBe(CHAIN_SCENARIO_STRATEGY_ID);
  });

  it("yields one candidate per parameter set, in input order", async () => {
    const env = buildFixtureDerivationEnvironment();
    const candidates = await collectAsync(
      chainScenarioStrategy.derive({}, env, fixtureInputs([{}, { borrowAmount: "1" }])),
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.lineage.parameterDigest).not.toBe(candidates[1]!.lineage.parameterDigest);
  });

  it("skips an incompatible parameter set and keeps going, logging the skip", async () => {
    const env = buildFixtureDerivationEnvironment();
    const skipped: Array<{ candidateId: string; reason: string }> = [];
    const candidates = await collectAsync(
      chainScenarioStrategy.derive(
        {
          logger: {
            candidateSkipped: (event) => skipped.push(event),
            candidateRefused: () => {},
            pairWritten: () => {},
          },
        },
        { ...env, chainRecord: { ...env.chainRecord, stateMaterialization: {
          ...env.chainRecord.stateMaterialization,
          closureClass: "archive-dependent",
        } } },
        fixtureInputs([{}, {}]),
      ),
    );
    expect(candidates).toHaveLength(0);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.candidateId).toBe(`${lendingLifecycleTemplate.id}#0`);
    expect(skipped[0]!.reason).toContain("incompatible-environment");
  });

  it("never yields two candidates with the same id from one run", async () => {
    const env = buildFixtureDerivationEnvironment();
    const candidates = await collectAsync(
      chainScenarioStrategy.derive(
        {},
        env,
        fixtureInputs([{ borrowAmount: "1" }, { borrowAmount: "2" }, { borrowAmount: "3" }]),
      ),
    );
    const ids = new Set(candidates.map((candidate) => candidate.id));
    expect(ids.size).toBe(candidates.length);
  });
});

describe("loadChainDerivationEnvironment", () => {
  it("derives record, digest and bytes from one source of truth", () => {
    const env = buildFixtureDerivationEnvironment();
    const chainBytes = sealChainEnvironmentRecord(env.chainRecord);
    const reloaded = loadChainDerivationEnvironment(env.recordBytes, chainBytes);
    expect(reloaded.record).toStrictEqual(parseCryptoEnvironmentRecord(env.recordBytes));
    expect(reloaded.recordDigest).toBe(cryptoEnvironmentRecordDigest(env.recordBytes));
    expect(reloaded.recordBytes).toEqual(env.recordBytes);
    expect(reloaded.chainRecord).toStrictEqual(env.chainRecord);
    expect(reloaded.roleAddresses).toStrictEqual(env.roleAddresses);
  });

  it("refuses bytes that are not a composite crypto-environment record", () => {
    const chainBytes = sealChainEnvironmentRecord(buildFixtureDerivationEnvironment().chainRecord);
    expect(() => loadChainDerivationEnvironment(chainBytes, chainBytes)).toThrow(
      expect.objectContaining({ category: "invalid-input" }),
    );
  });
});
