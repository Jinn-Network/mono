import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { atomicWriteFileSync, readFileIfExistsSync } from "../../fs/atomic.js";
import { runtimeHostPath } from "../../workspace/layout.js";
import { putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import { HarborSelectionManifestSchema, assertSupportedHarborVersion, HARBOR_ADAPTER_ID, PIER_ADAPTER_ID, type HarborCompatibleAdapterId, type HarborDatasetInput, type HarborSelectionManifest, type HarborTaskInput } from "./manifest.js";
import { assertSupportedPierVersion } from "../deep-swe-v1.1/manifest.js";
import { inheritedTempEnv } from "../child-temp-env.js";

export interface HarborRuntimeSelectionRequest {
  readonly executable: string;
  readonly engine?: HarborCompatibleAdapterId;
  readonly source:
    | { readonly kind: "task"; readonly input: HarborTaskInput; readonly materialPath: string; readonly revision: string }
    | { readonly kind: "dataset"; readonly input: HarborDatasetInput; readonly materialPath: string; readonly revision: string; readonly taskName: string; readonly taskNames?: readonly string[] };
  readonly arms: HarborSelectionManifest["arms"];
  readonly environment: HarborSelectionManifest["environment"];
  readonly outputs: HarborSelectionManifest["outputs"];
  readonly profiles?: HarborSelectionManifest["profiles"];
  readonly retryPolicy?: HarborSelectionManifest["retryPolicy"];
  readonly jobGrain?: HarborSelectionManifest["jobGrain"];
}

export const HarborHostBindingSchema = z.object({ executable: z.string().min(1), sourceMaterialPath: z.string().min(1) }).strict();
export type HarborHostBinding = z.infer<typeof HarborHostBindingSchema>;

const OCI_DIGEST_SUFFIX = /@sha256:[a-f0-9]{64}$/u;

function harborOciRepositoryName(image: string): string {
  if (OCI_DIGEST_SUFFIX.test(image)) return image.replace(OCI_DIGEST_SUFFIX, "");
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  return lastColon > lastSlash ? image.slice(0, lastColon) : image;
}

/** Official TB 2.1 tasks often pin a registry tag in task.toml. The selection still records a digest. */
export function harborImagePinMatchesTaskToml(taskImage: string | undefined, selectionImage: string): boolean {
  if (taskImage === undefined) return false;
  if (taskImage === selectionImage) return true;
  const taskName = harborOciRepositoryName(taskImage);
  const selectionName = harborOciRepositoryName(selectionImage);
  const taskIsTagged = !OCI_DIGEST_SUFFIX.test(taskImage) && taskImage.includes(":");
  return taskIsTagged && OCI_DIGEST_SUFFIX.test(selectionImage) && taskName.length > 0 && taskName === selectionName;
}
export interface HarborRuntimeSelectionResolution {
  readonly manifest: HarborSelectionManifest;
  /** Private host binding: never part of the sealed selection or a public bundle. */
  readonly binding: HarborHostBinding;
}

/** Seal every host byte explicitly referenced by a Harbor selection before the mutable source
 * path can drift. Publication later expands only this digest-addressed closure. */
export function sealHarborSelectionDependencies(workspaceDir: string, resolution: HarborRuntimeSelectionResolution): void {
  const executableBytes = new Uint8Array(readFileSync(realpathSync(resolution.binding.executable)));
  if (sha256Hex(executableBytes) !== resolution.manifest.harbor.executableSha256
    || putSealedBytes(workspaceDir, executableBytes) !== resolution.manifest.harbor.executableSha256) {
    throw new TypeError("Harbor executable bytes do not match the sealed selection");
  }
  const root = realpathSync(resolution.binding.sourceMaterialPath);
  for (const file of resolution.manifest.source.resolved.files) {
    const bytes = new Uint8Array(readFileSync(join(root, file.path)));
    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256 || putSealedBytes(workspaceDir, bytes) !== file.sha256) {
      throw new TypeError(`Harbor source material changed while sealing ${file.path}`);
    }
  }
}

export function resolveHarborMaterial(input: { readonly input: { readonly path?: string; readonly name?: string; readonly version?: string; readonly ref?: string }; readonly materialPath: string; readonly revision: string }): HarborSelectionManifest["source"]["resolved"] {
  const root = realpathSync(input.materialPath);
  if (!lstatSync(root).isDirectory()) throw new TypeError("Harbor resolved material must be a directory");
  const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
  const visit = (directory: string, relative = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const source = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError(`Harbor material refuses symlink ${path}`);
      if (entry.isDirectory()) visit(source, path);
      else if (entry.isFile()) {
        const bytes = readFileSync(source);
        entries.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
      }
      else throw new TypeError(`Harbor material refuses non-regular entry ${path}`);
    }
  };
  visit(root);
  if (entries.length === 0) throw new TypeError("Harbor resolved material must contain at least one regular file");
  const checksum = createHash("sha256").update(canonicalJsonBytes(entries as never)).digest("hex");
  const sourceRevision = input.input.ref ?? input.input.version;
  if (sourceRevision !== undefined && sourceRevision !== input.revision) throw new TypeError("Harbor source ref/version must equal the resolved material revision");
  return { reference: input.input.path ?? input.input.name ?? root, revision: input.revision, checksum, files: entries };
}

export async function resolveHarborSelection(input: HarborRuntimeSelectionRequest, signal?: AbortSignal): Promise<HarborRuntimeSelectionResolution> {
  const engine = input.engine ?? HARBOR_ADAPTER_ID;
  const executable = realpathSync(input.executable);
  if (!lstatSync(executable).isFile()) throw new TypeError("Harbor executable must be a regular file");
  const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
  const resolvedVersion = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["--version"], { encoding: "utf8", signal, env: { ...inheritedTempEnv(), PATH: process.env.PATH ?? "", HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1" } }, (error, stdout) => {
      if (error !== null) reject(new Error(`${engine} version probe failed`, { cause: error }));
      else resolve(stdout.trim().replace(/^(?:harbor|pier)\s+/iu, ""));
    });
  });
  if (engine === PIER_ADAPTER_ID) assertSupportedPierVersion(resolvedVersion);
  else assertSupportedHarborVersion(resolvedVersion);
  const resolved = resolveHarborMaterial(input.source);
  const materialRoot = realpathSync(input.source.materialPath);
  const selectedNames = input.source.kind === "dataset" && input.source.taskNames !== undefined
    ? [...input.source.taskNames]
    : undefined;
  if (selectedNames !== undefined) {
    for (const name of selectedNames) {
      const relative = `${name}/task.toml`;
      if (!resolved.files.some((file) => file.path === relative)) {
        throw new TypeError(`selected Harbor dataset is missing package ${relative}`);
      }
      const taskToml = readFileSync(join(materialRoot, relative), "utf8");
      const image = /^\s*docker_image\s*=\s*["']([^"']+)["']/mu.exec(taskToml)?.[1];
      if (!harborImagePinMatchesTaskToml(image, input.environment.image)) throw new TypeError("selected Harbor task material does not pin the selected OCI image digest");
    }
  } else {
    const taskTomlPaths = resolved.files.filter((file) => file.path === "task.toml" || file.path.endsWith("/task.toml"));
    if (taskTomlPaths.length !== 1) throw new TypeError("selected Harbor source must contain exactly one executable task.toml");
    const taskToml = readFileSync(join(materialRoot, taskTomlPaths[0]!.path), "utf8");
    const image = /^\s*docker_image\s*=\s*["']([^"']+)["']/mu.exec(taskToml)?.[1];
    if (!harborImagePinMatchesTaskToml(image, input.environment.image)) throw new TypeError("selected Harbor task material does not pin the selected OCI image digest");
  }
  const source = input.source.kind === "task"
    ? { kind: "task" as const, input: input.source.input, jobInput: { path: ".jinn-harbor/task" as const }, resolved }
    : {
      kind: "dataset" as const, input: input.source.input, jobInput: { path: ".jinn-harbor/dataset" as const }, resolved,
      taskName: input.source.taskName,
      ...(input.source.taskNames === undefined ? {} : { taskNames: [...input.source.taskNames] }),
    };
  const manifest = HarborSelectionManifestSchema.parse({
    schema: "jinn.network/benchmark-product/harbor-selection/1",
    adapter: { id: engine, version: "1" },
    harbor: { version: resolvedVersion, executableSha256 },
    source, arms: input.arms, environment: input.environment, outputs: input.outputs,
    retryPolicy: input.retryPolicy ?? { nAttempts: 1, nConcurrent: 1, maxRetries: 0 },
    ...(input.jobGrain === undefined ? {} : { jobGrain: input.jobGrain }),
    ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
  });
  return { manifest, binding: { executable, sourceMaterialPath: materialRoot } };
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
