/** Sealed Inspect eval selection: one operator-chosen Inspect eval, locked as specified. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { sha256Hex } from "../../workspace/sealed-store.js";
import { InspectSelectionTemplateSchema } from "../inspect/manifest.js";
import { SUITE_COVERAGE, type SuiteCoverage } from "../suite-protocol/comparability.js";
import { InspectEvalSuiteProtocolSelectionSchema } from "../suite-protocol/manifest.js";

export const INSPECT_EVAL_SELECTION_SCHEMA =
  "jinn.network/benchmark-product/inspect-eval-selection/1" as const;
export const INSPECT_EVAL_SELECTION_ROLE =
  "https://product.jinn.network/artifact-roles/inspect-eval/selection/v1" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const SampleIdSchema = z.union([z.string().min(1), z.number().int()]);

export const InspectCatalogSnapshotSchema = z.object({
  sampleIds: z.array(SampleIdSchema).min(1),
  snapshotSha256: Sha256,
  specifiedEpochs: z.number().int().positive(),
  epochsReducer: z.string().min(1).nullable().optional(),
  taskVersion: z.string().min(1).nullable().optional(),
  datasetName: z.string().nullable(),
  datasetLocation: z.string().nullable(),
  datasetSampleCount: z.number().int().nonnegative(),
}).strict();

export const InspectEvalSelectionManifestSchema = z.object({
  schema: z.literal(INSPECT_EVAL_SELECTION_SCHEMA),
  inspect: InspectSelectionTemplateSchema,
  catalog: InspectCatalogSnapshotSchema,
  coverage: z.enum(SUITE_COVERAGE),
  selectedSamples: z.array(z.object({ sampleId: SampleIdSchema }).strict()).min(1),
  solver: z.string().min(1),
  sampleLimit: z.number().int().positive().nullable(),
  suite: InspectEvalSuiteProtocolSelectionSchema,
}).strict().superRefine((value, context) => {
  if (value.selectedSamples.length !== value.suite.selectedTaskNames.length) {
    context.addIssue({
      code: "custom",
      message: "selected samples must match suite selectedTaskNames",
      path: ["selectedSamples"],
    });
  }
  const names = value.selectedSamples.map((sample) => String(sample.sampleId));
  if (names.join("\0") !== value.suite.selectedTaskNames.join("\0")) {
    context.addIssue({
      code: "custom",
      message: "selected sample ids must equal suite selectedTaskNames in order",
      path: ["selectedSamples"],
    });
  }
  if (value.suite.replicates !== value.catalog.specifiedEpochs) {
    context.addIssue({
      code: "custom",
      message: "suite replicates must equal specified epochs",
      path: ["suite", "replicates"],
    });
  }
  if (value.coverage !== value.suite.coverage) {
    context.addIssue({
      code: "custom",
      message: "coverage must match the nested suite object",
      path: ["coverage"],
    });
  }
});

export type InspectEvalSelectionManifest = z.infer<typeof InspectEvalSelectionManifestSchema>;
export type InspectCatalogSnapshot = z.infer<typeof InspectCatalogSnapshotSchema>;
export type { SuiteCoverage };

export function inspectEvalSelectionBytes(value: InspectEvalSelectionManifest): Uint8Array {
  return canonicalJsonBytes(InspectEvalSelectionManifestSchema.parse(value) as never);
}

export function inspectEvalSelectionSha256(value: InspectEvalSelectionManifest): string {
  return sha256Hex(inspectEvalSelectionBytes(value));
}

export function sampleIdKey(sampleId: string | number): string {
  return String(sampleId);
}
