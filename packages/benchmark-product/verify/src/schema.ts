import { z } from "zod";
import { compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
import { TASK_EXECUTION_ERROR_CATEGORIES } from "@jinn-network/task-execution-protocol";

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Rfc3339Schema = z.string().datetime({ offset: true });

export const BUNDLE_TRUST_FORMAT = "benchmark-product-public-trust/2" as const;
export const BUNDLE_EVIDENCE_FORMAT = "benchmark-product-evidence-catalog/2" as const;
export const BUNDLE_VERDICTS_FORMAT = "benchmark-product-verdict-catalog/2" as const;
export const BUNDLE_ASSEMBLY_FORMAT = "benchmark-product-assembly/2" as const;
export const BUNDLE_V4_TRUST_FORMAT = "benchmark-product-public-trust/4" as const;
export const BUNDLE_V4_EVIDENCE_FORMAT = "benchmark-product-evidence-catalog/4" as const;
export const BUNDLE_QUALIFICATION_FORMAT = "benchmark-product-binary-qualification/1" as const;

export const BUNDLE_V4_EVIDENCE_ROLES = [
  "task",
  "runtime-selection",
  "evaluation-spec",
  "admission-receipt",
  "solve-submission",
  "run-pinning-evidence",
  "evaluation-submission",
  "solve-delivery",
  "solve-output",
  "evaluation-task",
  "evaluation-delivery",
  "verdict",
  "item-bank",
  "source-manifest",
  "admission-index",
  "admission-manifest",
  "replacement-ledger",
  "source-item",
  "judge-instrument",
  "analysis-context",
  "label-resolution",
  "human-review-evaluation-spec",
  "human-review-form",
  "human-review-packet",
  "human-review-response",
  "human-review-verdict",
  "reviewer-roster",
  "review-visibility-receipt",
  "review-reveal-receipt",
  "operator-assertion",
  // Appended at the very end (spec §1.6 site 9 / §1.5 rule 5): this array's index order is the
  // frozen role-ordering map used by both the catalog schema's ordering refinement and the bundle
  // writer, so inserting anywhere else would move existing bundles' bytes.
  "snapshot-probe",
  // Appended after snapshot-probe (spec §6.8a Group C, first bullet; packet P6): the
  // screened-operator-sampled admission branch's two new sealed records.
  "screening-table",
  "screening-reveal-receipt",
] as const;
export type BundleV4EvidenceRole = (typeof BUNDLE_V4_EVIDENCE_ROLES)[number];
export const BUNDLE_V4_ADMISSION_EVIDENCE_ROLES = [
  "admission-manifest", "replacement-ledger", "source-item", "label-resolution",
  "analysis-context", "human-review-evaluation-spec", "human-review-form",
  "human-review-packet", "human-review-response", "human-review-verdict",
  "reviewer-roster", "review-visibility-receipt", "review-reveal-receipt",
  "operator-assertion",
  // Appended after operator-assertion (spec §6.8a Group C, first bullet; packet P6), matching the
  // full list above. This subset's relative order intentionally differs from the full list
  // elsewhere (no judge-instrument, analysis-context/label-resolution swapped) — that is frozen
  // and is not to be normalized.
  "screening-table",
  "screening-reveal-receipt",
] as const;

const PublicKeySchema = z.object({
  keyId: z.string().min(1),
  algorithm: z.literal("ed25519"),
  spkiDerBase64: z.string().min(1),
});

export const BundleTrustSchema = z.object({
  format: z.literal(BUNDLE_TRUST_FORMAT),
  selfRun: z.object({
    custody: z.literal("workspace-minted"),
    evaluatorDistinctness: z.literal("agent-distinctness-only"),
    partyIndependence: z.literal("not-established"),
  }),
  report: PublicKeySchema.extend({
    author: z.string().min(1),
    didKey: z.string().min(1),
    validFrom: Rfc3339Schema,
  }),
  evaluators: z.array(PublicKeySchema.extend({ evaluator: z.string().min(1) })),
});
export type BundleTrust = z.infer<typeof BundleTrustSchema>;

const BundleV4PublicKeySchema = z.strictObject({
  keyId: z.string().min(1),
  algorithm: z.literal("ed25519"),
  spkiDerBase64: z.string().min(1),
});

export const BundleV4TrustSchema = z.strictObject({
  format: z.literal(BUNDLE_V4_TRUST_FORMAT),
  selfRun: z.strictObject({
    custody: z.literal("workspace-minted"),
    evaluatorDistinctness: z.literal("agent-distinctness-only"),
    partyIndependence: z.literal("not-established"),
  }),
  report: BundleV4PublicKeySchema.extend({
    author: z.string().min(1),
    didKey: z.string().min(1),
    validFrom: Rfc3339Schema,
  }),
  evaluators: z.array(BundleV4PublicKeySchema.extend({ evaluator: z.string().min(1) })),
  admission: z.strictObject({
    reviewers: z.array(z.strictObject({
      evaluator: z.string().min(1),
      keyId: z.string().min(1),
    })),
    authorities: z.array(z.strictObject({
      role: z.enum(["roster-attestor", "truth-reveal-attestor", "operator-truth-attestor"]),
      keyId: z.string().min(1),
    })),
  }),
}).superRefine((trust, ctx) => {
  for (let index = 1; index < trust.evaluators.length; index += 1) {
    if (compareCodeUnitStrings(trust.evaluators[index - 1]!.evaluator, trust.evaluators[index]!.evaluator) >= 0) {
      ctx.addIssue({ code: "custom", path: ["evaluators", index], message: "v4 evaluators must be code-unit sorted and unique" });
    }
  }
  if (new Set(trust.evaluators.map((entry) => entry.keyId)).size !== trust.evaluators.length) {
    ctx.addIssue({ code: "custom", path: ["evaluators"], message: "v4 evaluator key IDs must be unique" });
  }
  const evaluatorKeys = new Map(trust.evaluators.map((entry) => [entry.evaluator, entry.keyId]));
  const reviewers = trust.admission.reviewers;
  if (reviewers.length === 1) ctx.addIssue({ code: "custom", path: ["admission", "reviewers"], message: "admission reviewers must be empty or a registry of at least two reviewers" });
  for (const [index, reviewer] of reviewers.entries()) {
    if (index > 0 && compareCodeUnitStrings(reviewers[index - 1]!.evaluator, reviewer.evaluator) >= 0) ctx.addIssue({ code: "custom", path: ["admission", "reviewers"], message: "reviewer bindings must be sorted and unique" });
    if (evaluatorKeys.get(reviewer.evaluator) !== reviewer.keyId) ctx.addIssue({ code: "custom", path: ["admission", "reviewers", index], message: "reviewer binding does not resolve to one exact carried public key" });
  }
  if (new Set(reviewers.map((entry) => entry.keyId)).size !== reviewers.length) ctx.addIssue({ code: "custom", path: ["admission", "reviewers"], message: "reviewer keys must be distinct" });
  const authorityRoles = trust.admission.authorities.map((entry) => entry.role);
  const humanRoles = ["roster-attestor", "truth-reveal-attestor"];
  const operatorRoles = ["operator-truth-attestor"];
  // Third legal authority set (spec §6.8a Group C, third bullet; packet P6): the screened
  // branch's ordering receipt (§6.6) presents `truth-reveal-attestor` alone -- neither of the two
  // existing sets. `AdmissionAuthorityRole` itself stays unchanged (§6.6 deliberately reuses the
  // role rather than minting one).
  const screenedRoles = ["truth-reveal-attestor"];
  if (
    JSON.stringify(authorityRoles) !== JSON.stringify(humanRoles)
    && JSON.stringify(authorityRoles) !== JSON.stringify(operatorRoles)
    && JSON.stringify(authorityRoles) !== JSON.stringify(screenedRoles)
  ) ctx.addIssue({ code: "custom", path: ["admission", "authorities"], message: "authority bindings must be exactly the human pair, the operator-only role, or the screened role alone" });
  if (trust.admission.authorities.some((entry) => entry.keyId !== trust.report.keyId)) ctx.addIssue({ code: "custom", path: ["admission", "authorities"], message: "admission authority must resolve to the carried report-authority public key" });
});
export type BundleV4Trust = z.infer<typeof BundleV4TrustSchema>;

export const BundleEvidenceCatalogSchema = z.object({
  format: z.literal(BUNDLE_EVIDENCE_FORMAT),
  records: z.array(z.object({
    sha256: Sha256HexSchema,
    roles: z.array(z.enum([
      "task",
      "runtime-selection",
      "evaluation-spec",
      "admission-receipt",
      "solve-submission",
      "run-pinning-evidence",
      "evaluation-submission",
      "solve-delivery",
      "solve-output",
      "evaluation-task",
      "evaluation-delivery",
      "verdict",
    ])).min(1),
  })),
});
export type BundleEvidenceCatalog = z.infer<typeof BundleEvidenceCatalogSchema>;

export const BundleV4EvidenceCatalogSchema = z.strictObject({
  format: z.literal(BUNDLE_V4_EVIDENCE_FORMAT),
  records: z.array(z.strictObject({
    sha256: Sha256HexSchema,
    roles: z.array(z.enum(BUNDLE_V4_EVIDENCE_ROLES)).min(1),
  })),
}).superRefine((catalog, ctx) => {
  for (let index = 0; index < catalog.records.length; index += 1) {
    const record = catalog.records[index]!;
    if (index > 0 && compareCodeUnitStrings(catalog.records[index - 1]!.sha256, record.sha256) >= 0) ctx.addIssue({ code: "custom", path: ["records", index], message: "records must be sorted and unique" });
    const order = new Map(BUNDLE_V4_EVIDENCE_ROLES.map((role, roleIndex) => [role, roleIndex] as const));
    for (let roleIndex = 1; roleIndex < record.roles.length; roleIndex += 1) {
      if (order.get(record.roles[roleIndex - 1]!)! >= order.get(record.roles[roleIndex]!)!) ctx.addIssue({ code: "custom", path: ["records", index, "roles"], message: "roles must be in frozen order and unique" });
    }
  }
});
export type BundleV4EvidenceCatalog = z.infer<typeof BundleV4EvidenceCatalogSchema>;

const PrefixedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
// §3.1 rule 1: the same identifier dialect used for stratum names elsewhere (e.g.
// `admission/contracts.ts`'s `BinaryJudgmentStratumSchema`). `candidateClasses` below deliberately
// stays ungrammared: tightening it is outside P4's contract and could refuse bundles written today.
const IDENTIFIER_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
export const BundleQualificationSchema = z.strictObject({
  format: z.literal(BUNDLE_QUALIFICATION_FORMAT),
  claimSchema: z.literal("benchmark-product.claim-package/2"),
  sourceManifestSha256: PrefixedSha256Schema,
  admissionManifestSha256: PrefixedSha256Schema,
  publicationGrade: z.boolean(),
  // Widened spec §6.8 (packet P6): a third admission mode, screened by a pinned model and
  // sampled/hand-checked by the operator. BUNDLE_QUALIFICATION_FORMAT does not move (§0.4): every
  // existing document still validates and seals byte-identically. The publicationGrade coupling
  // for this third branch, and the admission-record/authority-set closure that makes a screened
  // document constructible at all, are out of this packet's scope (spec §6.8a Group A/C).
  truthAdmission: z.enum(["two-human-unanimous", "operator-only", "screened-operator-sampled"]),
  candidateClasses: z.array(z.string().min(1)),
  // Sorted-unique, grammar-conforming, non-empty (spec §3.1 rule 6). BUNDLE_QUALIFICATION_FORMAT
  // stays at its current version under §0.4: every ["core","stress"] bundle ever written still
  // validates, byte-identically.
  strata: z.array(z.string().regex(IDENTIFIER_NAME)).min(1),
  // .min(2), not a literal count (spec §1.6 rule 3). BUNDLE_QUALIFICATION_FORMAT stays at its
  // current version under §0.4: every four-arm bundle ever written still validates,
  // byte-identically.
  arms: z.array(z.strictObject({
    armId: z.string().min(1),
    instrumentSha256: PrefixedSha256Schema,
  })).min(2),
  items: z.array(z.strictObject({
    taskSha256: PrefixedSha256Schema,
    itemSha256: PrefixedSha256Schema,
    labelResolutionSha256: PrefixedSha256Schema,
    analysisContextSha256: PrefixedSha256Schema,
  })),
  exclusions: z.array(z.strictObject({
    itemSha256: PrefixedSha256Schema,
    replacementItemSha256: PrefixedSha256Schema,
    // Widened spec §6.4 (packet P6), second copy of the replacement-ledger reason vocabulary
    // (the first is `admission/contracts.ts`'s `HumanReviewReplacementLedgerEntrySchema.reason`).
    // The existing three values are byte-unchanged; the three new values are derived from §6.4's
    // admission rule (screen disagreed, screen indeterminate, or the hand check excluded it).
    reason: z.enum([
      "review-disagreement", "review-indeterminate", "review-incomplete",
      "screening-disagreement", "screening-indeterminate", "screening-hand-excluded",
    ]),
  })),
  admissionRecords: z.array(z.strictObject({
    sha256: PrefixedSha256Schema,
    roles: z.array(z.enum(BUNDLE_V4_ADMISSION_EVIDENCE_ROLES)).min(1),
  })),
  reachableSha256s: z.array(PrefixedSha256Schema),
}).superRefine((qualification, ctx) => {
  const sortedUnique = (values: readonly string[], path: (string | number)[]) => {
    for (let index = 1; index < values.length; index += 1) {
      if (compareCodeUnitStrings(values[index - 1]!, values[index]!) >= 0) ctx.addIssue({ code: "custom", path, message: "values must be code-unit sorted and unique" });
    }
  };
  sortedUnique(qualification.candidateClasses, ["candidateClasses"]);
  sortedUnique(qualification.strata, ["strata"]);
  sortedUnique(qualification.arms.map((entry) => entry.armId), ["arms"]);
  sortedUnique(qualification.items.map((entry) => entry.taskSha256), ["items"]);
  for (const field of ["itemSha256", "labelResolutionSha256", "analysisContextSha256"] as const) {
    if (new Set(qualification.items.map((entry) => entry[field])).size !== qualification.items.length) ctx.addIssue({ code: "custom", path: ["items"], message: `${field} edges must be unique` });
  }
  sortedUnique(qualification.exclusions.map((entry) => entry.itemSha256), ["exclusions"]);
  sortedUnique(qualification.admissionRecords.map((entry) => entry.sha256), ["admissionRecords"]);
  const admissionRoleOrder = new Map(BUNDLE_V4_ADMISSION_EVIDENCE_ROLES.map((role, index) => [role, index] as const));
  for (const [recordIndex, record] of qualification.admissionRecords.entries()) {
    for (let roleIndex = 1; roleIndex < record.roles.length; roleIndex += 1) {
      if (admissionRoleOrder.get(record.roles[roleIndex - 1]!)! >= admissionRoleOrder.get(record.roles[roleIndex]!)!) ctx.addIssue({ code: "custom", path: ["admissionRecords", recordIndex, "roles"], message: "admission roles must be in frozen order and unique" });
    }
  }
  sortedUnique(qualification.reachableSha256s, ["reachableSha256s"]);
  // Counts against arms.length, not the literal 4 (spec §1.6 rule 3, site 9).
  if (new Set(qualification.arms.map((entry) => entry.instrumentSha256)).size !== qualification.arms.length) ctx.addIssue({ code: "custom", path: ["arms"], message: "arms must bind one distinct instrument each" });
  for (const [index, item] of qualification.items.entries()) {
    for (const digest of [item.itemSha256, item.labelResolutionSha256, item.analysisContextSha256]) {
      if (!qualification.reachableSha256s.includes(digest)) ctx.addIssue({ code: "custom", path: ["items", index], message: "item graph edge is absent from the authenticated admission closure" });
    }
  }
  for (const [index, exclusion] of qualification.exclusions.entries()) {
    if (!qualification.reachableSha256s.includes(exclusion.itemSha256) || !qualification.reachableSha256s.includes(exclusion.replacementItemSha256)) ctx.addIssue({ code: "custom", path: ["exclusions", index], message: "exclusion graph edge is absent from the authenticated admission closure" });
  }
  if (!qualification.reachableSha256s.includes(qualification.admissionManifestSha256)) ctx.addIssue({ code: "custom", path: ["admissionManifestSha256"], message: "admission manifest is absent from reachable closure" });
  const rolesByDigest = new Map(qualification.admissionRecords.map((entry) => [entry.sha256, new Set(entry.roles)] as const));
  const requireRole = (digest: string, role: (typeof BUNDLE_V4_ADMISSION_EVIDENCE_ROLES)[number], path: (string | number)[]) => {
    if (!rolesByDigest.get(digest)?.has(role)) ctx.addIssue({ code: "custom", path, message: `${digest} is not bound to semantic role ${role}` });
  };
  requireRole(qualification.admissionManifestSha256, "admission-manifest", ["admissionManifestSha256"]);
  for (const [index, item] of qualification.items.entries()) {
    requireRole(item.itemSha256, "source-item", ["items", index, "itemSha256"]);
    requireRole(item.labelResolutionSha256, "label-resolution", ["items", index, "labelResolutionSha256"]);
    requireRole(item.analysisContextSha256, "analysis-context", ["items", index, "analysisContextSha256"]);
  }
  for (const [index, exclusion] of qualification.exclusions.entries()) {
    requireRole(exclusion.itemSha256, "source-item", ["exclusions", index, "itemSha256"]);
    requireRole(exclusion.replacementItemSha256, "source-item", ["exclusions", index, "replacementItemSha256"]);
  }
  const roleCounts = new Map(BUNDLE_V4_ADMISSION_EVIDENCE_ROLES.map((role) => [
    role,
    qualification.admissionRecords.filter((entry) => entry.roles.includes(role)).length,
  ] as const));
  if (roleCounts.get("admission-manifest") !== 1 || roleCounts.get("replacement-ledger") !== 1
    || roleCounts.get("human-review-evaluation-spec") !== 1 || roleCounts.get("human-review-form") !== 1) {
    ctx.addIssue({ code: "custom", path: ["admissionRecords"], message: "admission closure must bind one manifest, ledger, frozen review spec, and frozen review form" });
  }
  const humanEvidenceRoles = [
    "human-review-packet", "human-review-response", "human-review-verdict", "reviewer-roster",
    "review-visibility-receipt", "review-reveal-receipt",
  ] as const;
  // The screened branch's two roles (spec §6.8a Group C, second bullet; packet P6).
  const screeningEvidenceRoles = ["screening-table", "screening-reveal-receipt"] as const;
  if (qualification.truthAdmission === "two-human-unanimous") {
    if (humanEvidenceRoles.some((role) => (roleCounts.get(role) ?? 0) === 0)
      || roleCounts.get("operator-assertion") !== 0) {
      ctx.addIssue({ code: "custom", path: ["admissionRecords"], message: "two-human admission must carry the frozen human-review closure and no operator assertion" });
    }
  } else if (qualification.truthAdmission === "operator-only") {
    if (humanEvidenceRoles.some((role) => (roleCounts.get(role) ?? 0) !== 0) || (roleCounts.get("operator-assertion") ?? 0) === 0) {
      ctx.addIssue({ code: "custom", path: ["admissionRecords"], message: "operator-only admission must carry operator assertions and no human-review evidence" });
    }
    // Spec §6.8a Group C, second bullet. Named explicitly rather than left as a bare `else`: this
    // was the family's last catch-all router, and Group B's doctrine is that a mode-dispatching
    // branch names the mode it handles, so a fourth admission mode lands in no arm instead of
    // silently inheriting the screened one's evidence rules.
  } else if (qualification.truthAdmission === "screened-operator-sampled") {
    if (
      screeningEvidenceRoles.some((role) => (roleCounts.get(role) ?? 0) === 0)
      || humanEvidenceRoles.some((role) => (roleCounts.get(role) ?? 0) !== 0)
      || (roleCounts.get("operator-assertion") ?? 0) !== 0
    ) {
      ctx.addIssue({ code: "custom", path: ["admissionRecords"], message: "screened admission must carry both screening records and no human-review evidence or operator assertion" });
    }
  }
  if (
    qualification.admissionRecords.length !== qualification.reachableSha256s.length
    || qualification.admissionRecords.some((entry, index) => entry.sha256 !== qualification.reachableSha256s[index])
  ) ctx.addIssue({ code: "custom", path: ["admissionRecords"], message: "semantic admission roles must exactly cover reachableSha256s" });
  if (qualification.truthAdmission === "two-human-unanimous" && !qualification.publicationGrade) ctx.addIssue({ code: "custom", path: ["publicationGrade"], message: "two-human unanimous truth is publication grade" });
  if (qualification.truthAdmission === "operator-only" && qualification.publicationGrade) ctx.addIssue({ code: "custom", path: ["publicationGrade"], message: "operator-only truth is not publication grade" });
  // §6.8: the screened branch is publication-grade -- without this branch, §6.8a Group A's fix to
  // the two publicationGrade derivations (verification.ts, human-review.ts) would have nothing to
  // enforce against.
  if (qualification.truthAdmission === "screened-operator-sampled" && !qualification.publicationGrade) ctx.addIssue({ code: "custom", path: ["publicationGrade"], message: "screened-operator-sampled truth is publication grade" });
});
export type BundleQualification = z.infer<typeof BundleQualificationSchema>;

export const BundleVerdictCatalogSchema = z.object({
  format: z.literal(BUNDLE_VERDICTS_FORMAT),
  verdicts: z.array(z.object({
    sha256: Sha256HexSchema,
    evaluator: z.string().min(1),
    keyId: z.string().min(1),
    cellKeys: z.array(z.string().min(1)).min(1),
  })),
});
export type BundleVerdictCatalog = z.infer<typeof BundleVerdictCatalogSchema>;

const AssemblyVerdictSchema = z.object({
  sha256: Sha256HexSchema,
  relationship: z.enum(["same-execution-scorer", "separate-log-verifier"]).optional(),
  evalTaskSha256: Sha256HexSchema.optional(),
  evalSubmissionSha256: Sha256HexSchema.optional(),
  evalDeliverySha256: Sha256HexSchema.optional(),
  evalAttempt: z.string().min(1).optional(),
  evalIndex: z.number().int().positive(),
  evaluator: z.string().min(1),
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  evaluationSpecSha256: Sha256HexSchema,
  measurements: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export const BundleAssemblyHeaderSchema = z.object({
  format: z.literal(BUNDLE_ASSEMBLY_FORMAT),
  kind: z.literal("run"),
  runCancelled: z.boolean(),
  draftId: z.string().min(1),
  assurancePreset: z.string().min(1),
  rehearsal: z.object({
    previewCount: z.number().int().positive(),
    timestamps: z.array(Rfc3339Schema).min(1),
  }).optional(),
  graph: z.object({
    admissions: z.array(z.object({ taskSha256: Sha256HexSchema, receiptSha256: Sha256HexSchema })),
    solveSubmissions: z.array(z.object({
      cellKey: z.string().min(1),
      dispatch: z.number().int().positive(),
      sha256: Sha256HexSchema,
      pinningEvidenceSha256: Sha256HexSchema.optional(),
    })),
    evaluationSubmissions: z.array(z.object({
      cellKey: z.string().min(1),
      dispatch: z.number().int().positive(),
      evalIndex: z.number().int().positive(),
      evaluationAttempt: z.number().int().positive().optional(),
      evaluator: z.string().min(1),
      evalTaskSha256: Sha256HexSchema,
      sha256: Sha256HexSchema,
    })),
    solveDeliveries: z.array(z.object({
      cellKey: z.string().min(1),
      dispatch: z.number().int().positive(),
      attempt: z.string().min(1),
      sha256: Sha256HexSchema,
      outputs: z.array(z.object({ name: z.string(), sha256: Sha256HexSchema })),
    })),
    evaluations: z.array(z.object({
      cellKey: z.string().min(1),
      evalIndex: z.number().int().positive(),
      evaluationAttempt: z.number().int().positive().optional(),
      relationship: z.enum(["same-execution-scorer", "separate-log-verifier"]).optional(),
      evaluator: z.string().optional(),
      evalTaskSha256: Sha256HexSchema.optional(),
      evalSubmissionSha256: Sha256HexSchema.optional(),
      evalAttempt: z.string().optional(),
      evalDeliverySha256: Sha256HexSchema.optional(),
      verdictSha256: Sha256HexSchema.optional(),
      evaluationTerminal: z.literal("could-not-grade").optional(),
      /** The operational category that terminalized this leg as could-not-grade. Present only
       * on a could-not-grade terminal whose journal entry recorded one, which today is the
       * infrastructure failure that exhausted the sealed retry budget. Without it the accounted
       * ungradeable cell reaches the bundle as an uncategorized absence: `evaluationRetries`
       * carries the category of every failure that WAS retried, and the terminal one is the
       * only failure in the leg that has no retry row to carry it. Additive and optional, so
       * every bundle that carried no such terminal seals to identical bytes. */
      failureCategory: z.enum(TASK_EXECUTION_ERROR_CATEGORIES).optional(),
    })),
    evaluationRetries: z.array(z.object({
      cellKey: z.string().min(1),
      dispatch: z.number().int().positive(),
      evalIndex: z.number().int().positive(),
      evaluationAttempt: z.number().int().positive(),
      evaluator: z.string().min(1),
      evalTaskSha256: Sha256HexSchema.optional(),
      evalSubmissionSha256: Sha256HexSchema.optional(),
      evalAttempt: z.string().min(1).optional(),
      failureCategory: z.enum(TASK_EXECUTION_ERROR_CATEGORIES),
      recoveryAdvice: z.literal("new-attempt-required"),
      detail: z.string().min(1),
    })).optional(),
  }),
});
export type BundleAssemblyHeader = z.infer<typeof BundleAssemblyHeaderSchema>;

export const BundleAssemblyCellSchema = z.object({
  kind: z.literal("cell"),
  cellKey: z.string().min(1),
  armId: z.string().min(1),
  replicate: z.number().int().positive(),
  taskDigest: Sha256HexSchema,
  dispatches: z.number().int().nonnegative(),
  accounted: z.number().int().positive().optional(),
  submissionSha256: Sha256HexSchema.optional(),
  pinningEvidenceSha256: Sha256HexSchema.optional(),
  attempt: z.string().min(1).optional(),
  deliverySha256: Sha256HexSchema.optional(),
  solveOutputs: z.array(z.object({ name: z.string(), sha256: Sha256HexSchema })).optional(),
  evaluationSpecSha256: Sha256HexSchema.optional(),
  evaluationTerminal: z.literal("could-not-grade").optional(),
  admission: z.object({
    zeroReplayVariance: z.boolean(),
    externalCapabilities: z.boolean(),
  }).optional(),
  admissionReceiptSha256: Sha256HexSchema.optional(),
  verdicts: z.array(AssemblyVerdictSchema),
});
export type BundleAssemblyCell = z.infer<typeof BundleAssemblyCellSchema>;

export const BundleCancelMarkerSchema = z.object({
  requestedAt: Rfc3339Schema,
  principal: z.string().min(1),
});
