// Generates the golden, equivalence, invalid, and adversarial corpora from the package's own
// compiled schema. Fixtures are derived from the specification and this generator, never
// captured from a product run. `--write` regenerates; `--check` (the default) detects drift.
//
// Every fixture address below was generated for this corpus and appears in exactly one record.
// The `well-known-fixture-address` case is the sole deliberate exception, and it is declared
// `invalid-document`: it exists to prove the lint fires.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixturesRoot = join(root, "fixtures");

const {
  BLACKHOLE_EGRESS_POLICY_ID,
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} = await import(join(root, "dist", "index.js"));

const INFORMATION_KIND = "https://jinn.network/records/information-world/1.0";
const prefixed = (hex) => `sha256:${hex.repeat(64)}`;
const bare = (hex) => hex.repeat(64);
const word = (hex) => `0x${hex.repeat(64)}`;
const address = (hex) => `0x${hex.repeat(20)}`;

const runtime = () => ({
  family: "anvil",
  version: "1.3.7",
  image: {
    manifestDigest: prefixed("1"),
    platform: "linux/amd64",
    reference: `registry.example.test/chain/anvil@${prefixed("1")}`,
    indexDigest: prefixed("2"),
  },
  binary: { name: "anvil", digest: prefixed("3"), version: "1.3.7" },
  evm: { hardfork: "cancun", sandboxChainId: 1, nonDefaultSettings: { "disable-code-size-limit": false } },
  launch: { options: { "no-mining": true, order: "fifo" }, commandEvidence: "anvil --no-mining --order fifo" },
});

const anchor = () => ({
  caip2ChainId: "eip155:1",
  nativeChainId: 1,
  genesisHash: word("d"),
  blockNumber: 21000000,
  blockHash: word("e"),
  stateRoot: word("f"),
  timestamp: 1735689600,
  finalityPolicy: "finalized",
});

const controls = () => ({
  miningMode: "manual",
  orderingPolicy: "fifo",
  mempoolPolicy: "none",
  initialBlockNumber: 21000001,
  initialTimestamp: 1735689612,
  blockTimeProgression: { mode: "fixed-increment", secondsPerBlock: 12 },
  baseFeePolicy: { mode: "fixed", weiPerGas: "1000000000" },
  gasPricePolicy: { mode: "fixed", weiPerGas: "1000000000" },
  blockGasLimit: "30000000",
  perTransactionGasCeiling: "15000000",
  coinbase: address("c0"),
  prevrandao: word("9"),
  replacementPolicy: "reject",
  noncePolicy: "strict",
  timeoutClock: "chain-time",
  timeWarp: { maxSecondsPerOperation: 86400, maxAggregateSeconds: 2592000, maxBlocksPerOperation: 7200 },
  resetMechanism: "fresh-process",
});

const envelope = (agent) => ({
  toolInterfaces: [{ id: "jinn.chain-tools", version: "1.0", schema: { name: "tools", digest: { sha256: bare("a") } } }],
  rpc: {
    readMethods: ["eth_call", "eth_getBalance", "eth_getBlockByNumber", "eth_getTransactionReceipt"],
    stateChangingMethods: ["eth_sendRawTransaction", "evm_mine", "evm_increaseTime"],
  },
  signerRoles: [{ role: "agent", accounts: [agent] }],
  permittedChainId: 1,
  limits: {
    maxTransactions: 25,
    maxAggregateNativeValueWei: "5000000000000000000",
    tokenSpendPolicies: [{ token: address("d0"), maxSpendUnits: "1000000000" }],
    maxGasPerTransaction: "5000000",
    maxAggregateGas: "60000000",
    maxExecutionDurationMs: 600000,
    maxBlockAdvance: 500,
    maxChainSecondsAdvance: 604800,
  },
  egressPolicyId: BLACKHOLE_EGRESS_POLICY_ID,
});

const verificationContract = (fixtureIds) => ({
  probeSuite: { descriptor: { name: "probes", digest: { sha256: bare("b") } }, format: { id: "jinn.chain-probes", version: "1" } },
  observationSchema: { name: "observation.schema.json", digest: { sha256: bare("c") } },
  baselineObservationDigest: prefixed("d"),
  comparator: { id: "canonical-observation-eq", version: "1.0.0", digest: prefixed("e") },
  closureCheckRequired: true,
  resetRequirements: { freshInstancePerRun: true, minimumRuns: 5 },
  fixtureProbeCoverage: fixtureIds.map((fixtureId) => ({ fixtureId, probeIds: [`${fixtureId}-smoke`] })),
  policyId: "jinn.chain-verification-policy/1",
});

/** closed-state + anchored-subset: the durable class, with a declared protocol-state mutation. */
const closedAnchoredSubset = () => ({
  kind: CHAIN_ENVIRONMENT_KIND,
  runtime: runtime(),
  sourceAnchor: anchor(),
  stateMaterialization: {
    closureClass: "closed-state",
    fidelityClass: "anchored-subset",
    constructionMethod: "archive-extraction",
    materializer: { id: "anvil-state-loader", version: "0.4.1", digest: prefixed("4") },
    stateArtifact: {
      descriptor: { name: "state.json", mediaType: "application/json", digest: { sha256: bare("5") } },
      format: { id: "jinn.chain-state-slice", version: "1" },
      entryCounts: { accounts: 12, storageSlots: 340, codeEntries: 7 },
    },
    sourceProofManifest: {
      proofFormat: "eip-1186",
      proofs: { name: "proofs.json", digest: { sha256: bare("6") } },
      coverage: { accounts: 9, storageSlots: 331, codeEntries: 7 },
    },
    fixtureCoverage: {
      manifest: { name: "mutations.json", digest: { sha256: bare("7") } },
      declared: { accounts: 3, storageSlots: 9, codeEntries: 0 },
      mutatedProofCoveredAccounts: 2,
    },
    mutatesSourceProtocolState: true,
    initialStateCommitment: word("8"),
  },
  fixtures: {
    modules: [
      { id: "accounts", kind: "funded-accounts", module: { name: "accounts", digest: { sha256: bare("1") } } },
      { id: "addresses", kind: "address-book", module: { name: "addresses", digest: { sha256: bare("2") } } },
      { id: "rates", kind: "state-mutation", module: { name: "rates", digest: { sha256: bare("3") } } },
    ],
    accounts: [
      { role: "agent", address: address("a1"), nativeBalanceWei: "10000000000000000000" },
      { role: "counterparty", address: address("a2"), nativeBalanceWei: "0" },
    ],
  },
  determinismControls: controls(),
  capabilityEnvelope: envelope(address("a1")),
  verificationContract: verificationContract(["accounts", "addresses", "rates"]),
});

/** closed-state + local: no correspondence to any public chain is claimed. */
const closedLocal = () => {
  const record = closedAnchoredSubset();
  delete record.sourceAnchor;
  record.stateMaterialization = {
    closureClass: "closed-state",
    fidelityClass: "local",
    constructionMethod: "local-construction",
    materializer: { id: "anvil-state-loader", version: "0.4.1", digest: prefixed("4") },
    stateArtifact: {
      descriptor: { name: "state.json", digest: { sha256: bare("9") } },
      format: { id: "jinn.chain-state-slice", version: "1" },
      entryCounts: { accounts: 4, storageSlots: 12, codeEntries: 2 },
    },
    initialStateCommitment: word("a"),
  };
  record.fixtures.accounts = [
    { role: "agent", address: address("b1"), nativeBalanceWei: "10000000000000000000" },
    { role: "counterparty", address: address("b2"), nativeBalanceWei: "0" },
  ];
  record.capabilityEnvelope = envelope(address("b1"));
  return record;
};

/** archive-dependent: the authoring/observation class, never durable supply. */
const archiveDependent = () => {
  const record = closedAnchoredSubset();
  record.stateMaterialization = {
    closureClass: "archive-dependent",
    fidelityClass: "anchored-subset",
    constructionMethod: "archive-extraction",
    materializer: { id: "anvil-fork", version: "0.4.1", digest: prefixed("4") },
    archive: {
      requiredCapabilities: ["eth_getProof", "eth_getStorageAt", "eth_getCode"],
      providerLocators: ["https://archive.example.test"],
    },
    mutatesSourceProtocolState: false,
    initialStateCommitment: word("b"),
  };
  record.determinismControls = { ...controls(), resetMechanism: "snapshot-revert" };
  record.verificationContract = { ...verificationContract(["accounts", "addresses", "rates"]), closureCheckRequired: false };
  record.capabilityEnvelope = { ...envelope(address("c1")), egressPolicyId: "jinn.egress.archive-only/1" };
  record.fixtures.accounts = [
    { role: "agent", address: address("c1"), nativeBalanceWei: "10000000000000000000" },
    { role: "counterparty", address: address("c2"), nativeBalanceWei: "0" },
  ];
  return record;
};

const chainOnlyComposite = () => ({
  kind: CRYPTO_ENVIRONMENT_KIND,
  chainWorld: { kind: CHAIN_ENVIRONMENT_KIND, record: { name: "chain", digest: { sha256: bare("1") } } },
  informationWorlds: [],
  serviceRuntimes: [],
  composition: {
    originRouting: [],
    missPolicy: { mode: "declared-response", status: 404 },
    endpointAllowlist: [],
    requestBudget: { maxRequests: 0, maxResponseBytes: 0 },
  },
});

/** Two worlds, one shared origin, precedence declared and total. */
const composedComposite = () => ({
  ...chainOnlyComposite(),
  informationWorlds: [
    { id: "yields", kind: INFORMATION_KIND, record: { name: "yields", digest: { sha256: bare("2") } } },
    { id: "docs", kind: INFORMATION_KIND, record: { name: "docs", digest: { sha256: bare("3") } } },
  ],
  serviceRuntimes: [
    { id: "replay", family: "http-replay", version: "0.2.0", image: { manifestDigest: prefixed("4"), platform: "linux/amd64" } },
  ],
  composition: {
    originRouting: [
      { origin: "https://api.example.test", worldId: "yields", precedence: 0 },
      { origin: "https://api.example.test", worldId: "docs", precedence: 1 },
      { origin: "https://docs.example.test", worldId: "docs", precedence: 0 },
    ],
    missPolicy: { mode: "declared-response", status: 404, body: { name: "miss", digest: { sha256: bare("5") } } },
    endpointAllowlist: ["https://api.example.test", "https://docs.example.test"],
    requestBudget: { maxRequests: 200, maxResponseBytes: 8388608 },
  },
});

const extensionComposite = () => ({
  ...composedComposite(),
  "network.jinn.note": "an extension key a future consumer added",
  "https://example.test/ext/provenance": { collector: "example" },
});

const invalid = {
  "index-digest-as-manifest": () => {
    const document = closedAnchoredSubset();
    document.runtime.image.indexDigest = document.runtime.image.manifestDigest;
    return document;
  },
  "artifact-entry-uncovered": () => {
    const document = closedAnchoredSubset();
    document.stateMaterialization.sourceProofManifest.coverage.storageSlots = 330;
    return document;
  },
  "anchor-root-as-initial-commitment": () => {
    const document = closedAnchoredSubset();
    document.stateMaterialization.initialStateCommitment = document.sourceAnchor.stateRoot;
    return document;
  },
  "bare-extension-key": () => ({ ...closedAnchoredSubset(), note: "not namespaced" }),
  "digest-confusion-bare-hex": () => {
    const document = closedAnchoredSubset();
    document.runtime.image.manifestDigest = bare("1");
    delete document.runtime.image.reference;
    return document;
  },
  "digest-confusion-prefixed-descriptor": () => {
    const document = closedAnchoredSubset();
    document.stateMaterialization.stateArtifact.descriptor.digest.sha256 = prefixed("5");
    return document;
  },
  "well-known-fixture-address": () => {
    const document = closedAnchoredSubset();
    document.fixtures.accounts[0].address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    document.capabilityEnvelope.signerRoles[0].accounts = ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"];
    return document;
  },
  "checksummed-address": () => {
    const document = closedAnchoredSubset();
    document.fixtures.accounts[1].address = "0xA2a2A2a2a2A2a2a2A2a2a2A2a2A2a2A2a2A2a2A2";
    return document;
  },
  "origin-precedence-undeclared": () => {
    const document = composedComposite();
    document.composition.originRouting = [
      { origin: "https://api.example.test", worldId: "yields", precedence: 0 },
      { origin: "https://api.example.test", worldId: "docs", precedence: 0 },
    ];
    return document;
  },
  "snapshot-reset-closed-state": () => {
    const document = closedAnchoredSubset();
    document.determinismControls.resetMechanism = "snapshot-revert";
    return document;
  },
};

const adversarial = {
  "index-digest-as-manifest": {
    recordKind: "chain-environment",
    description:
      "The multi-arch index digest presented as the platform manifest digest. Runtime behaviour "
      + "is a per-platform fact, so an index-level record would be a claim by aggregation.",
    expectedDisposition: "invalid-document",
    document: invalid["index-digest-as-manifest"],
  },
  "artifact-entry-uncovered": {
    recordKind: "chain-environment",
    description:
      "One storage entry in the state artifact is neither proof-covered nor fixture-declared. "
      + "This is the forged-slice gap E13 closes: real protocol code proven against the true "
      + "root, with one tampered slot riding along unaccounted for.",
    expectedDisposition: "invalid-document",
    document: invalid["artifact-entry-uncovered"],
  },
  "anchor-root-as-initial-commitment": {
    recordKind: "chain-environment",
    description:
      "The source anchor's state root presented as the post-fixture initial state commitment. "
      + "They are two claims about two different worlds, and a verifier told they are one would "
      + "read every legitimately fixtured world as a mismatch.",
    expectedDisposition: "invalid-document",
    document: invalid["anchor-root-as-initial-commitment"],
  },
  "origin-precedence-undeclared": {
    recordKind: "crypto-environment",
    description:
      "Two information worlds claiming one origin with no declared precedence between them. "
      + "Resolution would then depend on iteration order, which is a reproducibility hazard "
      + "rather than a merge.",
    expectedDisposition: "invalid-document",
    document: invalid["origin-precedence-undeclared"],
  },
  "bare-extension-key": {
    recordKind: "chain-environment",
    description:
      "An un-namespaced extension key at the top level, indistinguishable from a core field a "
      + "future version might add and therefore from a smuggled one.",
    expectedDisposition: "invalid-document",
    document: invalid["bare-extension-key"],
  },
  "digest-confusion-bare-hex": {
    recordKind: "chain-environment",
    description:
      "Digest confusion, subject spelling in a body position: a bare-hex in-toto DigestSet value "
      + "used where the record body requires the sha256:-prefixed spelling.",
    expectedDisposition: "invalid-document",
    document: invalid["digest-confusion-bare-hex"],
  },
  "well-known-fixture-address": {
    recordKind: "chain-environment",
    description:
      "A fixture account at a well-known development-mnemonic address whose private key is "
      + "public. Publishing scripts from it makes every one of them a replayable transaction "
      + "the moment anyone funds the address.",
    expectedDisposition: "invalid-document",
    document: invalid["well-known-fixture-address"],
  },
  "namespaced-extension-preserved": {
    recordKind: "crypto-environment",
    description:
      "A composite carrying namespaced extension keys, which must reach the sealed bytes and "
      + "re-parse unchanged rather than being dropped or refused.",
    expectedDisposition: "accepted",
    document: extensionComposite,
  },
  "recanonicalized-bytes": {
    recordKind: "chain-environment",
    description:
      "The golden chain record re-serialized with pretty-printing: a valid document whose bytes "
      + "are not the record's bytes, so it must not present as the same record.",
    expectedDisposition: "invalid-bytes",
    bytes: () => `${JSON.stringify(closedAnchoredSubset(), null, 2)}\n`,
  },
};

const write = process.argv.includes("--write");
const failures = [];

async function emit(relativePath, contents) {
  const target = join(fixturesRoot, relativePath);
  const text = typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`;
  if (write) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    return;
  }
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) failures.push(relativePath);
}

/** The pinned bytes are the sealed bytes — emitted verbatim, never pretty-printed. */
async function emitGolden(directory, name, build, seal, digest) {
  const sealed = seal(build());
  await emit(`${directory}/${name}.json`, new TextDecoder().decode(sealed));
  await emit(`${directory}/${name}.sha256`, `${digest(sealed)}\n`);
}

await emitGolden("chain", "closed-anchored-subset", closedAnchoredSubset, sealChainEnvironmentRecord, chainEnvironmentRecordDigest);
await emitGolden("chain", "closed-local", closedLocal, sealChainEnvironmentRecord, chainEnvironmentRecordDigest);
await emitGolden("chain", "archive-dependent", archiveDependent, sealChainEnvironmentRecord, chainEnvironmentRecordDigest);
await emitGolden("composite", "chain-only", chainOnlyComposite, sealCryptoEnvironmentRecord, cryptoEnvironmentRecordDigest);
await emitGolden("composite", "composed", composedComposite, sealCryptoEnvironmentRecord, cryptoEnvironmentRecordDigest);
await emitGolden("composite", "extension", extensionComposite, sealCryptoEnvironmentRecord, cryptoEnvironmentRecordDigest);

for (const [name, build] of Object.entries(invalid)) {
  await emit(`invalid/${name}.json`, build());
}

const permuted = (value) =>
  Array.isArray(value)
    ? value.map(permuted)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, permuted(member)]))
      : value;

await emit("equivalence/input-a.json", closedAnchoredSubset());
await emit("equivalence/input-b.json", permuted(closedAnchoredSubset()));
await emit("equivalence/expected-digest.json", {
  digest: chainEnvironmentRecordDigest(sealChainEnvironmentRecord(closedAnchoredSubset())),
});

const manifest = { fixtures: [] };
for (const [id, entry] of Object.entries(adversarial)) {
  if (entry.expectedDisposition === "invalid-bytes") {
    await emit(`adversarial-v1/${id}/document.bytes`, entry.bytes());
  } else {
    await emit(`adversarial-v1/${id}/document.json`, entry.document());
  }
  manifest.fixtures.push({
    id,
    description: entry.description,
    recordKind: entry.recordKind,
    expectedDisposition: entry.expectedDisposition,
  });
}
await emit("adversarial-v1/manifest.json", manifest);

if (!write && failures.length > 0) {
  console.error(`fixture drift in:\n${failures.map((path) => `  ${path}`).join("\n")}`);
  process.exit(1);
}
console.log(write ? "fixtures written" : "fixtures up to date");
