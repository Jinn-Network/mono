import { describe, expect, test } from "vitest";

import { BLACKHOLE_EGRESS_POLICY_ID, CHAIN_ENVIRONMENT_KIND } from "./identifiers.js";
import { chainEnvironmentRecordDigest } from "./hashing.js";
import {
  ChainEnvironmentRecordSchema,
  parseChainEnvironmentRecord,
  requiresStateBackend,
  sealChainEnvironmentRecord,
} from "./chain-record.js";

const AGENT = `0x${"a1".repeat(20)}`;
const COUNTERPARTY = `0x${"b2".repeat(20)}`;

/** The reference world every case below mutates: closed-state, anchored-subset, K=5. */
const record = () => ({
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
      { role: "agent", address: AGENT, nativeBalanceWei: "10000000000000000000" },
      { role: "counterparty", address: COUNTERPARTY, nativeBalanceWei: "0" },
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
    signerRoles: [{ role: "agent", accounts: [AGENT] }],
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
});

const parse = (document: unknown) => ChainEnvironmentRecordSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("chain environment record", () => {
  test("accepts the reference closed-state anchored-subset world", () => {
    expect(parse(record()).success).toBe(true);
  });

  test("pins the kind: another kind URI is a different record kind, not an extension", () => {
    expect(parse({ ...record(), kind: "https://jinn.network/records/environment/1.0" }).success).toBe(false);
  });

  test("carries no mutable status: staleness is derived from attestation history", () => {
    for (const key of ["status", "health", "expiresAt", "verified"]) {
      expect(parse({ ...record(), [key]: "x" }).success, key).toBe(false);
    }
  });

  test("accepts a namespaced extension key and refuses a bare one", () => {
    expect(parse({ ...record(), "network.jinn.note": "hello" }).success).toBe(true);
    expect(parse({ ...record(), note: "hello" }).success).toBe(false);
  });

  test("accepts an optional supersedes pointer for promotion lineage (E12)", () => {
    expect(
      parse({ ...record(), supersedes: { name: "prior", digest: { sha256: "f".repeat(64) } } }).success,
    ).toBe(true);
  });
});

describe("cross-block invariants", () => {
  test("an anchor is present exactly when fidelity is not local", () => {
    const anchored = record() as Record<string, unknown>;
    delete anchored.sourceAnchor;
    expect(parse(anchored).success).toBe(false);

    const local = record();
    local.stateMaterialization.fidelityClass = "local";
    local.stateMaterialization.constructionMethod = "local-construction";
    delete (local.stateMaterialization as Record<string, unknown>).sourceProofManifest;
    delete (local.stateMaterialization as Record<string, unknown>).fixtureCoverage;
    delete (local.stateMaterialization as Record<string, unknown>).mutatesSourceProtocolState;
    local.stateMaterialization.stateArtifact.entryCounts = { accounts: 5, storageSlots: 20, codeEntries: 2 };
    expect(parse(local).success).toBe(false); // still carries an anchor
    delete (local as Record<string, unknown>).sourceAnchor;
    expect(parse(local).success).toBe(true);
  });

  // The single most likely verifier bug the design calls out by name: comparing post-fixture
  // state to the source root and calling the difference an error.
  test("refuses the source state root presented as the initial state commitment", () => {
    const document = record();
    document.stateMaterialization.initialStateCommitment = document.sourceAnchor.stateRoot;
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("initialStateCommitment");
  });

  test("the permitted chain id is the sandbox's, and must agree with the runtime", () => {
    const document = record();
    document.capabilityEnvelope.permittedChainId = 8453;
    expect(parse(document).success).toBe(false);
  });

  test("every signer account must be a declared fixture account", () => {
    const document = record();
    document.capabilityEnvelope.signerRoles = [{ role: "agent", accounts: [`0x${"e9".repeat(20)}`] }];
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("fixture account");
  });

  test("every fixture module must declare its smoke probes, and no others may be declared", () => {
    const missing = record();
    missing.verificationContract.fixtureProbeCoverage = [];
    expect(parse(missing).success).toBe(false);

    const extra = record();
    extra.verificationContract.fixtureProbeCoverage.push({ fixtureId: "ghost", probeIds: ["p"] });
    expect(parse(extra).success).toBe(false);
  });

  test("a closed-state world declares the blackhole egress policy and requires the closure check", () => {
    const policy = record();
    (policy.capabilityEnvelope as Record<string, unknown>).egressPolicyId = "jinn.egress.permissive/1";
    expect(parse(policy).success).toBe(false);

    const check = record();
    check.verificationContract.closureCheckRequired = false;
    expect(parse(check).success).toBe(false);
  });

  test("a closed-state world resets by fresh process, never by snapshot revert", () => {
    const document = record();
    document.determinismControls.resetMechanism = "snapshot-revert";
    expect(parse(document).success).toBe(false);
  });
});

describe("requiresStateBackend", () => {
  test("an archive-dependent record needs an injected backend; a closed-state one does not", () => {
    const closed = ChainEnvironmentRecordSchema.parse(record());
    expect(requiresStateBackend(closed)).toBe(false);

    const archive = record();
    archive.stateMaterialization.closureClass = "archive-dependent";
    delete (archive.stateMaterialization as Record<string, unknown>).stateArtifact;
    delete (archive.stateMaterialization as Record<string, unknown>).sourceProofManifest;
    delete (archive.stateMaterialization as Record<string, unknown>).fixtureCoverage;
    (archive.stateMaterialization as Record<string, unknown>).archive = { requiredCapabilities: ["eth_getProof"] };
    (archive.capabilityEnvelope as Record<string, unknown>).egressPolicyId = "jinn.egress.archive-only/1";
    archive.verificationContract.closureCheckRequired = false;
    expect(requiresStateBackend(ChainEnvironmentRecordSchema.parse(archive))).toBe(true);
  });
});

describe("sealing", () => {
  test("seals to bytes whose sha256 is the record's identity", () => {
    const sealed = sealChainEnvironmentRecord(record());
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(chainEnvironmentRecordDigest(sealed)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("sealing is idempotent through a parse", () => {
    const once = sealChainEnvironmentRecord(record());
    const twice = sealChainEnvironmentRecord(parseChainEnvironmentRecord(once));
    expect(chainEnvironmentRecordDigest(twice)).toBe(chainEnvironmentRecordDigest(once));
  });

  test("re-canonicalized bytes do not present as the same record", () => {
    const pretty = new TextEncoder().encode(JSON.stringify(record(), null, 2));
    expect(() => parseChainEnvironmentRecord(pretty)).toThrow();
  });

  test("key order in the input does not reach the sealed bytes", () => {
    const forward = sealChainEnvironmentRecord(record());
    const reversed = Object.fromEntries(Object.entries(record()).reverse());
    expect(chainEnvironmentRecordDigest(sealChainEnvironmentRecord(reversed)))
      .toBe(chainEnvironmentRecordDigest(forward));
  });
});
