import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  INSPECT_SELECTION_SCHEMA,
  InspectSelectionManifestSchema,
  SUPPORTED_INSPECT_EVALS_VERSION,
  SUPPORTED_OPENAI_SDK_VERSION,
  SUPPORTED_OCI_PLATFORM,
  type InspectArmConfiguration,
  type InspectRunOptions,
  type InspectSelectionManifest,
} from "./manifest.js";

const SafeAbsolutePathSchema = z.string().min(1).refine(
  (value) => isAbsolute(value) && !/[\n\r,]/u.test(value),
  "must be an absolute path without control characters or commas",
);

export const INSPECT_OCI_LIMITS = Object.freeze({
  cpuCount: 1,
  memoryBytes: 1_073_741_824,
  pidsLimit: 64,
  scratchBytes: 536_870_912,
});

export const INSPECT_OCI_MOUNTS = [
  "project:ro",
  "dataset-cache:ro",
  "attempt-input:ro",
  "attempt-output:rw",
] as const;

export const InspectOciHostBindingSchema = z.object({
  kind: z.literal("oci"),
  dockerPath: SafeAbsolutePathSchema,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  platform: z.literal(SUPPORTED_OCI_PLATFORM),
  projectDir: SafeAbsolutePathSchema,
  datasetCacheDir: SafeAbsolutePathSchema,
  user: z.string().regex(/^[0-9]+:[0-9]+$/),
}).strict();
export type InspectOciHostBinding = z.infer<typeof InspectOciHostBindingSchema>;

export interface ProbeInspectOciSelectionInput {
  readonly dockerPath: string;
  readonly imageDigest: string;
  readonly projectDir: string;
  readonly datasetCacheDir: string;
  readonly taskReference: string;
  readonly taskArgs?: Readonly<Record<string, unknown>>;
  readonly arms: readonly InspectArmConfiguration[];
  readonly scorer: { readonly name: string; readonly passValue: string | number | boolean | null };
  readonly runOptions: InspectRunOptions & { readonly sampleId: string | number };
}

export interface InspectOciSelectionResolution {
  readonly manifest: InspectSelectionManifest;
  readonly binding: InspectOciHostBinding;
}

export interface InspectOciRunInput {
  readonly name: string;
  readonly operation: "probe" | "run";
  readonly inputDir?: string;
  readonly outputDir?: string;
  readonly network: "none" | string;
}

function bindMount(source: string, destination: string, readonly = false): string {
  if (!isAbsolute(source) || /[\n\r,]/u.test(source)) throw new TypeError("OCI bind sources must be safe absolute paths");
  return `type=bind,src=${source},dst=${destination}${readonly ? ",readonly" : ""}`;
}

/** Pure Docker CLI plan. No shell is involved and no ambient environment is forwarded. */
export function buildInspectOciRunArgs(
  binding: InspectOciHostBinding,
  input: InspectOciRunInput,
): readonly string[] {
  const name = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/).parse(input.name);
  const args = [
    "run",
    "--rm",
    "--interactive",
    "--pull=never",
    `--platform=${binding.platform}`,
    `--name=${name}`,
    `--hostname=${name}`,
    `--user=${binding.user}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--network=${input.network}`,
    `--pids-limit=${INSPECT_OCI_LIMITS.pidsLimit}`,
    `--memory=${INSPECT_OCI_LIMITS.memoryBytes}`,
    `--cpus=${INSPECT_OCI_LIMITS.cpuCount}`,
    "--ulimit=nofile=1024:1024",
    "--ipc=none",
    `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${INSPECT_OCI_LIMITS.scratchBytes}`,
    `--tmpfs=/jinn/work:rw,noexec,nosuid,nodev,size=${INSPECT_OCI_LIMITS.scratchBytes}`,
    "--workdir=/jinn/work",
    "--env=PYTHONDONTWRITEBYTECODE=1",
    "--env=PYTHONNOUSERSITE=1",
    "--env=PYTHONUTF8=1",
    "--env=LANG=C.UTF-8",
    "--env=HOME=/tmp/home",
    "--env=XDG_DATA_HOME=/tmp/xdg/data",
    "--env=XDG_CACHE_HOME=/tmp/xdg/cache",
    "--env=XDG_CONFIG_HOME=/tmp/xdg/config",
    "--env=XDG_STATE_HOME=/tmp/xdg/state",
    "--env=HF_HOME=/jinn/dataset-cache",
    "--env=HF_DATASETS_OFFLINE=1",
    "--env=TRANSFORMERS_OFFLINE=1",
    "--env=TIKTOKEN_CACHE_DIR=/opt/jinn/tiktoken-cache",
    "--mount", bindMount(binding.projectDir, "/jinn/project", true),
    "--mount", bindMount(binding.datasetCacheDir, "/jinn/dataset-cache", true),
  ];
  if (input.operation === "run") {
    if (input.inputDir === undefined || input.outputDir === undefined) {
      throw new TypeError("OCI run requires attempt input and output directories");
    }
    args.push(
      "--mount", bindMount(input.inputDir, "/jinn/input", true),
      "--mount", bindMount(input.outputDir, "/jinn/output"),
    );
  }
  args.push(binding.imageDigest, input.operation);
  if (input.operation === "run") args.push("/jinn/input/inspect-run.json");
  return args;
}

/** Content digest for an offline cache or selected project. Symlinks are refused. */
export function directoryTreeSha256(root: string): string {
  const resolvedRoot = realpathSync(root);
  const records: Array<readonly [string, string]> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new TypeError(`OCI input tree contains a symlink at ${relative(resolvedRoot, path)}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        records.push([relative(resolvedRoot, path), createHash("sha256").update(readFileSync(path)).digest("hex")]);
      }
    }
  };
  visit(resolvedRoot);
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

interface ProcessResult {
  readonly stdout: string;
}

async function runBoundedProcess(
  executable: string,
  args: readonly string[],
  stdin?: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], signal });
    const stdout: Buffer[] = [];
    let bytes = 0;
    const capture = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 1_000_000) child.kill("SIGKILL");
      else stdout.push(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_000_000) child.kill("SIGKILL"); });
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      if (code !== 0) {
        reject(new Error(`OCI runtime command exited ${String(code ?? exitSignal)}`));
        return;
      }
      resolvePromise({ stdout: Buffer.concat(stdout).toString("utf8").trim() });
    });
    child.stdin.end(stdin);
  });
}

const DockerServerSchema = z.object({
  Version: z.string().min(1),
  ApiVersion: z.string().min(1),
  Os: z.literal("linux"),
});

const DockerImageSchema = z.object({
  Id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  Architecture: z.literal("amd64"),
  Os: z.literal("linux"),
});

const WorkerEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.object({ runtime: z.record(z.string(), z.unknown()), task: z.unknown(), scorer: z.unknown() }) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

function inspectWorkerSourceSha256(): string {
  const path = fileURLToPath(new URL("./worker.py", import.meta.url));
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function inspectOciRunnerPath(): string {
  return fileURLToPath(new URL("./oci-runner.mjs", import.meta.url));
}

export function inspectOciRunnerSha256(): string {
  return createHash("sha256").update(readFileSync(inspectOciRunnerPath())).digest("hex");
}

export async function probeInspectOciSelection(
  input: ProbeInspectOciSelectionInput,
  signal?: AbortSignal,
): Promise<InspectOciSelectionResolution> {
  const binding = InspectOciHostBindingSchema.parse({
    kind: "oci",
    dockerPath: resolve(input.dockerPath),
    imageDigest: input.imageDigest,
    platform: SUPPORTED_OCI_PLATFORM,
    projectDir: realpathSync(input.projectDir),
    datasetCacheDir: realpathSync(input.datasetCacheDir),
    user: `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`,
  });
  const [serverResult, imageResult] = await Promise.all([
    runBoundedProcess(binding.dockerPath, ["version", "--format", "{{json .Server}}"], undefined, signal),
    runBoundedProcess(binding.dockerPath, ["image", "inspect", "--format", "{{json .}}", binding.imageDigest], undefined, signal),
  ]);
  const server = DockerServerSchema.parse(JSON.parse(serverResult.stdout));
  const image = DockerImageSchema.parse(JSON.parse(imageResult.stdout));
  if (image.Id !== binding.imageDigest) throw new TypeError("OCI image ID does not match the selected digest");

  const workerSourceSha256 = inspectWorkerSourceSha256();
  const probeArgs = buildInspectOciRunArgs(binding, {
    name: `jinn-inspect-probe-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    operation: "probe",
    network: "none",
  });
  const workerResult = await runBoundedProcess(binding.dockerPath, probeArgs, JSON.stringify({
    projectDir: "/jinn/project",
    taskReference: input.taskReference,
    taskArgs: input.taskArgs ?? {},
    scorerName: input.scorer.name,
    runOptions: input.runOptions,
  }), signal);
  const envelope = WorkerEnvelopeSchema.parse(JSON.parse(workerResult.stdout));
  if (!envelope.ok) throw new Error("OCI Inspect worker probe failed");
  const runtime = envelope.value.runtime;
  if (runtime.inspectEvalsVersion !== SUPPORTED_INSPECT_EVALS_VERSION) throw new TypeError("Inspect Evals version drifted in the OCI image");
  if (runtime.openaiSdkVersion !== SUPPORTED_OPENAI_SDK_VERSION) throw new TypeError("OpenAI SDK version drifted in the OCI image");
  if (runtime.workerSha256 !== undefined && runtime.workerSha256 !== workerSourceSha256) throw new TypeError("OCI worker source differs from the product worker");

  const manifest = InspectSelectionManifestSchema.parse({
    schema: INSPECT_SELECTION_SCHEMA,
    runtime: {
      ...runtime,
      adapterVersion: "1",
      workerSha256: workerSourceSha256,
      execution: {
        kind: "oci",
        imageDigest: binding.imageDigest,
        platform: binding.platform,
        inspectEvalsVersion: SUPPORTED_INSPECT_EVALS_VERSION,
        openaiSdkVersion: SUPPORTED_OPENAI_SDK_VERSION,
        workerSourceSha256,
        runtimeHostSourceSha256: inspectOciRunnerSha256(),
        dockerExecutableSha256: createHash("sha256").update(readFileSync(binding.dockerPath)).digest("hex"),
        dockerEngineVersion: server.Version,
        dockerApiVersion: server.ApiVersion,
        datasetCacheSha256: directoryTreeSha256(binding.datasetCacheDir),
        isolation: {
          readOnlyRoot: true,
          network: "none",
          capabilities: [],
          noNewPrivileges: true,
          ...INSPECT_OCI_LIMITS,
          user: binding.user,
          mounts: INSPECT_OCI_MOUNTS,
        },
      },
    },
    task: envelope.value.task,
    arms: input.arms,
    scorer: { ...input.scorer, definition: envelope.value.scorer },
    runOptions: input.runOptions,
  });
  return { manifest, binding };
}

export async function assertInspectOciHostUndrifted(
  binding: InspectOciHostBinding,
  manifest: InspectSelectionManifest,
  signal?: AbortSignal,
): Promise<void> {
  const execution = manifest.runtime.execution;
  if (execution === undefined) throw new TypeError("sealed Inspect selection does not carry OCI identity");
  if (directoryTreeSha256(binding.datasetCacheDir) !== execution.datasetCacheSha256) {
    throw new TypeError("offline dataset cache drifted after selection");
  }
  const [serverResult, imageResult] = await Promise.all([
    runBoundedProcess(binding.dockerPath, ["version", "--format", "{{json .Server}}"], undefined, signal),
    runBoundedProcess(binding.dockerPath, ["image", "inspect", "--format", "{{json .}}", binding.imageDigest], undefined, signal),
  ]);
  const server = DockerServerSchema.parse(JSON.parse(serverResult.stdout));
  const image = DockerImageSchema.parse(JSON.parse(imageResult.stdout));
  if (
    image.Id !== execution.imageDigest
    || server.Version !== execution.dockerEngineVersion
    || server.ApiVersion !== execution.dockerApiVersion
    || inspectWorkerSourceSha256() !== execution.workerSourceSha256
    || inspectOciRunnerSha256() !== execution.runtimeHostSourceSha256
    || createHash("sha256").update(readFileSync(binding.dockerPath)).digest("hex") !== execution.dockerExecutableSha256
  ) {
    throw new TypeError("OCI image, Docker runtime, or worker source drifted after selection");
  }
}
