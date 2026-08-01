// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "@jinn-network/trust-core";

import type { ChainVerificationFailureReason } from "./outcomes.js";

/**
 * What the record's source-proof manifest asserts, as data. Proof *verification* is step 4's
 * own check; this type carries its per-entry result so coverage and validity stay separable
 * (an entry with an invalid proof covers nothing, which is why `verified` is read here too).
 * CE4 produces this shape; nothing re-declares it.
 */
export interface SourceProofManifest {
  readonly anchorStateRoot: string;
  readonly accounts: readonly { readonly address: string; readonly verified: boolean }[];
  readonly codeEntries: readonly {
    readonly address: string;
    readonly codeHash: string;
    readonly verified: boolean;
  }[];
  readonly storageSlots: readonly {
    readonly address: string;
    readonly slot: string;
    readonly verified: boolean;
  }[];
}

export interface FixtureMutationDeclaration {
  readonly address: string;
  readonly kind: "account" | "code" | "storage";
  readonly slot?: string;
}

/** CE1's `ArtifactEntryObservation`, restated as this module's input. Member names match
 * `stateArtifact.entryCounts` exactly -- two vocabularies for one partition is how an
 * off-by-one mapping gets written and never noticed (CE1 correction 2). */
export interface ArtifactEntryIndexInput {
  readonly accounts: readonly string[];
  readonly codeEntries: readonly string[];
  readonly storageSlots: readonly { readonly address: string; readonly slot: string }[];
}

export interface CoverageAssessmentInput {
  readonly fidelityClass: "local" | "anchored-subset" | "full-state";
  readonly entries: ArtifactEntryIndexInput;
  readonly manifest?: SourceProofManifest;
  readonly fixtureMutations: readonly FixtureMutationDeclaration[];
  /** §4.2: a record that mutates any proof-covered protocol account MUST set this, so
   * diligence does not require reading every fixture module. */
  readonly mutatesSourceProtocolState: boolean;
}

export interface CoverageAssessment {
  readonly applicable: boolean;
  readonly complete: boolean;
  readonly proofCovered: number;
  readonly fixtureDeclared: number;
  readonly uncovered: number;
  readonly uncoveredAccounts: readonly string[];
  readonly uncoveredCodeEntries: readonly string[];
  readonly uncoveredStorageSlots: readonly { readonly address: string; readonly slot: string }[];
  readonly undeclaredMutations: readonly string[];
  readonly reason?: ChainVerificationFailureReason;
}

const sortStrings = (values: readonly string[]): readonly string[] =>
  [...values].sort(compareCodeUnitStrings);

const storageKey = (address: string, slot: string): string => `${address}#${slot}`;

/**
 * E13. Every artifact entry must be proof-covered or fixture-declared; anything else is
 * `source-coverage-incomplete`. Declared mutations of real protocol state stay legal -- that
 * is how scenarios are built -- but they must be visible, which is what the
 * `mutatesSourceProtocolState` flag is for.
 */
export function assessArtifactCoverage(
  input: CoverageAssessmentInput,
): CoverageAssessment {
  const empty = {
    uncoveredAccounts: [] as readonly string[],
    uncoveredCodeEntries: [] as readonly string[],
    uncoveredStorageSlots: [] as readonly { readonly address: string; readonly slot: string }[],
    undeclaredMutations: [] as readonly string[],
  };

  if (input.fidelityClass === "local") {
    // A local world claims no correspondence to any public chain, so there is no manifest to
    // be covered against and nothing to prove about the rest of the artifact.
    return {
      applicable: false,
      complete: true,
      proofCovered: 0,
      fixtureDeclared: input.fixtureMutations.length,
      uncovered: 0,
      ...empty,
    };
  }

  const provenAccounts = new Set(
    (input.manifest?.accounts ?? []).filter((one) => one.verified).map((one) => one.address),
  );
  const provenCode = new Set(
    (input.manifest?.codeEntries ?? []).filter((one) => one.verified).map((one) => one.address),
  );
  const provenStorage = new Set(
    (input.manifest?.storageSlots ?? [])
      .filter((one) => one.verified)
      .map((one) => storageKey(one.address, one.slot)),
  );

  const fixtureAccounts = new Set(
    input.fixtureMutations
      .filter((one) => one.kind === "account")
      .map((one) => one.address),
  );
  const fixtureCode = new Set(
    input.fixtureMutations.filter((one) => one.kind === "code").map((one) => one.address),
  );
  const fixtureStorage = new Set(
    input.fixtureMutations
      .filter((one) => one.kind === "storage" && one.slot !== undefined)
      .map((one) => storageKey(one.address, one.slot as string)),
  );

  const uncoveredAccounts = sortStrings(input.entries.accounts.filter(
    (address) => !provenAccounts.has(address) && !fixtureAccounts.has(address),
  ));
  const uncoveredCodeEntries = sortStrings(input.entries.codeEntries.filter(
    (address) => !provenCode.has(address) && !fixtureCode.has(address),
  ));
  const uncoveredStorageSlots = [...input.entries.storageSlots]
    .filter((entry) => {
      const key = storageKey(entry.address, entry.slot);
      return !provenStorage.has(key) && !fixtureStorage.has(key);
    })
    .sort((left, right) => compareCodeUnitStrings(
      storageKey(left.address, left.slot),
      storageKey(right.address, right.slot),
    ));

  // A fixture that writes over proof-covered protocol state is legal and must be visible.
  const undeclaredMutations = input.mutatesSourceProtocolState
    ? []
    : sortStrings([...new Set(input.fixtureMutations
      .filter((mutation) => {
        if (mutation.kind === "account") return provenAccounts.has(mutation.address);
        if (mutation.kind === "code") return provenCode.has(mutation.address);
        return mutation.slot !== undefined
          && provenStorage.has(storageKey(mutation.address, mutation.slot));
      })
      .map((mutation) => mutation.address))]);

  const uncovered = uncoveredAccounts.length + uncoveredCodeEntries.length
    + uncoveredStorageSlots.length;
  const proofCovered = provenAccounts.size + provenCode.size + provenStorage.size;
  const fixtureDeclared = fixtureAccounts.size + fixtureCode.size + fixtureStorage.size;

  const reason: ChainVerificationFailureReason | undefined = uncovered > 0
    ? "artifact-entry-uncovered"
    : undeclaredMutations.length > 0
      ? "undeclared-source-mutation"
      : undefined;

  return {
    applicable: true,
    complete: reason === undefined,
    proofCovered,
    fixtureDeclared,
    uncovered,
    uncoveredAccounts,
    uncoveredCodeEntries,
    uncoveredStorageSlots,
    undeclaredMutations,
    ...(reason === undefined ? {} : { reason }),
  };
}
