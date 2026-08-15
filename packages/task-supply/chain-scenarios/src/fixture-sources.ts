// SPDX-License-Identifier: Apache-2.0

import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  type ChainEnvironmentRecord,
  type CryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";

import { assertFreshFixtureAddress } from "./fixture-accounts.js";

export function fixtureRoleAddress(byte: string): string {
  const normalized = byte.padStart(2, "0").slice(0, 2);
  return assertFreshFixtureAddress(`0x${normalized.repeat(20)}`, `fixture-${byte}`);
}

function localChainShell(): Omit<ChainEnvironmentRecord, "fixtures" | "capabilityEnvelope"> {
  return {
    kind: CHAIN_ENVIRONMENT_KIND,
    runtime: {
      family: "anvil",
      version: "1.3.7",
      image: {
        manifestDigest: `sha256:${"1".repeat(64)}`,
        indexDigest: `sha256:${"2".repeat(64)}`,
        platform: "linux/amd64",
        reference: `registry.example.test/chain/anvil@sha256:${"1".repeat(64)}`,
      },
      binary: { name: "anvil", digest: `sha256:${"2".repeat(64)}`, version: "1.3.7" },
      evm: { hardfork: "cancun", sandboxChainId: 1, nonDefaultSettings: { "disable-code-size-limit": false } },
      launch: { commandEvidence: "anvil --no-mining --order fifo", options: { "no-mining": true, order: "fifo" } },
    },
    stateMaterialization: {
      closureClass: "closed-state",
      fidelityClass: "local",
      constructionMethod: "local-construction",
      materializer: { id: "anvil-state-loader", version: "0.4.1", digest: `sha256:${"3".repeat(64)}` },
      stateArtifact: {
        descriptor: { name: "state.json", digest: { sha256: "4".repeat(64) } },
        format: { id: "jinn.chain-state-slice", version: "1" },
        entryCounts: { accounts: 12, storageSlots: 24, codeEntries: 2 },
      },
      initialStateCommitment: `0x${"7".repeat(64)}`,
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
      coinbase: fixtureRoleAddress("c0"),
      prevrandao: `0x${"9".repeat(64)}`,
      replacementPolicy: "reject",
      noncePolicy: "strict",
      timeoutClock: "chain-time",
      timeWarp: { maxSecondsPerOperation: 86_400, maxAggregateSeconds: 2_592_000, maxBlocksPerOperation: 7200 },
      resetMechanism: "fresh-process",
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
      fixtureProbeCoverage: [{ fixtureId: "accounts", probeIds: ["accounts-smoke"] }],
      policyId: "jinn.chain-verification-policy/1",
    },
  };
}

/** Local-fidelity lending fixture: roles both families' checklists reference. */
export function buildLendingChainRecordBody(): ChainEnvironmentRecord {
  const shell = localChainShell();
  const accounts = [
    { role: "pool", address: fixtureRoleAddress("a1"), nativeBalanceWei: "10000000000000000000" },
    { role: "collateral-token", address: fixtureRoleAddress("a2"), nativeBalanceWei: "10000000000000000000" },
    { role: "debt-token", address: fixtureRoleAddress("a3"), nativeBalanceWei: "10000000000000000000" },
    { role: "price-oracle", address: fixtureRoleAddress("a4"), nativeBalanceWei: "10000000000000000000" },
    { role: "token", address: fixtureRoleAddress("a5"), nativeBalanceWei: "10000000000000000000" },
    { role: "whale", address: fixtureRoleAddress("a6"), nativeBalanceWei: "10000000000000000000" },
    { role: "treasury", address: fixtureRoleAddress("a7"), nativeBalanceWei: "10000000000000000000" },
    { role: "dex-router", address: fixtureRoleAddress("a8"), nativeBalanceWei: "10000000000000000000" },
    { role: "borrower", address: fixtureRoleAddress("a9"), nativeBalanceWei: "10000000000000000000" },
  ];
  return {
    ...shell,
    fixtures: {
      modules: [
        {
          id: "accounts",
          kind: "funded-accounts",
          module: { digest: { sha256: "8".repeat(64) }, name: "accounts" },
        },
      ],
      accounts,
    },
    capabilityEnvelope: {
      toolInterfaces: [
        {
          id: "jinn.chain-tools",
          version: "1.0",
          schema: { digest: { sha256: "a".repeat(64) }, name: "tools" },
        },
      ],
      rpc: {
        readMethods: ["eth_call", "eth_getBalance", "eth_getBlockByNumber", "eth_getTransactionReceipt"],
        stateChangingMethods: ["eth_sendRawTransaction", "evm_mine", "evm_increaseTime"],
      },
      signerRoles: [{ role: "borrower", accounts: [fixtureRoleAddress("a9")] }],
      permittedChainId: 1,
      limits: {
        maxTransactions: 50,
        maxAggregateNativeValueWei: "10000000000000000000",
        tokenSpendPolicies: [],
        maxGasPerTransaction: "10000000",
        maxAggregateGas: "120000000",
        maxExecutionDurationMs: 900_000,
        maxBlockAdvance: 1000,
        maxChainSecondsAdvance: 1_209_600,
      },
      egressPolicyId: "jinn.egress.blackhole/1",
    },
  } as unknown as ChainEnvironmentRecord;
}

/** Local-fidelity approval-hygiene fixture with disjoint addresses from lending. */
export function buildApprovalChainRecordBody(): ChainEnvironmentRecord {
  const shell = localChainShell();
  const accounts = [
    { role: "token", address: fixtureRoleAddress("b1"), nativeBalanceWei: "10000000000000000000" },
    { role: "owner", address: fixtureRoleAddress("b2"), nativeBalanceWei: "10000000000000000000" },
    { role: "unsafe-spender-a", address: fixtureRoleAddress("b3"), nativeBalanceWei: "10000000000000000000" },
    { role: "unsafe-spender-b", address: fixtureRoleAddress("b4"), nativeBalanceWei: "10000000000000000000" },
    { role: "retained-spender", address: fixtureRoleAddress("b5"), nativeBalanceWei: "10000000000000000000" },
    { role: "token-minter", address: fixtureRoleAddress("b6"), nativeBalanceWei: "10000000000000000000" },
  ];
  return {
    ...shell,
    fixtures: {
      modules: [
        {
          id: "accounts",
          kind: "funded-accounts",
          module: { digest: { sha256: "8".repeat(64) }, name: "accounts" },
        },
      ],
      accounts,
    },
    capabilityEnvelope: {
      toolInterfaces: [
        {
          id: "jinn.chain-tools",
          version: "1.0",
          schema: { digest: { sha256: "a".repeat(64) }, name: "tools" },
        },
      ],
      rpc: {
        readMethods: ["eth_call", "eth_getBalance", "eth_getBlockByNumber", "eth_getTransactionReceipt"],
        stateChangingMethods: ["eth_sendRawTransaction", "evm_mine", "evm_increaseTime"],
      },
      signerRoles: [{ role: "owner", accounts: [fixtureRoleAddress("b2")] }],
      permittedChainId: 1,
      limits: {
        maxTransactions: 50,
        maxAggregateNativeValueWei: "10000000000000000000",
        tokenSpendPolicies: [],
        maxGasPerTransaction: "10000000",
        maxAggregateGas: "120000000",
        maxExecutionDurationMs: 900_000,
        maxBlockAdvance: 1000,
        maxChainSecondsAdvance: 1_209_600,
      },
      egressPolicyId: "jinn.egress.blackhole/1",
    },
  } as unknown as ChainEnvironmentRecord;
}

export function buildCompositeRecordBody(chainDigestBare: string): CryptoEnvironmentRecord {
  return {
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
  };
}

export interface FixtureSourceBundle {
  readonly chain: ChainEnvironmentRecord;
  readonly composite: CryptoEnvironmentRecord;
}
