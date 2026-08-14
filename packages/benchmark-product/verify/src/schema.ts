import { z } from "zod";

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Rfc3339Schema = z.string().datetime({ offset: true });

export const BUNDLE_TRUST_FORMAT = "benchmark-product-public-trust/2" as const;
export const BUNDLE_EVIDENCE_FORMAT = "benchmark-product-evidence-catalog/2" as const;
export const BUNDLE_VERDICTS_FORMAT = "benchmark-product-verdict-catalog/2" as const;
export const BUNDLE_ASSEMBLY_FORMAT = "benchmark-product-assembly/2" as const;

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
      relationship: z.enum(["same-execution-scorer", "separate-log-verifier"]).optional(),
      evaluator: z.string().optional(),
      evalTaskSha256: Sha256HexSchema.optional(),
      evalSubmissionSha256: Sha256HexSchema.optional(),
      evalAttempt: z.string().optional(),
      evalDeliverySha256: Sha256HexSchema.optional(),
      verdictSha256: Sha256HexSchema.optional(),
      evaluationTerminal: z.literal("could-not-grade").optional(),
    })),
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
