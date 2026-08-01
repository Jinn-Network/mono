import { z } from "zod";

import { Bytes32, Count, DigestPinnedDescriptorSchema, NonEmpty, PrefixedSha256 } from "./primitives.js";

/** Axis A — materialization closure (§4.2). */
export const CLOSURE_CLASSES = Object.freeze(["closed-state", "archive-dependent"] as const);

/** Axis B — source-chain fidelity (§4.2). The two axes are independent, never one ladder. */
export const FIDELITY_CLASSES = Object.freeze(["local", "anchored-subset", "full-state"] as const);

export const CONSTRUCTION_METHODS = Object.freeze([
  "archive-extraction",
  "local-construction",
  "full-state-export",
] as const);

/**
 * The only closure class eligible for durable verified supply (§4.2). Named as a constant so
 * consumers filter on it rather than on a string literal they may spell differently — and so
 * that eligibility is one grep away from the rule that grants it.
 */
export const DURABLE_SUPPLY_CLOSURE_CLASS = "closed-state" as const;

/**
 * An entry census over the three categories E13 partitions: accounts, storage slots, and
 * deployed code entries. The same shape counts what the artifact holds, what the source proofs
 * cover, and what the fixtures declare, so the coverage rule is one subtraction rather than
 * three incomparable descriptions.
 */
export const StateEntryCountsSchema = z.strictObject({
  accounts: Count,
  storageSlots: Count,
  codeEntries: Count,
});

export type StateEntryCounts = z.infer<typeof StateEntryCountsSchema>;

const ENTRY_CATEGORIES = ["accounts", "storageSlots", "codeEntries"] as const;

export const StateArtifactSchema = z.strictObject({
  descriptor: DigestPinnedDescriptorSchema,
  format: z.strictObject({ id: NonEmpty, version: NonEmpty }),
  /** The census E13 coverage is computed against. */
  entryCounts: StateEntryCountsSchema,
});

export const SourceProofManifestSchema = z.strictObject({
  proofFormat: z.literal("eip-1186"),
  proofs: DigestPinnedDescriptorSchema,
  /** Entries the proofs bind to the *declared* anchor state root (E5 bounds what that means). */
  coverage: StateEntryCountsSchema,
});

export const FixtureCoverageSchema = z.strictObject({
  manifest: DigestPinnedDescriptorSchema,
  /** Entries the record declares as fixture mutations rather than as source state. */
  declared: StateEntryCountsSchema,
  /**
   * How many proof-covered accounts the fixtures mutate. Declared mutations of real protocol
   * state are legal — that is how scenarios are built — but E13 requires them to be *visible*
   * without reading every fixture module, and this count plus `mutatesSourceProtocolState` is
   * that visibility.
   */
  mutatedProofCoveredAccounts: Count,
});

/**
 * How the declared world comes into existence (§4.3), and the two independent classifications
 * that say how much it claims (§4.2).
 *
 * `initialStateCommitment` is the post-fixture, agent-visible world's commitment. It is
 * explicitly not `sourceAnchor.stateRoot`: a consumer comparing post-fixture state to the
 * source root and calling the difference an error would be wrong by specification. The record
 * level enforces that they differ (see `chain-record.ts`).
 */
export const ChainStateMaterializationSchema = z
  .strictObject({
    closureClass: z.enum(CLOSURE_CLASSES),
    fidelityClass: z.enum(FIDELITY_CLASSES),
    constructionMethod: z.enum(CONSTRUCTION_METHODS),
    materializer: z.strictObject({
      id: NonEmpty,
      version: NonEmpty,
      digest: PrefixedSha256,
    }),
    stateArtifact: StateArtifactSchema.optional(),
    sourceProofManifest: SourceProofManifestSchema.optional(),
    fixtureCoverage: FixtureCoverageSchema.optional(),
    archive: z
      .strictObject({
        requiredCapabilities: z.array(NonEmpty).min(1),
        /** Locators only. A provider is never identity and never part of the world. */
        providerLocators: z.array(NonEmpty).optional(),
      })
      .optional(),
    mutatesSourceProtocolState: z.boolean().optional(),
    initialStateCommitment: Bytes32,
  })
  .superRefine((state, ctx) => {
    const closed = state.closureClass === "closed-state";

    if (closed && state.stateArtifact === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["stateArtifact"],
        message:
          "stateArtifact is mandatory for closed-state: every byte needed to instantiate the "
          + "world is a digest-pinned artifact (§4.2)",
      });
    }
    if (closed && state.archive !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["archive"],
        message:
          "a closed-state world declares no archive requirement; upstream network access is "
          + "forbidden at run time (§4.2)",
      });
    }
    if (!closed && state.archive === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["archive"],
        message: "archive-dependent materialization must declare archive.requiredCapabilities (§4.3)",
      });
    }

    if (state.fidelityClass === "local") {
      if (state.sourceProofManifest !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["sourceProofManifest"],
          message: "a local world claims no correspondence to a public chain and proves nothing against a source root (§4.2)",
        });
      }
      if (state.mutatesSourceProtocolState !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["mutatesSourceProtocolState"],
          message: "mutatesSourceProtocolState has no meaning for a local world: there is no source protocol state (§4.2)",
        });
      }
      return;
    }

    if (state.mutatesSourceProtocolState === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["mutatesSourceProtocolState"],
        message:
          "an anchored-subset or full-state record MUST state whether its fixtures mutate "
          + "proof-covered protocol state (E13)",
      });
    }

    if (
      state.fixtureCoverage !== undefined
      && state.fixtureCoverage.mutatedProofCoveredAccounts > 0
      && state.mutatesSourceProtocolState !== true
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["mutatesSourceProtocolState"],
        message:
          "mutatesSourceProtocolState MUST be true when fixtureCoverage.mutatedProofCoveredAccounts "
          + "is above zero: diligence must not require reading every fixture module (E13)",
      });
    }

    // E13, record-level half: an artifact's entries are proof-covered or fixture-declared, and
    // nothing is counted twice. Vacuous with no artifact — the authoring class has none yet.
    const artifact = state.stateArtifact;
    if (artifact === undefined) return;

    if (state.sourceProofManifest === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceProofManifest"],
        message:
          "source-coverage-incomplete: an anchored-subset or full-state artifact needs a source "
          + "proof manifest, or its entries are neither proof-covered nor fixture-declared (E13)",
      });
      return;
    }
    if (state.fixtureCoverage === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fixtureCoverage"],
        message:
          "source-coverage-incomplete: declare fixtureCoverage (with zero counts if the fixtures "
          + "add no entries) so every artifact entry is accounted for (E13)",
      });
      return;
    }

    for (const category of ENTRY_CATEGORIES) {
      const covered = state.sourceProofManifest.coverage[category]
        + state.fixtureCoverage.declared[category];
      if (covered !== artifact.entryCounts[category]) {
        ctx.addIssue({
          code: "custom",
          path: ["stateArtifact", "entryCounts", category],
          message:
            `source-coverage-incomplete: the artifact declares ${artifact.entryCounts[category]} `
            + `${category} but proofs cover ${state.sourceProofManifest.coverage[category]} and `
            + `fixtures declare ${state.fixtureCoverage.declared[category]}; every entry must be `
            + "exactly one of the two (E13)",
        });
      }
    }
  });

export type ChainStateMaterialization = z.infer<typeof ChainStateMaterializationSchema>;
