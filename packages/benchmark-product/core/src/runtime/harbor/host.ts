import { HarborSelectionManifestSchema, assertSupportedHarborVersion, type HarborSelectionManifest } from "./manifest.js";
import { HarborDirectVenue, processHarborCommandRunner, type HarborCommandRunner } from "./venue.js";

export interface HarborRuntimeSelectionRequest {
  readonly executable: string;
  /** Digest of the exact host-managed executable selected by the caller/host. */
  readonly executableSha256: string;
  readonly dataset: HarborSelectionManifest["dataset"];
  readonly task: HarborSelectionManifest["task"];
  readonly agent: HarborSelectionManifest["agent"];
  readonly model: HarborSelectionManifest["model"];
  readonly environment: HarborSelectionManifest["environment"];
  readonly runner?: HarborCommandRunner;
}

export interface HarborRuntimeSelectionResolution {
  readonly manifest: HarborSelectionManifest;
  /** Private host binding: never part of the sealed selection or a public bundle. */
  readonly binding: { readonly executable: string };
}

export async function resolveHarborSelection(input: HarborRuntimeSelectionRequest, signal?: AbortSignal): Promise<HarborRuntimeSelectionResolution> {
  const runner = input.runner ?? processHarborCommandRunner;
  const version = await runner.run(input.executable, ["--version"], undefined, signal);
  if (version.code !== 0) throw new Error("Harbor version probe failed");
  const resolvedVersion = new TextDecoder().decode(version.stdout).trim().replace(/^harbor\s+/iu, "");
  assertSupportedHarborVersion(resolvedVersion);
  const manifest = HarborSelectionManifestSchema.parse({
    schema: "jinn.network/benchmark-product/harbor-selection/1",
    adapter: { id: "harbor", version: "1" },
    harbor: { version: resolvedVersion, executableSha256: input.executableSha256 },
    dataset: input.dataset, task: input.task, agent: input.agent, model: input.model, environment: input.environment,
    retryPolicy: { nAttempts: 1, nConcurrent: 1, maxRetries: 0 },
  });
  return { manifest, binding: { executable: input.executable } };
}

/** Narrow host seam for direct Harbor; lifecycle wiring deliberately remains a later packet. */
export function createHarborDirectVenue(input: { readonly workspaceDir: string; readonly binding: { readonly executable: string }; readonly runner?: HarborCommandRunner }): HarborDirectVenue {
  return new HarborDirectVenue({ workspaceDir: input.workspaceDir, executable: input.binding.executable, runner: input.runner });
}
