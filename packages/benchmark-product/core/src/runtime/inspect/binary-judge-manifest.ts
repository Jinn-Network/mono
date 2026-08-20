import { z } from "zod";
import {
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  InspectBinaryJudgeArmSchema,
  InspectBinaryJudgeSelectionManifestSchema,
  type InspectBinaryJudgeArm,
  type InspectBinaryJudgeSelectionManifest,
} from "@colophon-claims/verify";
import { BinaryJudgmentSnapshotProbeSchema } from "@jinn-network/task-execution-profiles";
import {
  SUPPORTED_OCI_PLATFORM,
} from "./manifest.js";

export {
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  InspectBinaryJudgeArmSchema,
  InspectBinaryJudgeSelectionManifestSchema,
};
export type { InspectBinaryJudgeArm, InspectBinaryJudgeSelectionManifest };

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

/** Private machine binding. Host paths never enter the sealed public manifest. */
export const InspectBinaryJudgeHostBindingSchema = z.strictObject({
  kind: z.literal("oci"),
  dockerPath: z.string().min(1),
  imageDigest: Sha256DigestSchema,
  platform: z.literal(SUPPORTED_OCI_PLATFORM),
  user: z.string().regex(/^[0-9]+:[0-9]+$/u),
});
export type InspectBinaryJudgeHostBinding = z.infer<typeof InspectBinaryJudgeHostBindingSchema>;

export const InspectBinaryJudgeBindingRequestSchema = z.strictObject({
  schema: z.literal("jinn.network/benchmark-product/inspect-binary-judge-binding-request/1"),
  manifest: InspectBinaryJudgeSelectionManifestSchema,
  host: InspectBinaryJudgeHostBindingSchema,
  // Optional (spec §1.5 rules 2-4): required exactly when `manifest.snapshotProbeSha256` is
  // present, forbidden otherwise. One path, no ambiguity about where the probe bytes come from.
  snapshotProbe: BinaryJudgmentSnapshotProbeSchema.optional(),
}).superRefine((value, ctx) => {
  const requiresProbe = value.manifest.snapshotProbeSha256 !== undefined;
  if (requiresProbe && value.snapshotProbe === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["snapshotProbe"],
      message: "snapshotProbe is required when manifest.snapshotProbeSha256 is present",
    });
  }
  if (!requiresProbe && value.snapshotProbe !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["snapshotProbe"],
      message: "snapshotProbe is forbidden unless manifest.snapshotProbeSha256 is present",
    });
  }
});
export type InspectBinaryJudgeBindingRequest = z.infer<
  typeof InspectBinaryJudgeBindingRequestSchema
>;
