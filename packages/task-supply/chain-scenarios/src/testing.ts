// SPDX-License-Identifier: Apache-2.0

import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_MEDIA_TYPE,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import type { CanonicalChainObservation, StatePredicateBlock } from "@jinn-network/task-execution-profiles";
import {
  PREDICATE_SEMANTICS_VERSION,
  stateReadKey,
} from "@jinn-network/task-execution-profiles";

import { toBareHex } from "./digest.js";
import {
  LendingLifecycleParamsSchema,
  type LendingLifecycleParams,
} from "./families/lending-lifecycle.js";
import { eventSignatureTopic0, addressIndexedTopic } from "./predicates.js";
import { loadChainDerivationEnvironment } from "./strategy.js";
import type { ChainDerivationEnvironment, ScenarioTemplate, StatePredicateDraft } from "./template.js";
import { resolveRoleAddress } from "./template.js";

const STUB_ABI_DIGEST = "a".repeat(64);
const BORROW_SIGNATURE = "Borrow(address,address,address,uint256,uint8,uint256,uint16)";
const SUPPLY_SIGNATURE = "Supply(address,address,address,uint256,uint16)";

function roleAddress(byte: string): string {
  return `0x${byte.repeat(20)}`;
}

function uint256Word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function stripSignerRoles(
  tightenings: StatePredicateDraft["envelopeTightenings"],
): StatePredicateBlock["envelopeTightenings"] | undefined {
  if (tightenings === undefined) return undefined;
  const { signerRoles: _signerRoles, ...rest } = tightenings;
  if (Object.keys(rest).length === 0) return undefined;
  return rest;
}

export function fixtureEnvironment(): ChainDerivationEnvironment {
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

export const LENDING_PARAMS: LendingLifecycleParams = LendingLifecycleParamsSchema.parse({});

function healthFactorReadKey(pool: string, borrower: string): string {
  return stateReadKey({
    kind: "call",
    to: pool,
    call: {
      abiRef: { digest: { sha256: STUB_ABI_DIGEST } },
      function: "getUserAccountData(address)",
      args: [{ type: "address", value: borrower }],
    },
  });
}

function debtBalanceReadKey(debtToken: string, borrower: string): string {
  return stateReadKey({ kind: "erc20Balance", token: debtToken, account: borrower });
}

function observationShell(env: ChainDerivationEnvironment): CanonicalChainObservation {
  const digest = env.recordDigest.slice("sha256:".length);
  return {
    observationVersion: "1",
    environmentRecord: `sha256:${digest}`,
    informationWorlds: ["fixture-world"],
    replay: { status: "completed" },
    timeline: {
      initialBlockNumber: "21000001",
      initialChainTimestamp: "1735689612",
      finalStateChangingBlockNumber: "21000001",
      finalStateChangingChainTimestamp: "1735689612",
    },
    transactions: [],
    blocks: [{
      number: "21000001",
      timestamp: "1735689612",
      hash: `0x${"0".repeat(64)}`,
    }],
    touchedState: [],
    traceProjectionDigest: `sha256:${"b".repeat(64)}`,
    finalStateCommitment: `0x${"c".repeat(64)}`,
    errorClasses: [],
    stateReads: [],
    sourceReads: [],
    sourceConsultations: [],
    reports: [],
  };
}

function protocolEventTopics(
  reserve: string,
  user: string,
  onBehalfOf: string,
): [`0x${string}`, `0x${string}`, `0x${string}`] {
  return [
    addressIndexedTopic(reserve),
    addressIndexedTopic(user),
    addressIndexedTopic(onBehalfOf),
  ];
}

function successTransaction(
  index: number,
  logs: CanonicalChainObservation["transactions"][number]["logs"],
): CanonicalChainObservation["transactions"][number] {
  return {
    index: String(index),
    hash: `0x${String(index).padStart(64, "0")}`,
    from: roleAddress("08"),
    to: roleAddress("01"),
    valueWei: "0",
    status: "success",
    gasUsed: "100000",
    returnData: "0x",
    logs,
    blockNumber: "21000002",
    blockTimestamp: "1735689624",
  };
}

export function baselineObservation(): CanonicalChainObservation {
  const env = fixtureEnvironment();
  const pool = resolveRoleAddress(env, "pool");
  const borrower = resolveRoleAddress(env, "borrower");
  const collateral = resolveRoleAddress(env, LENDING_PARAMS.collateralTokenRole);
  const debtToken = resolveRoleAddress(env, LENDING_PARAMS.debtTokenRole);
  const minHealth = BigInt(LENDING_PARAMS.minHealthFactor);
  const supplyTopics = protocolEventTopics(collateral, borrower, borrower);

  const observation = observationShell(env);
  observation.transactions = [
    successTransaction(0, [{
      index: "0",
      address: pool,
      topics: [
        eventSignatureTopic0(SUPPLY_SIGNATURE),
        ...supplyTopics,
      ],
      data: "0x",
    }]),
  ];
  observation.stateReads = [
    {
      key: healthFactorReadKey(pool, borrower),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(minHealth + 1n),
    },
    {
      key: debtBalanceReadKey(debtToken, borrower),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(0n),
    },
  ];
  return observation;
}

export function referenceObservation(): CanonicalChainObservation {
  const env = fixtureEnvironment();
  const pool = resolveRoleAddress(env, "pool");
  const borrower = resolveRoleAddress(env, "borrower");
  const collateral = resolveRoleAddress(env, LENDING_PARAMS.collateralTokenRole);
  const debtToken = resolveRoleAddress(env, LENDING_PARAMS.debtTokenRole);
  const borrowAmount = BigInt(LENDING_PARAMS.borrowAmount);
  const minHealth = BigInt(LENDING_PARAMS.minHealthFactor);
  const supplyTopics = protocolEventTopics(collateral, borrower, borrower);
  const borrowTopics = protocolEventTopics(debtToken, borrower, borrower);

  const observation = observationShell(env);
  observation.timeline.finalStateChangingBlockNumber = "21000005";
  observation.timeline.finalStateChangingChainTimestamp = "1735689648";
  observation.transactions = [
    successTransaction(0, []),
    successTransaction(1, [{
      index: "0",
      address: pool,
      topics: [
        eventSignatureTopic0(SUPPLY_SIGNATURE),
        ...supplyTopics,
      ],
      data: "0x",
    }]),
    successTransaction(2, []),
    successTransaction(3, [{
      index: "0",
      address: pool,
      topics: [
        eventSignatureTopic0(BORROW_SIGNATURE),
        ...borrowTopics,
      ],
      data: "0x",
    }]),
  ];
  observation.stateReads = [
    {
      key: healthFactorReadKey(pool, borrower),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(minHealth + 1n),
    },
    {
      key: debtBalanceReadKey(debtToken, borrower),
      state: "post-replay",
      resolution: "resolved",
      value: uint256Word(borrowAmount),
    },
  ];
  return observation;
}

export function predicateBlockFromDraft(
  draft: StatePredicateDraft,
  env: ChainDerivationEnvironment,
  timeout: number,
): StatePredicateBlock {
  return {
    environmentRecord: {
      digest: { sha256: toBareHex(env.recordDigest, "environmentRecord") },
      mediaType: CRYPTO_ENVIRONMENT_MEDIA_TYPE,
    },
    predicateSemanticsVersion: PREDICATE_SEMANTICS_VERSION,
    successPredicates: [...draft.successPredicates],
    safetyConstraints: [...draft.safetyConstraints],
    measurements: draft.measurements as StatePredicateBlock["measurements"],
    ...(stripSignerRoles(draft.envelopeTightenings) !== undefined
      ? { envelopeTightenings: stripSignerRoles(draft.envelopeTightenings) }
      : {}),
    timeout,
  };
}

export function predicateBlockFromTemplate<TParams>(
  template: ScenarioTemplate<TParams>,
  env: ChainDerivationEnvironment,
  params: TParams,
): StatePredicateBlock {
  const draft = template.predicateTemplate(params, env);
  return predicateBlockFromDraft(draft, env, template.timeout);
}
