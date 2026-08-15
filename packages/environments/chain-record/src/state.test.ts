import { describe, expect, test } from "vitest";

import { ChainStateMaterializationSchema } from "./state.js";

const ARTIFACT = { name: "state.json", digest: { sha256: "a".repeat(64) } };
const PROOFS = { name: "proofs.json", digest: { sha256: "b".repeat(64) } };
const MUTATIONS = { name: "mutations.json", digest: { sha256: "c".repeat(64) } };

/** closed-state + anchored-subset: the durable class the family exists to produce. */
const closedAnchored = () => ({
  closureClass: "closed-state",
  fidelityClass: "anchored-subset",
  constructionMethod: "archive-extraction",
  materializer: { id: "anvil-state-loader", version: "0.4.1", digest: `sha256:${"d".repeat(64)}` },
  stateArtifact: {
    descriptor: ARTIFACT,
    format: { id: "jinn.chain-state-slice", version: "1" },
    entryCounts: { accounts: 12, storageSlots: 340, codeEntries: 7 },
  },
  sourceProofManifest: {
    proofFormat: "eip-1186",
    proofs: PROOFS,
    coverage: { accounts: 9, storageSlots: 331, codeEntries: 7 },
  },
  fixtureCoverage: {
    manifest: MUTATIONS,
    declared: { accounts: 3, storageSlots: 9, codeEntries: 0 },
    mutatedProofCoveredAccounts: 2,
  },
  mutatesSourceProtocolState: true,
  initialStateCommitment: `0x${"1".repeat(64)}`,
});

/** closed-state + local: nothing is claimed about any public chain. */
const closedLocal = () => ({
  closureClass: "closed-state",
  fidelityClass: "local",
  constructionMethod: "local-construction",
  materializer: { id: "anvil-state-loader", version: "0.4.1", digest: `sha256:${"d".repeat(64)}` },
  stateArtifact: {
    descriptor: ARTIFACT,
    format: { id: "jinn.chain-state-slice", version: "1" },
    entryCounts: { accounts: 4, storageSlots: 10, codeEntries: 2 },
  },
  initialStateCommitment: `0x${"2".repeat(64)}`,
});

/** archive-dependent: the authoring/observation class, never durable supply. */
const archiveDependent = () => ({
  closureClass: "archive-dependent",
  fidelityClass: "anchored-subset",
  constructionMethod: "archive-extraction",
  materializer: { id: "anvil-fork", version: "0.4.1", digest: `sha256:${"d".repeat(64)}` },
  archive: {
    requiredCapabilities: ["eth_getProof", "eth_getStorageAt", "debug_traceTransaction"],
    providerLocators: ["https://archive.example.test"],
  },
  mutatesSourceProtocolState: false,
  initialStateCommitment: `0x${"3".repeat(64)}`,
});

const parse = (document: unknown) => ChainStateMaterializationSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("state materialization (§4.3)", () => {
  test("accepts the three shapes the design names", () => {
    expect(parse(closedAnchored()).success).toBe(true);
    expect(parse(closedLocal()).success).toBe(true);
    expect(parse(archiveDependent()).success).toBe(true);
  });

  test("a closed-state world must commit a state artifact", () => {
    const document = closedAnchored() as Record<string, unknown>;
    delete document.stateArtifact;
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("stateArtifact");
  });

  test("a closed-state world declares no archive requirement", () => {
    const document = { ...closedAnchored(), archive: { requiredCapabilities: ["eth_getProof"] } };
    expect(parse(document).success).toBe(false);
  });

  test("an archive-dependent world must declare the capabilities it needs", () => {
    const document = archiveDependent() as Record<string, unknown>;
    delete document.archive;
    expect(parse(document).success).toBe(false);
  });

  test("a local world proves nothing against a source root", () => {
    const document = { ...closedLocal(), sourceProofManifest: closedAnchored().sourceProofManifest };
    expect(parse(document).success).toBe(false);
  });
});

// E13: every entry in the artifact is proof-covered or fixture-declared. The record-level
// half of the rule is arithmetic over three censuses; the artifact-level half is CE3's.
describe("artifact coverage (E13)", () => {
  test("accepts a record whose censuses add up exactly", () => {
    expect(parse(closedAnchored()).success).toBe(true);
  });

  test("refuses a record leaving storage slots neither proof-covered nor fixture-declared", () => {
    const document = closedAnchored();
    document.sourceProofManifest.coverage.storageSlots = 330; // one slot now uncovered
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("source-coverage-incomplete");
  });

  test("refuses double counting: the censuses may not exceed the artifact either", () => {
    const document = closedAnchored();
    document.fixtureCoverage.declared.accounts = 4; // 9 + 4 > 12
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("source-coverage-incomplete");
  });

  test("an anchored artifact with no proof manifest is coverage-incomplete, not merely sparse", () => {
    const document = closedAnchored() as Record<string, unknown>;
    delete document.sourceProofManifest;
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("source-coverage-incomplete");
  });

  test("mutating proof-covered protocol accounts must be visible without reading fixtures", () => {
    const document = closedAnchored();
    document.mutatesSourceProtocolState = false; // but 2 proof-covered accounts are mutated
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("mutatesSourceProtocolState");
  });

  test("a non-local record must state the mutation flag one way or the other", () => {
    const document = closedAnchored() as Record<string, unknown>;
    delete document.mutatesSourceProtocolState;
    expect(parse(document).success).toBe(false);
  });

  test("coverage arithmetic is vacuous where there is no artifact to cover", () => {
    // The authoring class has no state artifact yet — that is what extraction produces.
    expect(parse(archiveDependent()).success).toBe(true);
  });
});
