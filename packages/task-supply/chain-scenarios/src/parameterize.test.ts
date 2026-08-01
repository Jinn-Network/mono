// SPDX-License-Identifier: Apache-2.0
import {
  BLACKHOLE_EGRESS_POLICY_ID,
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
  type ChainEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import { describe, expect, it } from "vitest";

import { ScenarioError } from "./errors.js";
import { lendingLifecycleTemplate } from "./families/lending-lifecycle.js";
import {
  createFixtureAddressLedger,
  WELL_KNOWN_DEV_ADDRESSES,
  type ScenarioAccountPort,
} from "./fixture-accounts.js";
import {
  computeScenarioCommitment,
  parameterDigest,
  parameterize,
  PROMPT_INJECTION_SENTENCE,
} from "./parameterize.js";
import { CHAIN_REFERENCE_SCRIPT_SCHEMA_VERSION } from "./solution-script.js";
import { syntheticProbeAddress, type ChainDerivationEnvironment } from "./template.js";

function roleAddress(byte: string): string {
  return `0x${byte.repeat(20)}`;
}

const POOL = roleAddress("01");
const COLLATERAL = roleAddress("02");
const DEBT = roleAddress("03");
const ORACLE = roleAddress("04");
const WHALE = roleAddress("05");
const TREASURY = roleAddress("06");
const DEX = roleAddress("07");
const BORROWER_PLACEHOLDER = roleAddress("08");

function lendingChainRecord(
  overrides?: Partial<{
    closureClass: "closed-state" | "archive-dependent";
    limits: Partial<ChainEnvironmentRecord["capabilityEnvelope"]["limits"]>;
    roleAddresses: Record<string, string>;
  }>,
): ChainEnvironmentRecord {
  const roles = overrides?.roleAddresses ?? {
    pool: POOL,
    "collateral-token": COLLATERAL,
    "debt-token": DEBT,
    "price-oracle": ORACLE,
    whale: WHALE,
    treasury: TREASURY,
    "dex-router": DEX,
  };

  const base = {
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
      closureClass: overrides?.closureClass ?? "closed-state",
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
        ...Object.entries(roles).map(([role, address]) => ({
          role,
          address,
          nativeBalanceWei: "10000000000000000000",
        })),
        {
          role: "borrower",
          address: BORROWER_PLACEHOLDER,
          nativeBalanceWei: "10000000000000000000",
        },
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
        ...overrides?.limits,
      },
      egressPolicyId: BLACKHOLE_EGRESS_POLICY_ID,
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
  };

  if (overrides?.closureClass === "archive-dependent") {
    const state = base.stateMaterialization as Record<string, unknown>;
    state.closureClass = "archive-dependent";
    delete state.stateArtifact;
    delete state.sourceProofManifest;
    delete state.fixtureCoverage;
    state.archive = { requiredCapabilities: ["eth_getProof"] };
    (base.capabilityEnvelope as { egressPolicyId: string }).egressPolicyId = "jinn.egress.archive-only/1";
    base.verificationContract.closureCheckRequired = false;
  }

  return parseChainEnvironmentRecord(sealChainEnvironmentRecord(base));
}

function buildDerivationEnvironment(
  chainOverrides?: Parameters<typeof lendingChainRecord>[0],
): ChainDerivationEnvironment {
  const chainRecord = lendingChainRecord(chainOverrides);
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

function defaultDeps() {
  return {
    accounts: freshAccountPort(),
    ledger: createFixtureAddressLedger(),
  };
}

describe("parameterize binds one template, one parameter set and one record", () => {
  it("refuses parameters the template's schema rejects", async () => {
    await expect(
      parameterize(defaultDeps(), lendingLifecycleTemplate, { maxTransactions: "not-a-number" }, buildDerivationEnvironment()),
    ).rejects.toMatchObject({ category: "invalid-input" } satisfies Partial<ScenarioError>);
  });

  it("refuses a record whose closure class is not closed-state", async () => {
    await expect(
      parameterize(
        defaultDeps(),
        lendingLifecycleTemplate,
        {},
        buildDerivationEnvironment({ closureClass: "archive-dependent" }),
      ),
    ).rejects.toMatchObject({ category: "incompatible-environment" });
  });

  it("refuses a record missing a required protocol role", async () => {
    const env = buildDerivationEnvironment();
    const { pool: _pool, ...rest } = env.roleAddresses;
    await expect(
      parameterize(defaultDeps(), lendingLifecycleTemplate, {}, { ...env, roleAddresses: rest }),
    ).rejects.toMatchObject({ category: "incompatible-environment" });
  });

  it("refuses a record whose envelope is below the template's minimum", async () => {
    await expect(
      parameterize(
        defaultDeps(),
        lendingLifecycleTemplate,
        {},
        buildDerivationEnvironment({ limits: { maxTransactions: 1 } }),
      ),
    ).rejects.toMatchObject({ category: "incompatible-environment" });
  });

  it("fills environmentRecord from the record's own digest, so the two cannot disagree", async () => {
    const env = buildDerivationEnvironment();
    const candidate = await parameterize(defaultDeps(), lendingLifecycleTemplate, {}, env);
    expect(candidate.predicateBlock.environmentRecord.digest.sha256)
      .toBe(env.recordDigest.slice("sha256:".length));
  });

  it("derives lineage from template id, version, parameter digest and record digest", async () => {
    const env = buildDerivationEnvironment();
    const params = { borrowAmount: "600000000000000000" };
    const candidate = await parameterize(defaultDeps(), lendingLifecycleTemplate, params, env);
    expect(candidate.lineage).toEqual({
      templateId: lendingLifecycleTemplate.id,
      templateVersion: lendingLifecycleTemplate.version,
      parameterDigest: parameterDigest(lendingLifecycleTemplate.parameterSchema.parse(params)),
      environmentRecordDigest: env.recordDigest,
    });
    expect(candidate.sourceCommitment).toBe(
      computeScenarioCommitment(candidate.lineage, candidate.instructions),
    );
  });

  it("gives the same parameters the same digest regardless of key order", () => {
    expect(parameterDigest({ b: 2, a: 1 })).toBe(parameterDigest({ a: 1, b: 2 }));
  });

  it("gives different parameters different ids, so two instances never collide", async () => {
    const env = buildDerivationEnvironment();
    const deps = defaultDeps();
    const first = await parameterize(deps, lendingLifecycleTemplate, { borrowAmount: "1" }, env);
    const second = await parameterize(deps, lendingLifecycleTemplate, { borrowAmount: "2" }, env);
    expect(first.id).not.toBe(second.id);
  });

  it("runs the hardening check on every instance, not only on the template", async () => {
    const template = {
      ...lendingLifecycleTemplate,
      hardening: {
        ...lendingLifecycleTemplate.hardening,
        requiredProtocolEvents: [
          ...lendingLifecycleTemplate.hardening.requiredProtocolEvents,
          {
            predicateId: "phantom-event",
            contractRole: "pool",
            signature: "Repay(address,address,uint256)",
            why: "a checklist entry with no matching predicate",
          },
        ],
      },
    };
    await expect(
      parameterize(defaultDeps(), template, {}, buildDerivationEnvironment()),
    ).rejects.toMatchObject({ category: "unhardened-template" });
  });

  it("refuses a scenario account on the banned dev-address list", async () => {
    const banned = WELL_KNOWN_DEV_ADDRESSES[0];
    const port: ScenarioAccountPort = async (request) => ({
      role: request.role,
      address: banned,
    });
    await expect(
      parameterize(
        { accounts: port, ledger: createFixtureAddressLedger() },
        lendingLifecycleTemplate,
        {},
        buildDerivationEnvironment(),
      ),
    ).rejects.toMatchObject({ category: "unsafe-fixture-address" });
  });

  it("refuses a reference script that exceeds the tightened envelope", async () => {
    const template = {
      ...lendingLifecycleTemplate,
      referenceSolution: () => ({
        schemaVersion: CHAIN_REFERENCE_SCRIPT_SCHEMA_VERSION,
        operations: Array.from({ length: 10 }, (_, index) => ({
          op: "transactionIntent" as const,
          signerRole: "borrower",
          to: syntheticProbeAddress(0x20 + index),
          abiRef: "ERC20.approve(address,uint256)",
          args: [POOL, "0"],
          valueWei: "0",
        })),
      }),
    };
    await expect(
      parameterize(defaultDeps(), template, {}, buildDerivationEnvironment()),
    ).rejects.toMatchObject({ category: "envelope-violation" });
  });

  it("tightens the envelope only — a tightening that widens any ceiling is refused", async () => {
    await expect(
      parameterize(
        defaultDeps(),
        lendingLifecycleTemplate,
        {},
        buildDerivationEnvironment({ limits: { maxTransactions: 2 } }),
      ),
    ).rejects.toMatchObject({ category: "incompatible-environment" });
  });

  it("strips CE5-only signerRoles from sealed envelope tightenings", async () => {
    const candidate = await parameterize(
      defaultDeps(),
      lendingLifecycleTemplate,
      {},
      buildDerivationEnvironment(),
    );
    expect(candidate.predicateDraft.envelopeTightenings?.signerRoles).toEqual(["borrower"]);
    expect(candidate.predicateBlock.envelopeTightenings).not.toHaveProperty("signerRoles");
  });

  it("appends the standing prompt-injection sentence to instructions", async () => {
    const candidate = await parameterize(
      defaultDeps(),
      lendingLifecycleTemplate,
      {},
      buildDerivationEnvironment(),
    );
    expect(candidate.instructions.endsWith(PROMPT_INJECTION_SENTENCE)).toBe(true);
  });
});
