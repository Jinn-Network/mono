/**
 * The claim package (BP-13 deliverable 2, spec §8.2): a pure builder + a zod schema + a writer
 * for the standalone, portable document a skeptic reads to check a benchmark result without
 * re-running anything.
 *
 * `buildClaimPackage` is PURE — no filesystem, no digest recomputation, no re-derivation of the
 * sealed Report's own judgment. Every headline-or-comparison number, disclosure, limitation, and
 * attrition figure is EXTRACTED verbatim from the records the caller already sealed and verified
 * elsewhere (`../operations/report.ts`), never recomputed here — a claim package that silently
 * disagreed with its own cited report would be worse than one that failed to build. Nothing is
 * dropped: `conflicted`, `completeness`, and `attrition` are always present, even when they carry
 * unwelcome numbers (a conflicted cell, an incomplete run) — spec §8.2's whole point is that the
 * claim package cannot be more flattering than the sealed records it cites.
 *
 * P4b Task 5: `buildClaimPackage` DISPATCHES on the produced Report's `method.id` — wilson@1's
 * per-arm `headline` and paired-delta@1's `comparison` are mutually exclusive siblings, exactly
 * one of which is present on any given claim (the schema refuses a claim carrying neither). Same
 * "extracted, never recomputed" posture regardless of which method produced the Report.
 *
 * BP-20 (spec §7.2): the optional `rehearsal` block names any disclosed preview that preceded
 * this run's lock, verbatim from the caller's `previewDisclosure` input — used previews are named
 * in the official record; its absence means no preview preceded lock. Same "extracted, never
 * recomputed" posture as everything else this builder emits.
 *
 * BP-21 (spec §6): the required `assurance` block states the draft's preset (a product-policy
 * label) AND the platform primitives it resolved to, plus the fixed agent-distinctness
 * disclosure. The one deliberate exception to "never cross-check here": `buildClaimPackage`
 * THROWS when the stated primitives disagree with what the sealed Run record's own policy
 * carries — a claim stating primitives the sealed Run does not carry would be dishonest.
 */

import { z } from "zod";
import { Buffer } from "node:buffer";
import { validateBinaryInstrumentQualificationProjection } from "@jinn-network/benchmarking-aggregate";
import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION } from "@jinn-network/benchmarking-records";
import type { MatrixRecord, ReportRecord, RunRecord } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import {
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_CHECKS as READER_VERIFICATION_CHECKS,
  PUBLIC_BUNDLE_VERIFICATION_COMMAND as READER_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_CHECKS as READER_ANCHORED_VERIFICATION_CHECKS,
  PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
} from "../reader-instructions.js";
import { PROMPTED_SCREENING_PROFILE } from "../admission/contracts.js";
import { ClaimAnchorSchema, SELF_RUN_TRUST_ROOT, anchoredTrustRoot } from "./anchor-claims.js";
import type { ClaimAnchor } from "./anchor-claims.js";
type VenueHonesty = unknown;

export const CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/1";
export const BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/2";
/**
 * The anchored claim package (anchor-evidence design §7.4): claim-package/1 plus the `anchors`
 * section, carried by `benchmark-product-public-bundle/6`. The allocation is the next free number
 * in the classic path; the evidence-native claim-package/3 adopts the same anchor surface in its
 * own later allocation.
 */
export const ANCHORED_CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/4";
export const BINARY_QUALIFICATION_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.1.0 <bundle-dir>" as const;
export const BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.1 <bundle-dir>" as const;
/** Prompted-screening v2 claims require the verifier release that carries that admission surface. */
export const PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.2.1 <bundle-dir>" as const;
/** Previously materialized prompted bundles remain valid under their immutable 0.2.0 claim. */
export const LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.2.0 <bundle-dir>" as const;
export const PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.2 <bundle-dir>" as const;

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");

/** Mirrors `../run/preview-log.ts`'s own (unexported) `Rfc3339Schema` — restated here rather than
 * reached across the module boundary for one regex. */
const Rfc3339Schema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  "must be an RFC3339 timestamp",
);

const WilsonIntervalSchema = z.object({ low: z.string(), high: z.string() });
const HeadlineArmSchema = z.object({
  n: z.number().int().nonnegative(),
  passRate: z.string(),
  wilsonInterval: WilsonIntervalSchema,
});

const ConflictedSchema = z.object({
  count: z.number().int().nonnegative(),
  cellKeys: z.array(z.string()),
});

const PairedIntervalSchema = z.object({ alpha: z.string(), low: z.string(), high: z.string() });

/**
 * paired-delta@1's comparison block (P4b Task 5), sibling to `headline` (BP-13 method dispatch).
 * Carried verbatim from the method's own compute() output (`benchmarking/aggregate/src/
 * registry.ts`'s pairedDeltaMethod) — never recomputed, per this module's header. `baseline`,
 * `candidate`, and `verdictRule` are deliberately NOT repeated here: they already live in the
 * claim's `method.parameters` block, sealed verbatim by `run/compile.ts`'s buildAnalysisPlan.
 * `pairing`, `clustering`, and `bootstrap` carry richer nested shapes than a claim reader needs
 * pinned exactly, so — like this schema's own `results` field — they are typed loosely rather
 * than re-specified field-by-field.
 */
const ComparisonSchema = z.object({
  pairs: z.number().int().nonnegative(),
  delta: z.string().nullable(),
  interval: PairedIntervalSchema.nullable(),
  reasons: z.array(z.string()),
  pairing: z.object({ taskDigests: z.array(z.string()) }),
  clustering: z.object({ basis: z.string(), clusters: z.number().int().nonnegative() }),
  excluded: ConflictedSchema,
  conflicted: ConflictedSchema,
  bootstrap: z.unknown(),
});

/** `pairwise-disagreement@1` and `paired-majority-delta@1` (packet #2837, spec §7.1/§7.2a) both
 * report intervals keyed `{lower, upper, alpha}` -- NOT `PairedIntervalSchema`'s `{low, high,
 * alpha}`, which is `paired-delta@1`'s own key spelling. Reusing `PairedIntervalSchema` here would
 * silently drop `lower`/`upper` at parse time (zod strips unrecognized keys by default) rather than
 * refuse. Mirrors the identically-named schema in core's `report/claim.ts`. */
const JudgeIntervalSchema = z.object({ lower: z.string(), upper: z.string(), alpha: z.string() });

const ExclusionTripleSchema = z.object({
  taskDigest: z.string().min(1),
  armId: z.string().min(1),
  reason: z.string().min(1),
});

/**
 * `pairwise-disagreement@1`'s panel projection (spec §7.1), sibling to `comparison`/`headline`/
 * `qualification` (BP-13 method dispatch). Carried verbatim from the method's own compute() output
 * (`aggregate/src/pairwise-disagreement-method.ts`'s `computePairwiseDisagreement`) — never
 * recomputed, per this module's header. No `baseline`/`candidate`: the method computes all
 * unordered arm pairs in one pass and carries no chosen pair.
 */
const DisagreementCountSchema = z.object({
  n: z.number().int().nonnegative(),
  disagreements: z.number().int().nonnegative(),
  rate: z.string().nullable(),
  interval: JudgeIntervalSchema.nullable(),
});

const PairwiseDisagreementSchema = z.object({
  pairs: z.array(DisagreementCountSchema.extend({
    armA: z.string().min(1),
    armB: z.string().min(1),
    byCandidateClass: z.array(DisagreementCountSchema.extend({ candidateClass: z.string().min(1) })),
    byStratum: z.array(DisagreementCountSchema.extend({ stratum: z.string().min(1) })),
    exclusions: z.array(ExclusionTripleSchema),
  })),
  conflicted: ConflictedSchema,
});

/**
 * `paired-majority-delta@1`'s evidence-contrast projection (spec §7.2a), sibling to `comparison`/
 * `pairwiseDisagreement`. Carried verbatim from the method's own compute() output (`aggregate/src/
 * paired-majority-delta-method.ts`'s `computePairedMajorityDelta`) — never recomputed. `baseline`
 * is the evidence-declaring arm's evidence-free twin and `candidate` is the evidence-declaring arm
 * itself (coordinator ruling, packet #2837): a positive `delta` means declaring evidence increased
 * agreement.
 */
const DeltaProjectionSchema = z.object({
  n: z.number().int().nonnegative(),
  delta: z.string().nullable(),
  interval: JudgeIntervalSchema.nullable(),
  reasons: z.array(z.string()),
});

const PairedMajorityDeltaSchema = DeltaProjectionSchema.extend({
  baseline: z.string().min(1),
  candidate: z.string().min(1),
  // `manifest` is optional (M4): the projection omits the key entirely when the method emitted
  // none, rather than writing `manifest: undefined` into an object that is canonical-JSON encoded
  // on both sides of the mirror. Present-and-absent must both be expressible for the two copies to
  // agree byte-for-byte.
  clusters: z.object({ count: z.number().int().nonnegative(), manifest: z.unknown().optional() }),
  byCandidateClass: z.array(DeltaProjectionSchema.extend({ candidateClass: z.string().min(1) })),
  byStratum: z.array(DeltaProjectionSchema.extend({ stratum: z.string().min(1) })),
  exclusions: z.array(ExclusionTripleSchema),
  conflicted: ConflictedSchema,
});

const IntegrityTierCountsSchema = z.object({
  "re-derivable": z.number().int().nonnegative(),
  "attested-only": z.number().int().nonnegative(),
});

const PinningUnverifiableCountsSchema = z.object({
  harness: z.number().int().nonnegative(),
  model: z.number().int().nonnegative(),
  loadout: z.number().int().nonnegative(),
  isolation: z.number().int().nonnegative(),
});

/** The report's own disclosures block, carried whole, plus the two convenience summaries this
 * module adds (never a substitute for reading `perSubject` itself). */
const DisclosuresSchema = z.object({
  perSubject: z.array(z.unknown()),
  integrityTierCounts: IntegrityTierCountsSchema,
  pinningUnverifiableCounts: PinningUnverifiableCountsSchema,
});

/** The fixed sentence every claim package's assurance block carries (BP-21, spec §6/§7.1): what
 * distinct evaluator identities on this venue actually prove. Never softened per-claim. */
export const ASSURANCE_DISCLOSURE =
  "Distinct evaluator identities are workspace-minted keys; they prove agent-distinctness, "
  + "not party-independence, on this self-run venue.";

const ResolvedAssuranceSchema = z.object({
  independence: z.enum(["gating", "disclosed"]),
  minVerdicts: z.number().int().min(1),
  distinctEvaluator: z.boolean(),
  verdictRule: z.enum(["sole", "majority", "unanimous"]),
});

/** BP-21 (spec §6): the claim states the assurance preset AND the platform primitives it resolved
 * to, never the label alone — preset names are product policy, the primitives are what the sealed
 * Run actually carries (`buildClaimPackage` throws if the two disagree). */
const AssuranceBlockSchema = z.object({
  /** Product preset label (product policy) — never a substitute for `resolved`. */
  preset: z.string().min(1),
  resolved: ResolvedAssuranceSchema,
  /** The fixed agent-distinctness disclosure (`ASSURANCE_DISCLOSURE`). */
  disclosure: z.string().min(1),
});

const ClaimPackageWireSchema = z.object({
  claimSchema: z.union([
    z.literal(CLAIM_PACKAGE_SCHEMA_ID),
    z.literal(BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID),
    z.literal(ANCHORED_CLAIM_PACKAGE_SCHEMA_ID),
  ]),
  scope: z.object({
    draftId: z.string().min(1),
    benchmarkSha256: Sha256HexSchema,
    taskCount: z.number().int().nonnegative(),
    arms: z.array(z.object({ armId: z.string().min(1), pinning: z.record(z.string(), z.unknown()) })),
    replicates: z.number().int().positive(),
    venue: z.literal("self-run"),
  }),
  records: z.object({
    benchmarkSha256: Sha256HexSchema,
    runSha256: Sha256HexSchema,
    matrixSha256: Sha256HexSchema,
    reportSha256: Sha256HexSchema,
    reportEnvelopeSha256: Sha256HexSchema,
  }),
  method: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
    preregistered: z.boolean(),
  }),
  results: z.unknown(),
  /** wilson@1's per-arm headline. Optional and additive (P4b Task 5, mirrors the `rehearsal`
   * precedent below): a paired claim carries `comparison` instead — see the schema-level refine
   * at the bottom of this object, which refuses a claim carrying neither. */
  headline: z.record(z.string(), HeadlineArmSchema).optional(),
  completeness: z.unknown(),
  attrition: z.unknown(),
  conflicted: ConflictedSchema,
  assurance: AssuranceBlockSchema,
  disclosures: DisclosuresSchema,
  limitations: z.array(z.string()),
  venueHonesty: z.unknown(),
  verification: z.object({
    command: z.string().min(1),
    compatibleCommand: z.string().min(1),
    checks: z.array(z.string().min(1)).min(1),
    trustRoot: z.string().min(1),
  }),
  /** BP-20 (spec §7.2): present only when a preview preceded this run's lock — see module
   * header. Optional and additive; absent on every claim package built before this change. */
  rehearsal: z.object({
    previewCount: z.number().int().positive(),
    timestamps: z.array(Rfc3339Schema).min(1),
  }).optional(),
  /** P4b Task 5: present only for a paired-delta@1 Report, sibling to `headline`. See
   * `ComparisonSchema`'s own comment. */
  comparison: ComparisonSchema.optional(),
  /** packet #2837: present only for a pairwise-disagreement@1 Report, sibling to `comparison`. See
   * `PairwiseDisagreementSchema`'s own comment. */
  pairwiseDisagreement: PairwiseDisagreementSchema.optional(),
  /** packet #2837: present only for a paired-majority-delta@1 Report, sibling to `comparison`. See
   * `PairedMajorityDeltaSchema`'s own comment. */
  pairedMajorityDelta: PairedMajorityDeltaSchema.optional(),
  /** binary-instrument@1's complete per-subject F6 result. This is copied exactly; it is not a
   * headline, comparison, threshold, selection, or ranking projection. */
  qualification: z.unknown().optional(),
  /** anchor-evidence §7.4: one entry per AnchorEvidence record the bundle carries, in record-digest
   * order, each carrying only the facts embedded in the proof's own bytes. Present exactly on
   * claim-package/4 — the schema-level refine below refuses it on /1 and /2, so an unanchored claim
   * cannot grow an anchors section and an anchored one cannot be published without it. */
  anchors: z.array(ClaimAnchorSchema).optional(),
}).superRefine((claim, ctx) => {
  if (claim.claimSchema !== ANCHORED_CLAIM_PACKAGE_SCHEMA_ID && claim.anchors !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: `only ${ANCHORED_CLAIM_PACKAGE_SCHEMA_ID} carries an anchors section`,
      path: ["anchors"],
    });
  }
  if (claim.claimSchema === ANCHORED_CLAIM_PACKAGE_SCHEMA_ID) {
    if (claim.anchors === undefined) {
      // Present, not necessarily non-empty. An empty section is legal on exactly one bundle: one
      // whose sealed Run declared anchoring intent that no carried anchor satisfies (§7.3). That
      // bundle must still be on the anchored closure so the check that reports the absence runs,
      // and its claim must therefore still state the closure's seven checks. What no claim may do
      // is omit the section while claiming the closure, or carry one while claiming an earlier one.
      ctx.addIssue({
        code: "custom",
        message: `${ANCHORED_CLAIM_PACKAGE_SCHEMA_ID} must carry its anchors section, even when the section is empty`,
        path: ["anchors"],
      });
    }
    if (claim.qualification !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "the anchored binary-qualification closure is a later allocation, not claim-package/4",
        path: ["qualification"],
      });
    }
    if (
      claim.headline === undefined
      && claim.comparison === undefined
      && claim.pairwiseDisagreement === undefined
      && claim.pairedMajorityDelta === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "claim package must carry headline (wilson@1), comparison (paired-delta@1), "
          + "pairwiseDisagreement (pairwise-disagreement@1), or pairedMajorityDelta (paired-majority-delta@1)",
        path: ["headline"],
      });
    }
    if (
      claim.verification.command !== PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND
      || claim.verification.compatibleCommand !== PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND
    ) {
      ctx.addIssue({ code: "custom", message: "anchored claim package must pin verifier 0.1.0/@0.1", path: ["verification"] });
    }
    if (
      claim.verification.checks.length !== READER_ANCHORED_VERIFICATION_CHECKS.length
      || claim.verification.checks.some((check, index) => check !== READER_ANCHORED_VERIFICATION_CHECKS[index])
    ) {
      ctx.addIssue({
        code: "custom",
        message: "anchored claim package must retain the six frozen verification checks plus integrity-anchors, in order",
        path: ["verification", "checks"],
      });
    }
    return;
  }
  if (claim.claimSchema === CLAIM_PACKAGE_SCHEMA_ID) {
    if (
      claim.headline === undefined
      && claim.comparison === undefined
      && claim.pairwiseDisagreement === undefined
      && claim.pairedMajorityDelta === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "claim package must carry headline (wilson@1), comparison (paired-delta@1), "
          + "pairwiseDisagreement (pairwise-disagreement@1), or pairedMajorityDelta (paired-majority-delta@1)",
        path: ["headline"],
      });
    }
    return;
  }
  if (
    claim.method.id !== BENCHMARKING_METHOD_IDS.binaryInstrument
    || claim.method.version !== BENCHMARKING_METHOD_VERSION
    || claim.qualification === undefined
    || claim.headline !== undefined
    || claim.comparison !== undefined
    || claim.pairwiseDisagreement !== undefined
    || claim.pairedMajorityDelta !== undefined
  ) {
    ctx.addIssue({
      code: "custom",
      message: "binary claim package must carry only the exact binary-instrument qualification projection",
      path: ["qualification"],
    });
  }
  if (claim.qualification === undefined) return;
  const qualificationValidation = validateBinaryInstrumentQualificationProjection(claim.qualification);
  if (!qualificationValidation.ok) {
    ctx.addIssue({
      code: "custom",
      message: `binary qualification is outside the exact F6 schema: ${qualificationValidation.issues.join("; ")}`,
      path: ["qualification"],
    });
    return;
  }
  const reportResults = claim.results as { readonly perSubject?: readonly { readonly results?: unknown }[] } | undefined;
  const subject = reportResults?.perSubject;
  let exactResult = false;
  const exactWrapper = (
    typeof reportResults === "object"
    && reportResults !== null
    && Object.keys(reportResults).join("\0") === "perSubject"
    && subject?.length === 1
    && typeof subject[0] === "object"
    && subject[0] !== null
    && Object.keys(subject[0]).sort().join("\0") === "results\0subjectSha256"
    && (subject[0] as { readonly subjectSha256?: unknown }).subjectSha256 === claim.records.matrixSha256
  );
  if (exactWrapper) {
    try {
      exactResult = Buffer.from(canonicalJsonBytes(subject![0]!.results as never)).equals(
        Buffer.from(canonicalJsonBytes(claim.qualification as never)),
      );
    } catch {
      exactResult = false;
    }
  }
  if (!exactResult) {
    ctx.addIssue({ code: "custom", message: "qualification must exactly equal the Report's one F6 per-subject result", path: ["qualification"] });
  }
  const prompted = (claim.method.parameters as Record<string, unknown>)["promptedScreeningProfile"] === PROMPTED_SCREENING_PROFILE;
  const command = prompted
    ? PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND
    : BINARY_QUALIFICATION_VERIFICATION_COMMAND;
  const compatibleCommand = prompted
    ? PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND
    : BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND;
  const promptedCommandAccepted = prompted
    && (
      claim.verification.command === PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND
      || claim.verification.command === LEGACY_PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND
    );
  if (
    (prompted ? !promptedCommandAccepted : claim.verification.command !== command)
    || claim.verification.compatibleCommand !== compatibleCommand
  ) {
    ctx.addIssue({ code: "custom", message: `binary claim package must pin verifier ${prompted ? "0.2.1 (or historical 0.2.0)/@0.2" : "0.1.0/@0.1"}`, path: ["verification"] });
  }
  if (
    claim.verification.checks.length !== READER_VERIFICATION_CHECKS.length
    || claim.verification.checks.some((check, index) => check !== READER_VERIFICATION_CHECKS[index])
  ) {
    ctx.addIssue({ code: "custom", message: "binary claim package must retain the six frozen verification checks in order", path: ["verification", "checks"] });
  }
});

/** claim-package/1 predates `qualification`; its original non-strict object grammar accepted and
 * stripped that unknown key. Remove it before the additive v1/v2 wire schema sees the document so
 * v1 retains that exact behavior while claim-package/2 validates and preserves the field. */
function exactKeys(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function exactBinaryClaimControls(input: Record<string, unknown>): boolean {
  const scope = input.scope;
  const records = input.records;
  const method = input.method;
  const assurance = input.assurance;
  const disclosures = input.disclosures;
  const verification = input.verification;
  // `anchors`, `pairwiseDisagreement`, and `pairedMajorityDelta` are admitted here so a binary
  // claim that grew one of them reaches the schema-level refine and is refused BY NAME (all three
  // are checked there, alongside `headline`/`comparison`), rather than collapsing into the generic
  // control-shape failure. Neither judge field is ever set on an actual binary-instrument claim
  // (`methodProjection`'s dispatch is exclusive), so admitting them here is defense in depth, not
  // a widening any real claim exercises.
  return exactKeys(input, ["claimSchema", "scope", "records", "method", "results", "completeness", "attrition", "conflicted", "assurance", "disclosures", "limitations", "venueHonesty", "verification", "rehearsal", "qualification", "anchors", "pairwiseDisagreement", "pairedMajorityDelta"])
    && exactKeys(scope, ["draftId", "benchmarkSha256", "taskCount", "arms", "replicates", "venue"])
    && Array.isArray((scope as { arms?: unknown }).arms)
    && ((scope as { arms: unknown[] }).arms).every((arm) => exactKeys(arm, ["armId", "pinning"]))
    && exactKeys(records, ["benchmarkSha256", "runSha256", "matrixSha256", "reportSha256", "reportEnvelopeSha256"])
    && exactKeys(method, ["id", "version", "parameters", "preregistered"])
    && exactKeys(assurance, ["preset", "resolved", "disclosure"])
    && exactKeys((assurance as { resolved?: unknown })?.resolved, ["independence", "minVerdicts", "distinctEvaluator", "verdictRule"])
    && exactKeys(disclosures, ["perSubject", "integrityTierCounts", "pinningUnverifiableCounts"])
    && exactKeys((disclosures as { integrityTierCounts?: unknown })?.integrityTierCounts, ["re-derivable", "attested-only"])
    && exactKeys((disclosures as { pinningUnverifiableCounts?: unknown })?.pinningUnverifiableCounts, ["harness", "model", "loadout", "isolation"])
    && exactKeys(input.conflicted, ["count", "cellKeys"])
    && exactKeys(verification, ["command", "compatibleCommand", "checks", "trustRoot"])
    && (input.rehearsal === undefined || exactKeys(input.rehearsal, ["previewCount", "timestamps"]));
}

export const ClaimPackageSchema = z.preprocess((input) => {
  if (typeof input === "object" && input !== null && !Array.isArray(input)
    && (input as { readonly claimSchema?: unknown }).claimSchema === BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID
    && !exactBinaryClaimControls(input as Record<string, unknown>)) {
    return { claimSchema: "invalid-binary-claim-control-shape" };
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)
    && (input as { readonly claimSchema?: unknown }).claimSchema === CLAIM_PACKAGE_SCHEMA_ID) {
    const { qualification: _legacyUnknown, ...legacy } = input as Record<string, unknown>;
    return legacy;
  }
  return input;
}, ClaimPackageWireSchema);

export type ClaimPackage = z.infer<typeof ClaimPackageSchema>;

export interface BuildClaimPackageInput {
  readonly draftId: string;
  readonly benchmarkSha256: string;
  readonly runRecord: RunRecord;
  readonly runSha256: string;
  readonly matrixRecord: MatrixRecord;
  readonly matrixSha256: string;
  readonly reportRecord: ReportRecord;
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  readonly venueHonesty: VenueHonesty;
  /** Retained for structural parity; reader instructions come from the canonical projection. */
  readonly verificationCommandVerb: string;
  /** BP-21 (spec §6): the draft's assurance preset (a product-policy label) and the platform
   * primitives it resolved to. `buildClaimPackage` cross-checks the primitives against what the
   * sealed Run record itself carries and THROWS on any disagreement — a claim that states
   * primitives the sealed Run does not carry would be dishonest. */
  readonly assurance: {
    readonly preset: string;
    readonly resolved: {
      readonly independence: "gating" | "disclosed";
      readonly minVerdicts: number;
      readonly distinctEvaluator: boolean;
      readonly verdictRule: "sole" | "majority" | "unanimous";
    };
  };
  /** BP-20 (spec §7.2): when present, this draft had at least one disclosed preview before this
   * run's lock — `buildClaimPackage` carries it into the `rehearsal` block verbatim. Absent means
   * the caller found no preview log entry, i.e. no preview preceded lock. */
  readonly previewDisclosure?: { readonly previewCount: number; readonly timestamps: readonly string[] };
  /** anchor-evidence §7.4: the anchors section, already derived from the carried AnchorEvidence
   * bytes by `deriveClaimAnchors`. **Supplying it at all** — even empty — makes this an anchored
   * claim (claim-package/4); omitting it leaves every existing claim byte-identical. Never derived
   * here: this builder is pure, and the derivation needs the record bytes the caller already
   * authenticated. */
  readonly anchors?: readonly ClaimAnchor[];
}

type Comparison = z.infer<typeof ComparisonSchema>;
type PairwiseDisagreement = z.infer<typeof PairwiseDisagreementSchema>;
type PairedMajorityDelta = z.infer<typeof PairedMajorityDeltaSchema>;

/** What every method branch below must produce: EXACTLY ONE of `headline` (wilson@1),
 * `comparison` (paired-delta@1), `qualification` (binary-instrument@1),
 * `pairwiseDisagreement` (pairwise-disagreement@1), or `pairedMajorityDelta`
 * (paired-majority-delta@1) — plus the top-level `conflicted` block every claim carries
 * regardless of method. */
interface MethodProjection {
  readonly headline?: Record<string, unknown>;
  readonly comparison?: Comparison;
  readonly qualification?: unknown;
  readonly pairwiseDisagreement?: PairwiseDisagreement;
  readonly pairedMajorityDelta?: PairedMajorityDelta;
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

/** Every method this product wires publishes its single Matrix subject's results at this fixed
 * path — the wrapper itself is method-agnostic; only what's inside `results` differs by method. */
function singleSubjectResults(reportRecord: ReportRecord): unknown {
  const results = reportRecord.results as { readonly perSubject?: readonly { readonly results?: unknown }[] } | undefined;
  const perSubject = results?.perSubject;
  if (!Array.isArray(perSubject) || perSubject.length !== 1) {
    throw new Error("claim package: expected exactly one Report subject (this product's single-Matrix Report shape)");
  }
  return perSubject[0]?.results;
}

/** wilson@1's per-arm headline projection. A narrow, local shape check — deliberately not a
 * general Method-results parser; a mismatch here means the sealed Report was not produced by
 * wilson@1. */
function wilsonProjection(subjectResults: unknown): MethodProjection {
  const shape = subjectResults as
    | { readonly arms?: unknown; readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown } }
    | undefined;
  if (
    typeof shape?.arms !== "object" || shape.arms === null
    || typeof shape.conflicted?.count !== "number"
    || !Array.isArray(shape.conflicted.cellKeys)
  ) {
    throw new Error("claim package: Report results do not carry wilson@1's arms/conflicted shape");
  }
  return {
    headline: shape.arms as Record<string, unknown>,
    conflicted: { count: shape.conflicted.count, cellKeys: shape.conflicted.cellKeys as readonly string[] },
  };
}

/** paired-delta@1's comparison projection (P4b Task 5), sibling to `wilsonProjection`. Carried
 * verbatim from the method's own compute() output (`benchmarking/aggregate/src/registry.ts`'s
 * pairedDeltaMethod) — never recomputed. Same narrow, local-shape-check posture as
 * `wilsonProjection`: a mismatch here means the sealed Report was not produced by paired-delta@1. */
function comparisonProjection(subjectResults: unknown): MethodProjection {
  const shape = subjectResults as
    | {
        readonly pairs?: unknown;
        readonly delta?: unknown;
        readonly interval?: unknown;
        readonly reasons?: unknown;
        readonly pairing?: { readonly taskDigests?: unknown };
        readonly clustering?: { readonly basis?: unknown; readonly clusters?: unknown };
        readonly excluded?: { readonly count?: unknown; readonly cellKeys?: unknown };
        readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown };
        readonly bootstrap?: unknown;
      }
    | undefined;
  if (
    typeof shape?.pairs !== "number"
    || !(typeof shape.delta === "string" || shape.delta === null)
    || typeof shape.interval !== "object"
    || !Array.isArray(shape.reasons)
    || !Array.isArray(shape.pairing?.taskDigests)
    || typeof shape.clustering?.basis !== "string"
    || typeof shape.clustering.clusters !== "number"
    || typeof shape.excluded?.count !== "number"
    || !Array.isArray(shape.excluded.cellKeys)
    || typeof shape.conflicted?.count !== "number"
    || !Array.isArray(shape.conflicted.cellKeys)
    || shape.bootstrap === undefined
  ) {
    throw new Error("claim package: Report results do not carry paired-delta@1's comparison shape");
  }
  const conflicted = { count: shape.conflicted.count, cellKeys: shape.conflicted.cellKeys as readonly string[] };
  return {
    comparison: {
      pairs: shape.pairs,
      delta: shape.delta as string | null,
      interval: shape.interval as Comparison["interval"],
      reasons: [...(shape.reasons as readonly string[])],
      pairing: { taskDigests: [...(shape.pairing.taskDigests as readonly string[])] },
      clustering: { basis: shape.clustering.basis, clusters: shape.clustering.clusters },
      excluded: { count: shape.excluded.count, cellKeys: [...(shape.excluded.cellKeys as readonly string[])] },
      conflicted: { count: conflicted.count, cellKeys: [...conflicted.cellKeys] },
      bootstrap: shape.bootstrap,
    },
    conflicted,
  };
}

function binaryQualificationProjection(subjectResults: unknown): MethodProjection {
  const shape = subjectResults as { readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown } } | undefined;
  if (typeof shape?.conflicted?.count !== "number" || !Array.isArray(shape.conflicted.cellKeys)) {
    throw new Error("claim package: Report results do not carry binary-instrument@1's conflicted shape");
  }
  return {
    qualification: subjectResults,
    conflicted: { count: shape.conflicted.count, cellKeys: shape.conflicted.cellKeys as readonly string[] },
  };
}

/** `pairwise-disagreement@1`'s panel projection (packet #2837, spec §7.1), sibling to
 * `comparisonProjection`. Carried verbatim from the method's own compute() output
 * (`aggregate/src/pairwise-disagreement-method.ts`'s `computePairwiseDisagreement`) — never
 * recomputed. Same narrow, local-shape-check posture as `wilsonProjection`/`comparisonProjection`:
 * a mismatch here means the sealed Report was not produced by pairwise-disagreement@1. This
 * method's own output already carries `pairs` and top-level `conflicted` and nothing else, so the
 * whole object is carried through rather than field-by-field reassembled the way
 * `comparisonProjection` does for its richer sibling shape. Mirrors the identically-named function
 * in core's `report/claim.ts`. */
function pairwiseDisagreementProjection(subjectResults: unknown): MethodProjection {
  const shape = subjectResults as
    | { readonly pairs?: unknown; readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown } }
    | undefined;
  if (
    !Array.isArray(shape?.pairs)
    || typeof shape.conflicted?.count !== "number"
    || !Array.isArray(shape.conflicted.cellKeys)
  ) {
    throw new Error("claim package: Report results do not carry pairwise-disagreement@1's pairs/conflicted shape");
  }
  const conflicted = { count: shape.conflicted.count, cellKeys: shape.conflicted.cellKeys as readonly string[] };
  return {
    pairwiseDisagreement: {
      pairs: shape.pairs as PairwiseDisagreement["pairs"],
      conflicted: { count: conflicted.count, cellKeys: [...conflicted.cellKeys] },
    },
    conflicted,
  };
}

/** `paired-majority-delta@1`'s evidence-contrast projection (packet #2837, spec §7.2a), sibling to
 * `comparisonProjection`/`pairwiseDisagreementProjection`. Carried verbatim from the method's own
 * compute() output (`aggregate/src/paired-majority-delta-method.ts`'s
 * `computePairedMajorityDelta`) — never recomputed. Same narrow, local-shape-check posture as its
 * siblings. Mirrors the identically-named function in core's `report/claim.ts`. */
function pairedMajorityDeltaProjection(subjectResults: unknown): MethodProjection {
  const shape = subjectResults as
    | {
        readonly baseline?: unknown;
        readonly candidate?: unknown;
        readonly n?: unknown;
        readonly delta?: unknown;
        readonly interval?: unknown;
        readonly reasons?: unknown;
        readonly clusters?: { readonly count?: unknown; readonly manifest?: unknown };
        readonly byCandidateClass?: unknown;
        readonly byStratum?: unknown;
        readonly exclusions?: unknown;
        readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown };
      }
    | undefined;
  if (
    typeof shape?.baseline !== "string"
    || typeof shape.candidate !== "string"
    || typeof shape.n !== "number"
    || !(typeof shape.delta === "string" || shape.delta === null)
    || typeof shape.interval !== "object"
    || !Array.isArray(shape.reasons)
    || typeof shape.clusters?.count !== "number"
    || !Array.isArray(shape.byCandidateClass)
    || !Array.isArray(shape.byStratum)
    || !Array.isArray(shape.exclusions)
    || typeof shape.conflicted?.count !== "number"
    || !Array.isArray(shape.conflicted.cellKeys)
  ) {
    throw new Error("claim package: Report results do not carry paired-majority-delta@1's baseline/candidate/delta shape");
  }
  const conflicted = { count: shape.conflicted.count, cellKeys: shape.conflicted.cellKeys as readonly string[] };
  return {
    pairedMajorityDelta: {
      baseline: shape.baseline,
      candidate: shape.candidate,
      n: shape.n,
      delta: shape.delta as string | null,
      interval: shape.interval as PairedMajorityDelta["interval"],
      reasons: [...(shape.reasons as readonly string[])],
      // `manifest` is spread in only when present (M4): writing `manifest: undefined` puts an
      // explicit undefined-valued key into an object that is canonical-JSON encoded on both sides
      // of the mirror, and the two copies must agree byte-for-byte. An absent manifest stays
      // absent rather than becoming a key with no value.
      clusters: {
        count: shape.clusters.count,
        ...(shape.clusters.manifest === undefined ? {} : { manifest: shape.clusters.manifest }),
      },
      byCandidateClass: shape.byCandidateClass as PairedMajorityDelta["byCandidateClass"],
      byStratum: shape.byStratum as PairedMajorityDelta["byStratum"],
      exclusions: shape.exclusions as PairedMajorityDelta["exclusions"],
      conflicted: { count: conflicted.count, cellKeys: [...conflicted.cellKeys] },
    },
    conflicted,
  };
}

/** Dispatches on the produced Report's method (P4b Task 5) — the claim package's headline/
 * comparison projection is no longer a mandatory wilson@1 gate. Any method this product has not
 * wired a projection for throws rather than silently building an incomplete claim. */
function methodProjection(reportRecord: ReportRecord): MethodProjection {
  const subjectResults = singleSubjectResults(reportRecord);
  switch (reportRecord.method.id) {
    case BENCHMARKING_METHOD_IDS.wilson:
      return wilsonProjection(subjectResults);
    case BENCHMARKING_METHOD_IDS.pairedDelta:
      return comparisonProjection(subjectResults);
    case BENCHMARKING_METHOD_IDS.binaryInstrument:
      if (reportRecord.method.version !== BENCHMARKING_METHOD_VERSION) {
        throw new Error(`claim package: binary-instrument version "${reportRecord.method.version}" is not supported`);
      }
      return binaryQualificationProjection(subjectResults);
    case BENCHMARKING_METHOD_IDS.pairwiseDisagreement:
      if (reportRecord.method.version !== BENCHMARKING_METHOD_VERSION) {
        throw new Error(`claim package: pairwise-disagreement version "${reportRecord.method.version}" is not supported`);
      }
      return pairwiseDisagreementProjection(subjectResults);
    case BENCHMARKING_METHOD_IDS.pairedMajorityDelta:
      if (reportRecord.method.version !== BENCHMARKING_METHOD_VERSION) {
        throw new Error(`claim package: paired-majority-delta version "${reportRecord.method.version}" is not supported`);
      }
      return pairedMajorityDeltaProjection(subjectResults);
    default:
      throw new Error(`claim package: method "${reportRecord.method.id}" has no claim-package projection`);
  }
}

interface DisclosurePerSubjectShape {
  readonly integrityTiers: { readonly "re-derivable": number; readonly "attested-only": number };
  readonly pinning: Record<"harness" | "model" | "loadout" | "isolation", { readonly unverifiable: number }>;
}

function summedIntegrityTierCounts(perSubject: readonly DisclosurePerSubjectShape[]) {
  const counts = { "re-derivable": 0, "attested-only": 0 };
  for (const subject of perSubject) {
    counts["re-derivable"] += subject.integrityTiers["re-derivable"];
    counts["attested-only"] += subject.integrityTiers["attested-only"];
  }
  return counts;
}

const PINNING_AXES = ["harness", "model", "loadout", "isolation"] as const;

function summedPinningUnverifiableCounts(perSubject: readonly DisclosurePerSubjectShape[]) {
  const counts = { harness: 0, model: 0, loadout: 0, isolation: 0 };
  for (const subject of perSubject) {
    for (const axis of PINNING_AXES) counts[axis] += subject.pinning[axis].unverifiable;
  }
  return counts;
}

export const CLAIM_VERIFICATION_CHECKS: readonly string[] = READER_VERIFICATION_CHECKS;
/** The anchored closure's list: the six frozen checks plus `integrity-anchors` (§8). */
export const ANCHORED_CLAIM_VERIFICATION_CHECKS: readonly string[] = READER_ANCHORED_VERIFICATION_CHECKS;
export const PUBLIC_BUNDLE_VERIFICATION_COMMAND = READER_VERIFICATION_COMMAND;
/** The unconditional trust-root sentence, re-exported unchanged. It is DEFINED once beside its
 * anchored replacement in `anchor-claims.ts`: one sentence written out twice, in two mirrored
 * files, is exactly the drift the conditional copy cannot afford. */
export { SELF_RUN_TRUST_ROOT };

/** Builds the claim package document (spec §8.2) from explicit, already-sealed record data. Pure
 * — no filesystem access, no recomputation of anything the cited records already settled. */
export function buildClaimPackage(input: BuildClaimPackageInput): ClaimPackage {
  const { reportRecord } = input;

  // BP-21: the assurance block may only state primitives the sealed Run record itself carries.
  // `../run/compile.ts` seals the first three into `policy` at lock time and `verdictRule` into
  // the analysisPlan entry matching the produced Report's method (BP-13 F2, P4b Task 5) — all
  // four are checked against the sealed Run. The sealed plan may carry more than one entry (one
  // per candidate method), so the entry is SELECTED by method match, not read at a fixed index.
  const { resolved } = input.assurance;
  const policy = input.runRecord.policy;
  const matchingPlanEntry = input.runRecord.analysisPlan?.find(
    (entry) => entry.method === reportRecord.method.id && entry.version === reportRecord.method.version,
  );
  const analysisParameters = matchingPlanEntry?.parameters as
    | { readonly verdictRule?: unknown; readonly promptedScreeningProfile?: unknown }
    | undefined;
  if (
    policy.independence !== resolved.independence
    || policy.evaluation.minVerdicts !== resolved.minVerdicts
    || policy.evaluation.distinctEvaluator !== resolved.distinctEvaluator
    || analysisParameters?.verdictRule !== resolved.verdictRule
  ) {
    throw new Error(
      "claim package: the stated assurance primitives do not match what the sealed Run record carries"
      + " — a claim stating primitives the sealed Run does not carry would be dishonest",
    );
  }

  const projection = methodProjection(reportRecord);
  // Prompted screening is an authenticated Run-level admission fact. Every report/claim emitted
  // from that Run uses the v2 reader, including its companion method claims; the binary claim's
  // own schema separately binds the same exact profile in its method parameters.
  const promptedScreening = input.runRecord.analysisPlan?.some(
    (entry) => (entry.parameters as Record<string, unknown>)["promptedScreeningProfile"] === PROMPTED_SCREENING_PROFILE,
  ) === true;
  const disclosuresPerSubject = (reportRecord.disclosures?.perSubject ?? []) as readonly DisclosurePerSubjectShape[];
  const taskCount = new Set(input.matrixRecord.cells.map((cell) => cell.taskDigest)).size;
  // anchor-evidence §7.4: the anchored closure is entered by the CALLER, by supplying the section
  // at all -- a run that carries an anchor, or one whose sealed Run declared intent whose absence
  // the bundle must still report (§7.3). A caller that supplies nothing produces exactly the bytes
  // this builder produced before the feature existed.
  const anchors = input.anchors ?? [];
  const anchored = input.anchors !== undefined;
  if (anchored && projection.qualification !== undefined) {
    throw new Error(
      "claim package: the anchored binary-qualification closure is a later allocation"
      + " — claim-package/4 has no qualification projection",
    );
  }

  return {
    claimSchema: anchored
      ? ANCHORED_CLAIM_PACKAGE_SCHEMA_ID
      : projection.qualification === undefined
        ? CLAIM_PACKAGE_SCHEMA_ID
        : BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
    scope: {
      draftId: input.draftId,
      benchmarkSha256: input.benchmarkSha256,
      taskCount,
      arms: input.runRecord.arms.map((arm) => ({ armId: arm.armId, pinning: arm.pinning as Record<string, unknown> })),
      replicates: input.runRecord.replicates,
      venue: "self-run",
    },
    records: {
      benchmarkSha256: input.benchmarkSha256,
      runSha256: input.runSha256,
      matrixSha256: input.matrixSha256,
      reportSha256: input.reportSha256,
      reportEnvelopeSha256: input.reportEnvelopeSha256,
    },
    method: {
      id: reportRecord.method.id,
      version: reportRecord.method.version,
      parameters: reportRecord.method.parameters,
      preregistered: reportRecord.preregistered ?? false,
    },
    results: reportRecord.results,
    ...(projection.headline !== undefined ? { headline: projection.headline as ClaimPackage["headline"] } : {}),
    ...(projection.qualification !== undefined ? { qualification: projection.qualification } : {}),
    completeness: input.matrixRecord.completeness,
    attrition: input.matrixRecord.attrition,
    conflicted: { count: projection.conflicted.count, cellKeys: [...projection.conflicted.cellKeys] },
    assurance: {
      preset: input.assurance.preset,
      resolved: { ...resolved },
      disclosure: ASSURANCE_DISCLOSURE,
    },
    disclosures: {
      perSubject: (reportRecord.disclosures?.perSubject ?? []) as unknown[],
      integrityTierCounts: summedIntegrityTierCounts(disclosuresPerSubject),
      pinningUnverifiableCounts: summedPinningUnverifiableCounts(disclosuresPerSubject),
    },
    limitations: [...(reportRecord.limitations ?? [])],
    venueHonesty: input.venueHonesty,
    verification: {
      command: anchored
        ? PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND
        : promptedScreening
          ? PROMPTED_BINARY_QUALIFICATION_VERIFICATION_COMMAND
          : projection.qualification === undefined
            ? PUBLIC_BUNDLE_VERIFICATION_COMMAND
            : BINARY_QUALIFICATION_VERIFICATION_COMMAND,
      compatibleCommand: anchored
        ? PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND
        : promptedScreening
          ? PROMPTED_BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND
          : projection.qualification === undefined
            ? PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND
            : BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
      checks: anchored ? [...ANCHORED_CLAIM_VERIFICATION_CHECKS] : [...CLAIM_VERIFICATION_CHECKS],
      // §9.2: the trust-root sentence is replaced only by a governing lock anchor. A bundle whose
      // only anchors are pending, or cover the Matrix alone, keeps the unconditional sentence.
      trustRoot: anchoredTrustRoot(anchors),
    },
    ...(anchored ? { anchors: anchors.map((anchor) => ({ ...anchor })) } : {}),
    ...(input.previewDisclosure !== undefined
      ? {
          rehearsal: {
            previewCount: input.previewDisclosure.previewCount,
            timestamps: [...input.previewDisclosure.timestamps],
          },
        }
      : {}),
    ...(projection.comparison !== undefined ? { comparison: projection.comparison } : {}),
    ...(projection.pairwiseDisagreement !== undefined ? { pairwiseDisagreement: projection.pairwiseDisagreement } : {}),
    ...(projection.pairedMajorityDelta !== undefined ? { pairedMajorityDelta: projection.pairedMajorityDelta } : {}),
  };
}
