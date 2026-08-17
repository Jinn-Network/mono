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
} from "@colophon-claims/verify";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { claimPackageArtifactPath } from "../workspace/layout.js";
import type { VenueHonesty } from "../operations/run-results.js";

export const CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/1";
export const BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/2";
export const BINARY_QUALIFICATION_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@2.0.0 <bundle-dir>" as const;
export const BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@2 <bundle-dir>" as const;

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
  /** binary-instrument@1's complete per-subject F6 result. This is copied exactly; it is not a
   * headline, comparison, threshold, selection, or ranking projection. */
  qualification: z.unknown().optional(),
  /** Optional Colophon suite-protocol bits. Not Report v2 required fields. */
  suiteComparability: z.object({
    executionConformance: z.boolean(),
    coverage: z.enum(["one_task", "ten_task", "full", "custom"]),
    leaderboardSubmitReady: z.boolean(),
  }).strict().optional(),
}).superRefine((claim, ctx) => {
  if (claim.claimSchema === CLAIM_PACKAGE_SCHEMA_ID) {
    if (claim.headline === undefined && claim.comparison === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "claim package must carry either headline (wilson@1) or comparison (paired-delta@1)",
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
  if (
    claim.verification.command !== BINARY_QUALIFICATION_VERIFICATION_COMMAND
    || claim.verification.compatibleCommand !== BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND
  ) {
    ctx.addIssue({ code: "custom", message: "binary claim package must pin verifier 2.0.0/@2", path: ["verification"] });
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
  return exactKeys(input, ["claimSchema", "scope", "records", "method", "results", "completeness", "attrition", "conflicted", "assurance", "disclosures", "limitations", "venueHonesty", "verification", "rehearsal", "qualification"])
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
  /** Retained for source compatibility; reader instructions come from the verifier package. */
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
  /** Optional two-axis official-suite comparability. Absent unless a suite protocol is bound. */
  readonly suiteComparability?: {
    readonly executionConformance: boolean;
    readonly coverage: "one_task" | "ten_task" | "full" | "custom";
    readonly leaderboardSubmitReady: boolean;
  };
}

type Comparison = z.infer<typeof ComparisonSchema>;

/** What every method branch below must produce: EITHER `headline` (wilson@1) OR `comparison`
 * (paired-delta@1), plus the top-level `conflicted` block every claim carries regardless of
 * method. */
interface MethodProjection {
  readonly headline?: Record<string, unknown>;
  readonly comparison?: Comparison;
  readonly qualification?: unknown;
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
export const PUBLIC_BUNDLE_VERIFICATION_COMMAND = READER_VERIFICATION_COMMAND;
export const SELF_RUN_TRUST_ROOT =
  "Signatures verify against the bundle-carried public keys minted by this workspace; there is no third-party trust anchor on the self-run venue.";

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
    | { readonly verdictRule?: unknown }
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
  const disclosuresPerSubject = (reportRecord.disclosures?.perSubject ?? []) as readonly DisclosurePerSubjectShape[];
  const taskCount = new Set(input.matrixRecord.cells.map((cell) => cell.taskDigest)).size;

  return {
    claimSchema: projection.qualification === undefined
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
      command: projection.qualification === undefined
        ? PUBLIC_BUNDLE_VERIFICATION_COMMAND
        : BINARY_QUALIFICATION_VERIFICATION_COMMAND,
      compatibleCommand: projection.qualification === undefined
        ? PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND
        : BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
      checks: [...CLAIM_VERIFICATION_CHECKS],
      trustRoot: SELF_RUN_TRUST_ROOT,
    },
    ...(input.previewDisclosure !== undefined
      ? {
          rehearsal: {
            previewCount: input.previewDisclosure.previewCount,
            timestamps: [...input.previewDisclosure.timestamps],
          },
        }
      : {}),
    ...(projection.comparison !== undefined ? { comparison: projection.comparison } : {}),
    ...(input.suiteComparability === undefined ? {} : { suiteComparability: input.suiteComparability }),
  };
}

/** Validates and atomically writes the claim package to `claimPackageArtifactPath`. */
export function writeClaimPackage(workspaceDir: string, draftId: string, claim: ClaimPackage): void {
  const validated = ClaimPackageSchema.parse(claim);
  atomicWriteFileSync(claimPackageArtifactPath(workspaceDir, draftId), canonicalJsonBytes(validated));
}
