import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { z } from "zod";
import { atomicWriteFileSync, readFileIfExistsSync } from "../../fs/atomic.js";
import { runtimeHostPath } from "../../workspace/layout.js";
import { HarborSelectionManifestSchema, assertSupportedHarborVersion, type HarborSelectionManifest } from "./manifest.js";

export interface HarborRuntimeSelectionRequest {
  readonly executable: string;
  readonly dataset: HarborSelectionManifest["dataset"];
  readonly task: HarborSelectionManifest["task"];
  readonly agent: HarborSelectionManifest["agent"];
  readonly model: HarborSelectionManifest["model"];
  readonly environment: HarborSelectionManifest["environment"];
}

export const HarborHostBindingSchema = z.object({ executable: z.string().min(1) }).strict();
export type HarborHostBinding = z.infer<typeof HarborHostBindingSchema>;
export interface HarborRuntimeSelectionResolution {
  readonly manifest: HarborSelectionManifest;
  /** Private host binding: never part of the sealed selection or a public bundle. */
  readonly binding: HarborHostBinding;
}

export async function resolveHarborSelection(input: HarborRuntimeSelectionRequest, signal?: AbortSignal): Promise<HarborRuntimeSelectionResolution> {
  const executable = realpathSync(input.executable);
  if (!lstatSync(executable).isFile()) throw new TypeError("Harbor executable must be a regular file");
  const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
  const resolvedVersion = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["--version"], { encoding: "utf8", signal, env: { PATH: process.env.PATH ?? "", HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1" } }, (error, stdout) => {
      if (error !== null) reject(new Error("Harbor version probe failed", { cause: error }));
      else resolve(stdout.trim().replace(/^harbor\s+/iu, ""));
    });
  });
  assertSupportedHarborVersion(resolvedVersion);
  const manifest = HarborSelectionManifestSchema.parse({
    schema: "jinn.network/benchmark-product/harbor-selection/1",
    adapter: { id: "harbor", version: "1" },
    harbor: { version: resolvedVersion, executableSha256 },
    dataset: input.dataset, task: input.task, agent: input.agent, model: input.model, environment: input.environment,
    retryPolicy: { nAttempts: 1, nConcurrent: 1, maxRetries: 0 },
  });
  return { manifest, binding: { executable } };
}

export function writeHarborHostBinding(workspaceDir: string, selectionManifestSha256: string, binding: HarborHostBinding): void {
  atomicWriteFileSync(runtimeHostPath(workspaceDir, selectionManifestSha256), JSON.stringify(HarborHostBindingSchema.parse(binding), null, 2));
}

export function readHarborHostBinding(workspaceDir: string, selectionManifestSha256: string): HarborHostBinding {
  const path = runtimeHostPath(workspaceDir, selectionManifestSha256);
  const bytes = readFileIfExistsSync(path);
  if (bytes === undefined) throw new TypeError("the private Harbor executable binding is missing");
  try { return HarborHostBindingSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes))); }
  catch { throw new TypeError("the private Harbor executable binding is invalid"); }
}
