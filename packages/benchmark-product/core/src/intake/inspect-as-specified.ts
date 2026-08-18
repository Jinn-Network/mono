import { defineBenchmark } from "@jinn-network/benchmarking-interop";
import { sealTask, TASK_EXECUTION_PROTOCOL_URI } from "@jinn-network/task-execution-protocol";
import { sealEvaluationSpec, sealTaskProfile } from "@jinn-network/task-execution-profiles";
import {
  buildInspectEvaluationSpec,
  buildInspectTaskProfile,
  INSPECT_NATIVE_LOG_MEDIA_TYPE,
  INSPECT_SUMMARY_MEDIA_TYPE,
  INSPECT_TASK_PROFILE_URI,
} from "../runtime/inspect/artifacts.js";
import { isInspectMultiScorerSelection, type InspectSelectionTemplate } from "../runtime/inspect/manifest.js";
import { sha256Hex } from "../workspace/sealed-store.js";

export function buildInspectAsSpecifiedTasks(input: {
  readonly inspect: InspectSelectionTemplate;
  readonly sampleIds: readonly (string | number)[];
  readonly resolvedName: string;
}): {
  readonly evaluationSpec: { readonly bytes: Uint8Array; readonly sha256: string };
  readonly tasks: readonly {
    readonly sampleId: string | number;
    readonly taskName: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }[];
  readonly benchmark: { readonly bytes: Uint8Array; readonly sha256: string };
} {
  const sealedEvaluation = sealEvaluationSpec(buildInspectEvaluationSpec(input.inspect as never));
  const evaluationSpecSha256 = sealedEvaluation.digest.slice("sha256:".length);
  const sealedProfile = sealTaskProfile(buildInspectTaskProfile());
  const instructions = isInspectMultiScorerSelection(input.inspect as never)
    ? "Execute the selected Inspect sample exactly once (epochs=1), retain the complete native log, and project its configured scorer outputs without replacing Inspect authoring, scoring, reduction, or execution."
    : "Execute the selected Inspect sample exactly once (epochs=1), retain the complete native log, and project its configured scorer without replacing Inspect authoring or execution.";
  const tasks = input.sampleIds.map((sampleId) => {
    const taskDocument = {
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: {
        uri: INSPECT_TASK_PROFILE_URI,
        digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
      },
      instructions,
      payload: { sampleId },
      outputs: [
        { name: "inspect-log", mediaType: INSPECT_NATIVE_LOG_MEDIA_TYPE, required: true },
        { name: "inspect-summary", mediaType: INSPECT_SUMMARY_MEDIA_TYPE, required: true },
        { name: "verdict", mediaType: "application/vnd.in-toto+json", required: false },
      ],
      evaluation: {
        name: "inspect-score-evaluation-spec.json",
        digest: { sha256: evaluationSpecSha256 },
        mediaType: "application/json",
      },
      author: "urn:jinn:benchmark-product:inspect-as-specified",
    };
    const bytes = sealTask(taskDocument);
    return {
      sampleId,
      taskName: String(sampleId),
      bytes,
      sha256: sha256Hex(bytes),
    };
  });
  const benchmark = defineBenchmark(
    tasks.map((task) => ({ bytes: task.bytes, digest: `sha256:${task.sha256}` as const })),
    {
      name: `inspect-as-specified:${input.resolvedName}`,
      description: "Inspect-as-specified: one unmodified Inspect sample invocation per benchmark cell; specified epochs are Jinn replicates.",
      version: "1.0.0",
    },
  );
  return {
    evaluationSpec: { bytes: sealedEvaluation.bytes, sha256: evaluationSpecSha256 },
    tasks,
    benchmark: { bytes: benchmark.bytes, sha256: sha256Hex(benchmark.bytes) },
  };
}
