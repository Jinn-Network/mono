// SPDX-License-Identifier: Apache-2.0

import { assessArtifactCoverage } from "@jinn-network/chain-environment-verification";
import { describe, expect, it } from "vitest";

import { stateArtifactEntryCounts } from "./artifact.js";
import {
  buildCoverageArtifacts,
  collectSourceProofs,
  PROOF_BUNDLE_FORMAT,
  type ProofBundle,
} from "./coverage.js";
import { createBudgetedArchivePort } from "./budget.js";
import { buildFakeTrieWorld, fakeStateArtifact, FAKE_ACTOR, FAKE_POOL, FAKE_SLOT_1 } from "./testing.js";

describe("the coverage stage", () => {
  it("counts every artifact entry exactly once, so CE1's census balances", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const artifact = fakeStateArtifact();
    const proofs = await collectSourceProofs(archive, artifact, { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    if (!proofs.ok) throw new Error(proofs.detail);
    const built = buildCoverageArtifacts({
      artifact,
      fidelityClass: "anchored-subset",
      bundle: proofs.value,
      declarations: [{ address: FAKE_ACTOR, kind: "account" }],
    });
    if (!built.ok) throw new Error(built.detail);

    const counts = stateArtifactEntryCounts(artifact);
    for (const key of ["accounts", "storageSlots", "codeEntries"] as const) {
      expect(built.value.proofCoverage[key] + built.value.fixtureDeclared[key]).toBe(counts[key]);
    }
  });

  it("agrees with CE3's assessor, which is the only party that decides incompleteness", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const artifact = fakeStateArtifact();
    const proofs = await collectSourceProofs(archive, artifact, { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    if (!proofs.ok) throw new Error(proofs.detail);
    const built = buildCoverageArtifacts({
      artifact,
      fidelityClass: "anchored-subset",
      bundle: proofs.value,
      declarations: [{ address: FAKE_ACTOR, kind: "account" }],
    });
    if (!built.ok) throw new Error(built.detail);
    const assessment = assessArtifactCoverage({
      fidelityClass: "anchored-subset",
      entries: built.value.entries,
      manifest: built.value.manifest,
      fixtureMutations: built.value.declarations,
      mutatesSourceProtocolState: built.value.mutatesSourceProtocolState,
    });
    expect(assessment.complete).toBe(true);
    expect(assessment.uncovered).toBe(0);
  });

  it("fails coverage-incomplete when an entry is neither proven nor declared", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const artifact = fakeStateArtifact();
    const proofs = await collectSourceProofs(archive, artifact, { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    if (!proofs.ok) throw new Error(proofs.detail);
    const built = buildCoverageArtifacts({
      artifact, fidelityClass: "anchored-subset", bundle: proofs.value, declarations: [],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe("coverage-incomplete");
    expect(built.detail).toContain(FAKE_ACTOR);
  });

  it("marks a tampered entry unverified, and therefore uncovered", async () => {
    const world = buildFakeTrieWorld({ tamperSlot: { address: FAKE_POOL, slot: FAKE_SLOT_1 } });
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const proofs = await collectSourceProofs(archive, fakeStateArtifact(), { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    expect(proofs.ok).toBe(false);
    if (proofs.ok) return;
    expect(proofs.reason).toBe("archive-root-mismatch");
  });

  it("raises mutatesSourceProtocolState when a fixture writes a proven account", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const artifact = fakeStateArtifact();
    const proofs = await collectSourceProofs(archive, artifact, { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    if (!proofs.ok) throw new Error(proofs.detail);
    const built = buildCoverageArtifacts({
      artifact,
      fidelityClass: "anchored-subset",
      bundle: proofs.value,
      declarations: [
        { address: FAKE_ACTOR, kind: "account" },
        { address: FAKE_POOL, kind: "storage", slot: FAKE_SLOT_1 },
      ],
    });
    if (!built.ok) throw new Error(built.detail);
    expect(built.value.mutatesSourceProtocolState).toBe(true);
    expect(built.value.mutatedProofCoveredAccounts).toBe(1);
  });

  it("requires every local entry to be fixture-declared against an empty bundle", () => {
    const artifact = fakeStateArtifact();
    const emptyBundle: ProofBundle = {
      format: PROOF_BUNDLE_FORMAT,
      proofFormat: "eip-1186",
      anchor: {
        blockNumber: artifact.anchor.blockNumber,
        blockHash: artifact.anchor.blockHash,
        stateRoot: artifact.anchor.stateRoot,
      },
      accounts: [],
    };
    const declarations = [
      ...artifact.accounts.map((account) => ({ address: account.address, kind: "account" as const })),
      ...artifact.accounts
        .filter((account) => account.code !== undefined)
        .map((account) => ({ address: account.address, kind: "code" as const })),
      ...artifact.accounts.flatMap((account) =>
        account.storage.map((slot) => ({
          address: account.address,
          kind: "storage" as const,
          slot: slot.slot,
        }))),
    ];
    const built = buildCoverageArtifacts({
      artifact,
      fidelityClass: "local",
      bundle: emptyBundle,
      declarations,
    });
    if (!built.ok) throw new Error(built.detail);
    expect(built.value.mutatesSourceProtocolState).toBe(false);
    expect(built.value.proofCoverage).toEqual({ accounts: 0, codeEntries: 0, storageSlots: 0 });
    expect(built.value.fixtureDeclared).toEqual(stateArtifactEntryCounts(artifact));
  });
});
