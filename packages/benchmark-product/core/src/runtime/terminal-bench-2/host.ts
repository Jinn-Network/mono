import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { artifactsDir } from "../../workspace/layout.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import { assertSupportedHarborVersion, type HarborSelectionManifest } from "../harbor/manifest.js";
import { resolveHarborMaterial, type HarborRuntimeSelectionRequest } from "../harbor/host.js";
import {
  TERMINAL_BENCH_2_DATASET_ID,
  TERMINAL_BENCH_2_PROFILE,
  HARBOR_021_PACKAGER_ALGORITHM,
  TerminalBench2SelectionManifestSchema,
  TerminalBenchRegistryMetadataSchema,
  TerminalBenchMigrationManifestSchema,
  terminalBench2SelectionBytes,
  terminalBenchMigrationBytes,
  type TerminalBench2SelectionManifest,
  type TerminalBenchMaterial,
  type TerminalBenchMigrationManifest,
} from "./manifest.js";

export interface TerminalBench2SelectionRequest {
  readonly executable: string;
  readonly registryMetadataPath: string;
  readonly datasetRevision: `sha256:${string}`;
  /** Private local projection containing exactly one `<taskName>/task.toml` package. */
  readonly taskMaterialPath: string;
  readonly taskName: string;
  readonly taskRevision: `sha256:${string}`;
  readonly migrationManifestSha256?: string;
  readonly arms: HarborSelectionManifest["arms"];
  readonly environment: HarborSelectionManifest["environment"];
  readonly outputs: HarborSelectionManifest["outputs"];
}

function harborDefaultIgnoreMatches(relative: string, finalComponentIsDirectory: boolean): boolean {
  const components = relative.split("/");
  return components.some((component, index) => {
    const isDirectory = index < components.length - 1 || finalComponentIsDirectory;
    return (isDirectory && component === "__pycache__") || component.endsWith(".pyc")
      || component === ".DS_Store" || component.endsWith(".swp")
      || component.endsWith(".swo") || component.endsWith("~");
  });
}

/** Python compares Unicode strings by scalar value, unlike JavaScript's UTF-16
 * relational comparison. Harbor sorts relative paths with Python's string order. */
function comparePythonUnicode(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index]! !== rightPoints[index]!) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

/** Faithful Harbor v0.21.0 `Packager.compute_content_hash` for its default-ignore
 * branch. Custom `.gitignore` uses Python pathspec semantics, so this implementation
 * refuses it instead of silently approximating the registry identity. */
export function computeHarbor021TaskContentHash(taskPath: string): { readonly contentHash: string; readonly files: readonly string[] } {
  const root = realpathSync(taskPath);
  if (!lstatSync(root).isDirectory()) throw new TypeError("Harbor package task must be a directory");
  if (existsSync(join(root, ".gitignore"))) throw new TypeError("Harbor package hashing refuses custom .gitignore; resolve with the pinned official Packager instead");
  const files: string[] = [];
  for (const name of ["task.toml", "instruction.md", "README.md"]) if (existsSync(join(root, name))) {
    if (lstatSync(join(root, name)).isSymbolicLink()) throw new TypeError(`Harbor package hashing refuses symlink ${name}`);
    files.push(name);
  }
  const visit = (directory: string, relative: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError(`Harbor package hashing refuses symlink ${path}`);
      if (entry.isDirectory()) {
        if (!harborDefaultIgnoreMatches(path, true)) visit(absolute, path);
      } else if (entry.isFile() && !harborDefaultIgnoreMatches(path, false)) files.push(path);
      else if (!entry.isFile()) throw new TypeError(`Harbor package hashing refuses non-regular entry ${path}`);
    }
  };
  for (const directory of ["environment", "tests", "solution", "steps"]) {
    const absolute = join(root, directory);
    if (existsSync(absolute)) visit(absolute, directory);
  }
  files.sort(comparePythonUnicode);
  const outer = createHash("sha256");
  for (const relative of files) {
    const digest = createHash("sha256").update(readFileSync(join(root, relative))).digest("hex");
    outer.update(`${relative}\0${digest}\n`);
  }
  return { contentHash: outer.digest("hex"), files };
}

export interface TerminalBench2SelectionResolution {
  readonly profile: TerminalBench2SelectionManifest;
  readonly profileSha256: string;
  readonly harbor: HarborRuntimeSelectionRequest;
}

function sealMaterial(workspaceDir: string, root: string, material: HarborSelectionManifest["source"]["resolved"]): TerminalBenchMaterial {
  const canonicalRoot = realpathSync(root);
  for (const file of material.files) {
    const bytes = new Uint8Array(readFileSync(join(canonicalRoot, file.path)));
    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) throw new TypeError(`Terminal-Bench material changed while sealing ${file.path}`);
    if (putSealedBytes(workspaceDir, bytes) !== file.sha256) throw new TypeError(`Terminal-Bench CAS refused ${file.path}`);
  }
  return { checksum: material.checksum, files: material.files };
}

export function resolveTerminalBench2Selection(workspaceDir: string, input: TerminalBench2SelectionRequest): TerminalBench2SelectionResolution {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.datasetRevision)) throw new TypeError("Terminal-Bench 2 dataset revision must be an immutable sha256 registry revision");
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.taskRevision)) throw new TypeError("Terminal-Bench 2 task revision must be an immutable sha256 package ref");
  const registryBytes = new Uint8Array(readFileSync(realpathSync(input.registryMetadataPath)));
  const registry = TerminalBench2SelectionManifestSchema.shape.dataset.shape.registrySnapshotSha256.safeParse(sha256Hex(registryBytes));
  if (!registry.success) throw new TypeError("Terminal-Bench 2 registry snapshot digest is invalid");
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(registryBytes)); }
  catch { throw new TypeError("Terminal-Bench 2 registry snapshot must be UTF-8 JSON"); }
  const parsed = TerminalBenchRegistryMetadataSchema.parse(metadata);
  const contentHash = parsed.dataset_version_content_hash.replace(/^sha256:/u, "");
  if (`sha256:${contentHash}` !== input.datasetRevision) throw new TypeError("Terminal-Bench 2 registry revision drifted from the selected immutable dataset revision");
  const matches = parsed.task_ids.filter((task) => task.name === input.taskName && task.ref === input.taskRevision);
  if (matches.length !== 1) throw new TypeError("Terminal-Bench 2 selected task/ref must occur exactly once in the resolved dataset metadata");

  const harborSource = {
    kind: "dataset" as const,
    input: { name: TERMINAL_BENCH_2_DATASET_ID, ref: input.datasetRevision },
    materialPath: input.taskMaterialPath,
    revision: input.datasetRevision,
    taskName: input.taskName,
  };
  const resolved = resolveHarborMaterial(harborSource);
  const taskTomls = resolved.files.filter((file) => file.path === `${input.taskName}/task.toml`);
  if (taskTomls.length !== 1 || resolved.files.some((file) => file.path.endsWith("/task.toml") && file.path !== `${input.taskName}/task.toml`)) {
    throw new TypeError("Terminal-Bench 2 material must contain exactly the selected task package");
  }
  const packageHash = computeHarbor021TaskContentHash(join(realpathSync(input.taskMaterialPath), input.taskName));
  if (`sha256:${packageHash.contentHash}` !== input.taskRevision) throw new TypeError("Terminal-Bench 2 task ref does not match Harbor 0.21 Packager.compute_content_hash over the selected package bytes");
  sealMaterial(workspaceDir, input.taskMaterialPath, resolved);
  const taskRoot = join(realpathSync(input.taskMaterialPath), input.taskName);
  const taskResolved = resolveHarborMaterial({ input: { name: `terminal-bench/${input.taskName}`, ref: input.taskRevision }, materialPath: taskRoot, revision: input.taskRevision });
  const material = sealMaterial(workspaceDir, taskRoot, taskResolved);
  let migrationManifestSha256: string | undefined;
  if (input.migrationManifestSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(input.migrationManifestSha256)) throw new TypeError("Terminal-Bench migration manifest digest must be lowercase sha256 hex");
    const migration = TerminalBenchMigrationManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(workspaceDir, input.migrationManifestSha256))));
    if (migration.runnable.checksum !== material.checksum) throw new TypeError("Terminal-Bench migration runnable bytes do not equal the selected immutable task material");
    migrationManifestSha256 = input.migrationManifestSha256;
  }
  const registrySnapshotSha256 = putSealedBytes(workspaceDir, registryBytes);
  const profile = TerminalBench2SelectionManifestSchema.parse({
    schema: "jinn.network/benchmark-product/terminal-bench-2-selection/1",
    dataset: { id: TERMINAL_BENCH_2_DATASET_ID, revision: input.datasetRevision, registrySnapshotSha256, registrySnapshotBytes: registryBytes.byteLength },
    selectedTask: { package: { name: `terminal-bench/${input.taskName}`, ref: input.taskRevision }, contentHashAlgorithm: HARBOR_021_PACKAGER_ALGORITHM, filter: input.taskName, datasetProjectionChecksum: resolved.checksum, material },
    ...(migrationManifestSha256 === undefined ? {} : { migrationManifestSha256 }),
    execution: { source: "dataset", nTasks: 1, nAttempts: 1, nConcurrent: 1, maxRetries: 0 },
  });
  const profileSha256 = sha256Hex(terminalBench2SelectionBytes(profile));
  return {
    profile,
    profileSha256,
    harbor: {
      executable: input.executable,
      source: harborSource,
      arms: input.arms,
      environment: input.environment,
      outputs: input.outputs,
      profiles: { [TERMINAL_BENCH_2_PROFILE]: profile },
    },
  };
}

export interface TerminalBenchMigrationRequest {
  readonly executable: string;
  readonly sourcePath: string;
  readonly adjustedMaterialPath?: string;
  readonly manualAdjustment: { readonly status: "none" } | { readonly status: "applied"; readonly description: string };
}

export interface TerminalBenchMigrationResolution {
  readonly manifest: TerminalBenchMigrationManifest;
  readonly manifestSha256: string;
  /** Private derived directory; never included in the sealed migration manifest. */
  readonly runnableMaterialPath: string;
}

async function execute(executable: string, argv: readonly string[], cwd?: string): Promise<{ stdout: Uint8Array; stderr: Uint8Array }> {
  return await new Promise((resolve, reject) => execFile(executable, [...argv], {
    cwd, encoding: "buffer", env: { PATH: process.env.PATH ?? "", HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1" }, maxBuffer: 16 * 1024 * 1024,
  }, (error, stdout, stderr) => error === null
    ? resolve({ stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) })
    : reject(new Error(`Harbor command failed: ${argv.join(" ")}`, { cause: error }))));
}

function materialSnapshot(workspaceDir: string, path: string, revision: string): TerminalBenchMaterial {
  const resolved = resolveHarborMaterial({ input: { path: "material" }, materialPath: path, revision });
  return sealMaterial(workspaceDir, path, resolved);
}

export async function migrateTerminalBenchLegacyMaterial(workspaceDir: string, input: TerminalBenchMigrationRequest): Promise<TerminalBenchMigrationResolution> {
  if ((input.adjustedMaterialPath === undefined) !== (input.manualAdjustment.status === "none")) {
    throw new TypeError("manual adjustment disclosure and adjusted material path must agree");
  }
  const executable = realpathSync(input.executable);
  if (!lstatSync(executable).isFile()) throw new TypeError("Harbor executable must be a regular file");
  const executableBytes = new Uint8Array(readFileSync(executable));
  const versionResult = await execute(executable, ["--version"]);
  const version = new TextDecoder().decode(versionResult.stdout).trim().replace(/^harbor\s+/iu, "");
  assertSupportedHarborVersion(version);
  mkdirSync(artifactsDir(workspaceDir), { recursive: true });
  const root = mkdtempSync(join(artifactsDir(workspaceDir), "terminal-bench-migration-"));
  const source = join(root, "source");
  const transformed = join(root, "transformed");
  mkdirSync(source, { recursive: true });
  const sourcePreflight = materialSnapshot(workspaceDir, input.sourcePath, "legacy-source");
  cpSync(realpathSync(input.sourcePath), source, { recursive: true, dereference: false, errorOnExist: true });
  const sourceSnapshot = materialSnapshot(workspaceDir, source, "legacy-source");
  if (sourceSnapshot.checksum !== sourcePreflight.checksum) throw new TypeError("legacy Terminal-Bench source changed while staging");
  const argv = ["task", "migrate", "-i", "source", "-o", "transformed"] as const;
  const result = await execute(executable, argv, root);
  const transformedSnapshot = materialSnapshot(workspaceDir, transformed, "harbor-migrated");
  const runnableMaterialPath = input.adjustedMaterialPath === undefined ? transformed : realpathSync(input.adjustedMaterialPath);
  const runnableSnapshot = input.adjustedMaterialPath === undefined
    ? transformedSnapshot
    : materialSnapshot(workspaceDir, runnableMaterialPath, "manually-adjusted");
  const stdoutSha256 = putSealedBytes(workspaceDir, result.stdout);
  const stderrSha256 = putSealedBytes(workspaceDir, result.stderr);
  const executableSha256 = putSealedBytes(workspaceDir, executableBytes);
  if (sha256Hex(new Uint8Array(readFileSync(executable))) !== executableSha256) {
    throw new TypeError("Harbor executable changed during legacy migration");
  }
  const manifest = TerminalBenchMigrationManifestSchema.parse({
    schema: "jinn.network/benchmark-product/terminal-bench-migration/1",
    harbor: { version, executableSha256 },
    command: { executable: "harbor", argv, stdoutSha256, stderrSha256 },
    relationship: "source-transformed-by-harbor-mapper",
    source: sourceSnapshot,
    transformed: transformedSnapshot,
    runnable: runnableSnapshot,
    manualAdjustment: input.manualAdjustment,
  });
  const bytes = terminalBenchMigrationBytes(manifest);
  const manifestSha256 = putSealedBytes(workspaceDir, bytes);
  return { manifest, manifestSha256, runnableMaterialPath };
}
