import { resolve } from "node:path";
import { createLocalVenue, type LocalVenue, type LocalVenueOptions } from "../venue/venue.js";
import { probeInspectSelection, type InspectHostBinding } from "./inspect/host.js";
import { probeInspectOciSelection } from "./inspect/oci.js";
import type {
  InspectArmConfiguration,
  InspectRunOptions,
  InspectSelectionManifest,
} from "./inspect/manifest.js";
import type { EvaluationRuntimeBinding } from "../domain/draft.js";

interface InspectRuntimeSelectionBase {
  readonly projectDir: string;
  readonly taskReference: string;
  readonly taskArgs?: Readonly<Record<string, unknown>>;
  readonly arms: readonly InspectArmConfiguration[];
  readonly scorer: { readonly name: string; readonly passValue: string | number | boolean | null };
  readonly runOptions?: InspectRunOptions;
}

export type InspectRuntimeSelectionRequest = InspectRuntimeSelectionBase & ({
  readonly execution?: "local-python";
  readonly pythonPath: string;
} | {
  readonly execution: "oci";
  readonly dockerPath: string;
  readonly imageDigest: string;
  readonly datasetCacheDir: string;
  readonly runOptions: InspectRunOptions & { readonly sampleId: string | number };
});

export interface InspectRuntimeSelectionResolution {
  readonly manifest: InspectSelectionManifest;
  readonly binding: InspectHostBinding;
}

/** Process-owning boundary. Product operations carry state; the injected host owns execution. */
export interface BenchmarkRuntimeHost {
  resolveInspectSelection(input: InspectRuntimeSelectionRequest, signal?: AbortSignal): Promise<InspectRuntimeSelectionResolution>;
  createVenue(
    binding: EvaluationRuntimeBinding | undefined,
    options: Omit<LocalVenueOptions, "evaluationRuntime">,
  ): LocalVenue;
}

export function createDefaultBenchmarkRuntimeHost(): BenchmarkRuntimeHost {
  return {
    async resolveInspectSelection(input, signal) {
      if (input.execution === "oci") {
        return probeInspectOciSelection({
          dockerPath: resolve(input.dockerPath),
          imageDigest: input.imageDigest,
          projectDir: resolve(input.projectDir),
          datasetCacheDir: resolve(input.datasetCacheDir),
          taskReference: input.taskReference,
          taskArgs: input.taskArgs,
          arms: input.arms,
          scorer: input.scorer,
          runOptions: input.runOptions,
        }, signal);
      }
      const binding = {
        kind: "local-python" as const,
        pythonPath: resolve(input.pythonPath),
        projectDir: resolve(input.projectDir),
      };
      return {
        manifest: await probeInspectSelection({
          ...binding,
          taskReference: input.taskReference,
          taskArgs: input.taskArgs,
          arms: input.arms,
          scorer: input.scorer,
          runOptions: input.runOptions,
        }),
        binding,
      };
    },
    createVenue(binding, options) {
      return createLocalVenue({ ...options, ...(binding === undefined ? {} : { evaluationRuntime: binding }) });
    },
  };
}
