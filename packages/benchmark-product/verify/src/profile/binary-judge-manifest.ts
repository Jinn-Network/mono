import { z } from "zod";
import {
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BinaryJudgmentGenerationSchema,
} from "@jinn-network/task-execution-profiles";
import { compareCodeUnitStrings } from "@jinn-network/task-execution-protocol";

export const INSPECT_BINARY_JUDGE_ADAPTER_ID = "inspect-binary-judge" as const;
export const INSPECT_BINARY_JUDGE_LAUNCHER_ID = "inspect-ai-judge" as const;
export const INSPECT_BINARY_JUDGE_LAUNCHER_VERSION = "1" as const;
export const INSPECT_BINARY_JUDGE_SELECTION_SCHEMA =
  "jinn.network/benchmark-product/inspect-binary-judge-selection/1" as const;
export const INSPECT_SELECTION_CORRELATION_ROLE =
  "https://product.jinn.network/artifact-roles/inspect/selection-manifest/v1" as const;

export const INSPECT_BINARY_JUDGE_INSPECT_VERSION = "0.3.255" as const;
export const INSPECT_BINARY_JUDGE_INSPECT_EVALS_VERSION = "0.16.0" as const;
export const INSPECT_BINARY_JUDGE_OPENAI_SDK_VERSION = "2.53.0" as const;
export const INSPECT_BINARY_JUDGE_PYTHON_VERSION = "3.11.9" as const;
export const INSPECT_BINARY_JUDGE_OCI_PLATFORM = "linux/amd64" as const;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const InspectBinaryJudgeArmSchema = z.strictObject({
  armId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  instrumentSha256: Sha256DigestSchema,
  model: z.literal("gpt-5.6-luna"),
  generation: BinaryJudgmentGenerationSchema,
});
export type InspectBinaryJudgeArm = z.infer<typeof InspectBinaryJudgeArmSchema>;

/** Portable public selection for the binary judge runtime. Host paths and credentials are absent. */
export const InspectBinaryJudgeSelectionManifestSchema = z.strictObject({
  schema: z.literal(INSPECT_BINARY_JUDGE_SELECTION_SCHEMA),
  runtime: z.strictObject({
    imageDigest: Sha256DigestSchema,
    platform: z.literal(INSPECT_BINARY_JUDGE_OCI_PLATFORM),
    pythonVersion: z.literal(INSPECT_BINARY_JUDGE_PYTHON_VERSION),
    inspectVersion: z.literal(INSPECT_BINARY_JUDGE_INSPECT_VERSION),
    inspectEvalsVersion: z.literal(INSPECT_BINARY_JUDGE_INSPECT_EVALS_VERSION),
    openaiSdkVersion: z.literal(INSPECT_BINARY_JUDGE_OPENAI_SDK_VERSION),
    runtimeHostSourceSha256: Sha256HexSchema,
    workerSourceSha256: Sha256HexSchema,
    brokerSourceSha256: Sha256HexSchema,
    modelProviderSourceSha256: Sha256HexSchema,
  }),
  execution: z.strictObject({
    callsPerCell: z.literal(1),
    epochs: z.literal(1),
    inspectScorer: z.literal(false),
    retries: z.literal(0),
    fallbacks: z.literal(0),
    tools: z.tuple([]),
    storage: z.literal(false),
  }),
  requirement: z.strictObject({
    key: z.literal(BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY),
    valueShape: z.literal("sha256:<64-lowercase-hex>"),
    comparison: z.literal("exact"),
    location: z.literal("submission-effective-requirements"),
  }),
  arms: z.array(InspectBinaryJudgeArmSchema).min(2),
}).superRefine((manifest, context) => {
  const armIds = manifest.arms.map((arm) => arm.armId);
  if (new Set(armIds).size !== armIds.length) {
    context.addIssue({ code: "custom", path: ["arms"], message: "armId values must be unique" });
  }
  const sortedArmIds = [...armIds].sort(compareCodeUnitStrings);
  if (armIds.some((armId, index) => armId !== sortedArmIds[index])) {
    context.addIssue({ code: "custom", path: ["arms"], message: "arms must be code-unit sorted by armId" });
  }
  const instruments = manifest.arms.map((arm) => arm.instrumentSha256);
  if (new Set(instruments).size !== instruments.length) {
    context.addIssue({ code: "custom", path: ["arms"], message: "each judge arm must bind one distinct instrument digest" });
  }
  const generation = JSON.stringify(manifest.arms[0]?.generation);
  if (manifest.arms.some((arm) => JSON.stringify(arm.generation) !== generation)) {
    context.addIssue({ code: "custom", path: ["arms"], message: "all arms must share one identical generation block" });
  }
});
export type InspectBinaryJudgeSelectionManifest = z.infer<
  typeof InspectBinaryJudgeSelectionManifestSchema
>;
