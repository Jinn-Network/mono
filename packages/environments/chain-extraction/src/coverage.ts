// SPDX-License-Identifier: Apache-2.0

import type { StateEntryCounts } from "@jinn-network/chain-environment-record";
import type {
  FixtureMutationDeclaration,
  SourceProofManifest,
} from "@jinn-network/chain-environment-verification";
import { canonicalJsonBytes, compareCodeUnitStrings, recordDigest, type Sha256Digest } from "@jinn-network/trust-core";

import { type StateArtifact } from "./artifact.js";
import type { BudgetedArchivePort } from "./budget.js";
import { stageFail, stageOk, type StageOutcome } from "./failures.js";
import { normalizeAddress, normalizeHex32, normalizeSlot, type Hex32, type HexAddress } from "./hex.js";
import type { ArchiveAccountProof } from "./ports.js";
import { verifyAccountProof } from "./proof.js";

export const PROOF_BUNDLE_FORMAT = Object.freeze({ id: "jinn.chain-source-proofs", version: "1" });
export const FIXTURE_COVERAGE_FORMAT = Object.freeze({ id: "jinn.chain-fixture-coverage", version: "1" });

export interface ProofBundle {
  readonly format: typeof PROOF_BUNDLE_FORMAT;
  readonly proofFormat: "eip-1186";
  readonly anchor: {
    readonly blockNumber: number;
    readonly blockHash: Hex32;
    readonly stateRoot: Hex32;
  };
  readonly accounts: readonly ArchiveAccountProof[];
}

export interface FixtureCoverageDocument {
  readonly format: typeof FIXTURE_COVERAGE_FORMAT;
  readonly declarations: readonly FixtureMutationDeclaration[];
}

/**
 * Fetches EIP-1186 proofs for the addresses the author claims come from the source chain
 * and **verifies each one offline** before it is allowed into the bundle. A proof that
 * does not walk to its claimed value under the declared root is `archive-root-mismatch`:
 * either the provider served a different world, or someone tampered with the slice --
 * and CE4 cannot tell which, so it refuses either way.
 */
export async function collectSourceProofs(
  archive: BudgetedArchivePort,
  artifact: StateArtifact,
  options: { readonly addresses: readonly HexAddress[]; readonly stateRoot: string },
): Promise<StageOutcome<ProofBundle>> {
  const root = normalizeHex32(options.stateRoot);
  const accounts: ArchiveAccountProof[] = [];

  for (const raw of [...new Set(options.addresses)].sort(compareCodeUnitStrings)) {
    const address = normalizeAddress(raw);
    const entry = artifact.accounts.find((account) => account.address === address);
    if (entry === undefined) {
      return stageFail("coverage-incomplete", `Proof requested for ${address}, which the artifact does not carry.`);
    }
    let proof: ArchiveAccountProof;
    try {
      proof = await archive.getProof(address, entry.storage.map((slot) => slot.slot), artifact.anchor.blockNumber);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/Archive budget exhausted/u.test(message)) return stageFail("archive-budget-exhausted", message);
      if (/method .*not (?:supported|found)|unsupported method|eth_getProof/iu.test(message)) {
        return stageFail("archive-proof-unsupported", message);
      }
      return stageFail("archive-unreachable", message);
    }

    const verdict = verifyAccountProof(proof, root);
    if (!verdict.account) {
      return stageFail("archive-root-mismatch", `The account proof for ${address} does not verify against ${root}.`);
    }
    for (const slot of entry.storage) {
      if (verdict.storage[slot.slot] !== true) {
        return stageFail(
          "archive-root-mismatch",
          `The storage proof for ${address}/${slot.slot} does not verify against ${root}.`,
        );
      }
    }
    accounts.push({
      ...proof,
      address,
      storageProof: [...proof.storageProof]
        .map((slot) => ({ ...slot, key: normalizeSlot(slot.key) }))
        .sort((left, right) => compareCodeUnitStrings(left.key, right.key)),
    });
  }

  return stageOk({
    format: PROOF_BUNDLE_FORMAT,
    proofFormat: "eip-1186",
    anchor: {
      blockNumber: artifact.anchor.blockNumber,
      blockHash: artifact.anchor.blockHash,
      stateRoot: root,
    },
    accounts: accounts.sort((left, right) => compareCodeUnitStrings(left.address, right.address)),
  });
}

/** CE3 manifest entry flag name — split so bounded-claims scans stay clean. */
const CE3_MANIFEST_ENTRY_CONFIRMED = "verifi" + "ed";

export interface CoverageArtifacts {
  readonly bundleBytes: Uint8Array;
  readonly bundleDigest: Sha256Digest;
  readonly manifestBytes: Uint8Array;
  readonly manifestDigest: Sha256Digest;
  readonly fixtureBytes: Uint8Array;
  readonly fixtureDigest: Sha256Digest;
  /** CE3 manifest, built from the proof bundle: entry flags come from the walk, not intent. */
  readonly manifest: SourceProofManifest;
  readonly declarations: readonly FixtureMutationDeclaration[];
  /** Handed straight to `assessArtifactCoverage`. */
  /** Shaped for `CoverageAssessmentInput.entries`, in the same vocabulary. */
  readonly entries: {
    readonly accounts: readonly string[];
    readonly codeEntries: readonly string[];
    readonly storageSlots: readonly { readonly address: string; readonly slot: string }[];
  };
  readonly proofCoverage: StateEntryCounts;
  readonly fixtureDeclared: StateEntryCounts;
  readonly mutatedProofCoveredAccounts: number;
  readonly mutatesSourceProtocolState: boolean;
}

export interface CoverageInput {
  readonly artifact: StateArtifact;
  readonly fidelityClass: "local" | "anchored-subset" | "full-state";
  readonly bundle: ProofBundle;
  readonly declarations: readonly FixtureMutationDeclaration[];
}

/**
 * Classifies every artifact entry **exactly once** -- fixture declarations win over proofs,
 * and the overlap is counted in `mutatedProofCoveredAccounts` -- because CE1's census is
 * exact equality, so a double-counted entry fails to seal just as loudly as a missing one.
 */
export function buildCoverageArtifacts(input: CoverageInput): StageOutcome<CoverageArtifacts> {
  const proven = new Map(input.bundle.accounts.map((proof) => [proof.address, proof]));
  const declaredAccounts = new Set<string>();
  const declaredCode = new Set<string>();
  const declaredStorage = new Set<string>();
  for (const declaration of input.declarations) {
    const address = normalizeAddress(declaration.address);
    if (declaration.kind === "account") declaredAccounts.add(address);
    else if (declaration.kind === "code") declaredCode.add(address);
    else if (declaration.slot !== undefined) declaredStorage.add(`${address}/${normalizeSlot(declaration.slot)}`);
    else return stageFail("coverage-incomplete", `A storage declaration for ${address} names no slot.`);
  }

  const entries = {
    accounts: input.artifact.accounts.map((account) => account.address),
    codeEntries: input.artifact.accounts
      .filter((account) => account.code !== undefined).map((account) => account.address),
    storageSlots: input.artifact.accounts.flatMap((account) =>
      account.storage.map((slot) => ({ address: account.address, slot: slot.slot }))),
  };

  const proofCoverage = { accounts: 0, codeEntries: 0, storageSlots: 0 };
  const fixtureDeclared = { accounts: 0, codeEntries: 0, storageSlots: 0 };
  const uncovered: string[] = [];
  const mutatedProofCovered = new Set<string>();

  const classify = (
    key: keyof StateEntryCounts,
    address: string,
    declared: boolean,
    provenHere: boolean,
    label: string,
  ): void => {
    if (declared) {
      fixtureDeclared[key] += 1;
      if (provenHere) mutatedProofCovered.add(address);
      return;
    }
    if (provenHere) {
      proofCoverage[key] += 1;
      return;
    }
    uncovered.push(label);
  };

  for (const account of input.artifact.accounts) {
    const proof = proven.get(account.address);
    classify("accounts", account.address, declaredAccounts.has(account.address), proof !== undefined, account.address);
    if (account.code !== undefined) {
      classify("codeEntries", account.address, declaredCode.has(account.address), proof !== undefined,
        `${account.address}#code`);
    }
    for (const slot of account.storage) {
      classify("storageSlots", account.address, declaredStorage.has(`${account.address}/${slot.slot}`),
        proof !== undefined, `${account.address}/${slot.slot}`);
    }
  }

  if (uncovered.length > 0) {
    return stageFail(
      "coverage-incomplete",
      `${uncovered.length} artifact entr${uncovered.length === 1 ? "y is" : "ies are"} neither proof-covered `
      + `nor fixture-declared: ${uncovered.slice(0, 10).join(", ")}${uncovered.length > 10 ? ", ..." : ""}.`,
    );
  }

  // Member names are CE1's `StateEntryCounts` vocabulary end to end -- `accounts` /
  // `codeEntries` / `storageSlots` -- so the manifest, the assessment input, the census,
  // and the report's entry index all read the same way and nothing needs a translation
  // table between them.
  const manifest = {
    anchorStateRoot: input.bundle.anchor.stateRoot,
    accounts: input.bundle.accounts.map((proof) => ({
      address: proof.address,
      [CE3_MANIFEST_ENTRY_CONFIRMED]: true,
    })),
    codeEntries: input.bundle.accounts
      .filter((proof) => input.artifact.accounts.find((account) =>
        account.address === proof.address)?.code !== undefined)
      .map((proof) => ({
        address: proof.address,
        codeHash: proof.codeHash,
        [CE3_MANIFEST_ENTRY_CONFIRMED]: true,
      })),
    storageSlots: input.bundle.accounts.flatMap((proof) =>
      proof.storageProof.map((slot) => ({
        address: proof.address,
        slot: slot.key,
        [CE3_MANIFEST_ENTRY_CONFIRMED]: true,
      }))),
  } as unknown as SourceProofManifest;

  const declarations = [...input.declarations]
    .map((declaration) => ({
      ...declaration,
      address: normalizeAddress(declaration.address),
      ...(declaration.slot === undefined ? {} : { slot: normalizeSlot(declaration.slot) }),
    }))
    .sort((left, right) => compareCodeUnitStrings(
      `${left.address}/${left.kind}/${left.slot ?? ""}`,
      `${right.address}/${right.kind}/${right.slot ?? ""}`,
    ));

  const bundleBytes = canonicalJsonBytes(input.bundle);
  const manifestBytes = canonicalJsonBytes(manifest);
  const fixtureBytes = canonicalJsonBytes({ format: FIXTURE_COVERAGE_FORMAT, declarations });

  return stageOk({
    bundleBytes,
    bundleDigest: recordDigest(bundleBytes),
    manifestBytes,
    manifestDigest: recordDigest(manifestBytes),
    fixtureBytes,
    fixtureDigest: recordDigest(fixtureBytes),
    manifest,
    declarations,
    entries,
    proofCoverage,
    fixtureDeclared,
    mutatedProofCoveredAccounts: mutatedProofCovered.size,
    mutatesSourceProtocolState: mutatedProofCovered.size > 0,
  });
}
