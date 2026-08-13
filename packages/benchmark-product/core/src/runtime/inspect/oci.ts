import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  INSPECT_SELECTION_SCHEMA,
  INSPECT_SANDBOX_PACKAGE_VERSION,
  INSPECT_SANDBOX_PROTOCOL,
  INSPECT_SANDBOX_PROVIDER,
  INSPECT_SANDBOX_SELECTION_SCHEMA,
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

export const INSPECT_OCI_PROVIDER_MOUNTS = [
  ...INSPECT_OCI_MOUNTS,
  "broker-capability:ro",
] as const;

export const INSPECT_BROKER_POLICY = Object.freeze({
  protocol: "jinn.network/model-broker/1" as const,
  requestEndpoint: "https://api.openai.com/v1/responses" as const,
  network: "bridge-plus-private-internal" as const,
  secretMount: "credential-volume:/run/secrets:ro" as const,
  capabilityMount: "capability-volume:/run/jinn:ro" as const,
  readOnlyRoot: true as const,
  capabilities: [] as [],
  noNewPrivileges: true as const,
  cpuCount: 1,
  memoryBytes: 268_435_456,
  pidsLimit: 32,
  scratchBytes: 67_108_864,
});

export const INSPECT_SANDBOX_POLICY = Object.freeze({
  provider: INSPECT_SANDBOX_PROVIDER,
  platform: SUPPORTED_OCI_PLATFORM,
  user: "65532:65532" as const,
  readOnlyRoot: true as const,
  network: "none" as const,
  capabilities: [] as [],
  noNewPrivileges: true as const,
  cpuCount: 1 as const,
  memoryBytes: 536_870_912 as const,
  pidsLimit: 32 as const,
  scratchBytes: 268_435_456 as const,
  maxEnvironments: 1 as const,
  maxOperations: 64 as const,
  commandTimeoutSeconds: 30 as const,
  totalTimeoutSeconds: 120 as const,
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 20 * 1024 * 1024,
  maxReadFileBytes: 100 * 1024 * 1024,
});

export function inspectSandboxPolicySha256(): string {
  return createHash("sha256").update(JSON.stringify(INSPECT_SANDBOX_POLICY)).digest("hex");
}

export interface InspectSandboxExecutionRequest {
  readonly provider: typeof INSPECT_SANDBOX_PROVIDER;
  readonly imageDigest: string;
  readonly platform: typeof SUPPORTED_OCI_PLATFORM;
}

export const InspectOciHostBindingSchema = z.object({
  kind: z.literal("oci"),
  dockerPath: SafeAbsolutePathSchema,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  platform: z.literal(SUPPORTED_OCI_PLATFORM),
  projectDir: SafeAbsolutePathSchema,
  datasetCacheDir: SafeAbsolutePathSchema,
  user: z.string().regex(/^[0-9]+:[0-9]+$/),
  sandboxExecution: z.object({
    provider: z.literal(INSPECT_SANDBOX_PROVIDER),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    platform: z.literal(SUPPORTED_OCI_PLATFORM),
  }).strict().optional(),
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
  readonly sandboxExecution?: InspectSandboxExecutionRequest;
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
  readonly probeConfigDir?: string;
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
  if (input.operation === "probe" && input.probeConfigDir !== undefined) {
    args.push("--mount", bindMount(input.probeConfigDir, "/jinn/input", true));
  }
  args.push(binding.imageDigest, input.operation);
  if (input.operation === "run") args.push("/jinn/input/inspect-run.json");
  if (input.operation === "probe" && input.probeConfigDir !== undefined) args.push("/jinn/input/inspect-probe.json");
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
  environment?: NodeJS.ProcessEnv,
  exposeStderr = false,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      ...(environment === undefined ? {} : { env: environment }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const capture = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 1_000_000) child.kill("SIGKILL");
      else stdout.push(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) child.kill("SIGKILL");
      else if (exposeStderr) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      if (code !== 0) {
        const safeDetail = exposeStderr ? Buffer.concat(stderr).toString("utf8").trim() : "";
        reject(new Error(`OCI runtime command exited ${String(code ?? exitSignal)}${safeDetail === "" ? "" : `: ${safeDetail}`}`));
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

function inspectRuntimeAssetSha256(name: "broker.py" | "model_provider.py" | "sandbox-controller.mjs"): string {
  return createHash("sha256").update(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)))).digest("hex");
}

function inspectSandboxProviderSourceSha256(): string {
  return directoryTreeSha256(fileURLToPath(new URL("./sandbox_extension", import.meta.url)));
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
    ...(input.sandboxExecution === undefined ? {} : { sandboxExecution: input.sandboxExecution }),
  });
  const [serverResult, imageResult, sandboxImageResult] = await Promise.all([
    runBoundedProcess(binding.dockerPath, ["version", "--format", "{{json .Server}}"], undefined, signal),
    runBoundedProcess(binding.dockerPath, ["image", "inspect", "--format", "{{json .}}", binding.imageDigest], undefined, signal),
    binding.sandboxExecution === undefined
      ? Promise.resolve(undefined)
      : runBoundedProcess(binding.dockerPath, ["image", "inspect", "--format", "{{json .}}", binding.sandboxExecution.imageDigest], undefined, signal),
  ]);
  const server = DockerServerSchema.parse(JSON.parse(serverResult.stdout));
  const image = DockerImageSchema.parse(JSON.parse(imageResult.stdout));
  if (image.Id !== binding.imageDigest) throw new TypeError("OCI image ID does not match the selected digest");
  if (sandboxImageResult !== undefined) {
    const sandboxImage = DockerImageSchema.parse(JSON.parse(sandboxImageResult.stdout));
    if (sandboxImage.Id !== binding.sandboxExecution?.imageDigest) throw new TypeError("sandbox image ID does not match the selected digest");
  }

  const workerSourceSha256 = inspectWorkerSourceSha256();
  const brokerSourceSha256 = inspectRuntimeAssetSha256("broker.py");
  const modelProviderSourceSha256 = inspectRuntimeAssetSha256("model_provider.py");
  const sandboxProviderSourceSha256 = inspectSandboxProviderSourceSha256();
  const providerBacked = input.arms.some((arm) => arm.provider !== undefined);
  const probeName = `jinn-inspect-probe-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const probeConfigDir = mkdtempSync(join(tmpdir(), "jinn-inspect-probe-"));
  writeFileSync(join(probeConfigDir, "inspect-probe.json"), JSON.stringify({
    projectDir: "/jinn/project",
    taskReference: input.taskReference,
    taskArgs: input.taskArgs ?? {},
    scorerName: input.scorer.name,
    runOptions: input.runOptions,
    ...(binding.sandboxExecution === undefined ? {} : {
      sandboxExecution: {
        schema: "jinn.network/benchmark-product/inspect-sandbox/1",
        imageDigest: binding.sandboxExecution.imageDigest,
        platform: binding.sandboxExecution.platform,
        policySha256: inspectSandboxPolicySha256(),
      },
    }),
  }), { mode: 0o600 });
  const probeArgs = buildInspectOciRunArgs(binding, {
    name: probeName,
    operation: "probe",
    network: "none",
    probeConfigDir,
  });
  let workerResult: ProcessResult;
  try {
    workerResult = binding.sandboxExecution === undefined
      ? await runBoundedProcess(binding.dockerPath, probeArgs, undefined, signal)
      : await runBoundedProcess(process.execPath, [
        inspectOciRunnerPath(), "sandbox", binding.dockerPath, binding.sandboxExecution.imageDigest, ...probeArgs,
      ], undefined, signal, { LANG: "C.UTF-8" });
  } finally {
    rmSync(probeConfigDir, { recursive: true, force: true });
  }
  const envelope = WorkerEnvelopeSchema.parse(JSON.parse(workerResult.stdout));
  if (!envelope.ok) throw new Error("OCI Inspect worker probe failed");
  const runtime = envelope.value.runtime;
  if (runtime.inspectEvalsVersion !== SUPPORTED_INSPECT_EVALS_VERSION) throw new TypeError("Inspect Evals version drifted in the OCI image");
  if (runtime.openaiSdkVersion !== SUPPORTED_OPENAI_SDK_VERSION) throw new TypeError("OpenAI SDK version drifted in the OCI image");
  if (runtime.workerSha256 !== undefined && runtime.workerSha256 !== workerSourceSha256) throw new TypeError("OCI worker source differs from the product worker");
  if (runtime.brokerSha256 !== brokerSourceSha256 || runtime.modelProviderSha256 !== modelProviderSourceSha256) {
    throw new TypeError("OCI broker or model-provider source differs from the product runtime assets");
  }
  if (binding.sandboxExecution !== undefined && runtime.sandboxProviderSha256 !== sandboxProviderSourceSha256) {
    throw new TypeError("OCI sandbox provider source differs from the product runtime assets");
  }

  const manifest = InspectSelectionManifestSchema.parse({
    schema: binding.sandboxExecution === undefined ? INSPECT_SELECTION_SCHEMA : INSPECT_SANDBOX_SELECTION_SCHEMA,
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
        brokerSourceSha256,
        modelProviderSourceSha256,
        dockerExecutableSha256: createHash("sha256").update(readFileSync(binding.dockerPath)).digest("hex"),
        dockerEngineVersion: server.Version,
        dockerApiVersion: server.ApiVersion,
        datasetCacheSha256: directoryTreeSha256(binding.datasetCacheDir),
        isolation: {
          readOnlyRoot: true,
          network: providerBacked ? "broker-only" : "none",
          capabilities: [],
          noNewPrivileges: true,
          ...INSPECT_OCI_LIMITS,
          user: binding.user,
          mounts: providerBacked ? INSPECT_OCI_PROVIDER_MOUNTS : INSPECT_OCI_MOUNTS,
        },
        ...(providerBacked ? { broker: INSPECT_BROKER_POLICY } : {}),
        ...(binding.sandboxExecution === undefined ? {} : {
          sandbox: {
            protocol: INSPECT_SANDBOX_PROTOCOL,
            provider: INSPECT_SANDBOX_PROVIDER,
            packageVersion: INSPECT_SANDBOX_PACKAGE_VERSION,
            providerSourceSha256: sandboxProviderSourceSha256,
            controllerSourceSha256: inspectRuntimeAssetSha256("sandbox-controller.mjs"),
            imageDigest: binding.sandboxExecution.imageDigest,
            platform: binding.sandboxExecution.platform,
            policySha256: inspectSandboxPolicySha256(),
            policy: INSPECT_SANDBOX_POLICY,
          },
        }),
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
  const [serverResult, imageResult, sandboxImageResult] = await Promise.all([
    runBoundedProcess(binding.dockerPath, ["version", "--format", "{{json .Server}}"], undefined, signal),
    runBoundedProcess(binding.dockerPath, ["image", "inspect", "--format", "{{json .}}", binding.imageDigest], undefined, signal),
    binding.sandboxExecution === undefined
      ? Promise.resolve(undefined)
      : runBoundedProcess(binding.dockerPath, ["image", "inspect", "--format", "{{json .}}", binding.sandboxExecution.imageDigest], undefined, signal),
  ]);
  const server = DockerServerSchema.parse(JSON.parse(serverResult.stdout));
  const image = DockerImageSchema.parse(JSON.parse(imageResult.stdout));
  const sandboxImage = sandboxImageResult === undefined ? undefined : DockerImageSchema.parse(JSON.parse(sandboxImageResult.stdout));
  if (
    (binding.sandboxExecution === undefined) !== (execution.sandbox === undefined)
    ||
    image.Id !== execution.imageDigest
    || server.Version !== execution.dockerEngineVersion
    || server.ApiVersion !== execution.dockerApiVersion
    || inspectWorkerSourceSha256() !== execution.workerSourceSha256
    || inspectOciRunnerSha256() !== execution.runtimeHostSourceSha256
    || inspectRuntimeAssetSha256("broker.py") !== execution.brokerSourceSha256
    || inspectRuntimeAssetSha256("model_provider.py") !== execution.modelProviderSourceSha256
    || (execution.sandbox !== undefined && (
      binding.sandboxExecution === undefined
      || sandboxImage?.Id !== execution.sandbox.imageDigest
      || inspectSandboxProviderSourceSha256() !== execution.sandbox.providerSourceSha256
      || inspectRuntimeAssetSha256("sandbox-controller.mjs") !== execution.sandbox.controllerSourceSha256
      || inspectSandboxPolicySha256() !== execution.sandbox.policySha256
      || JSON.stringify(INSPECT_SANDBOX_POLICY) !== JSON.stringify(execution.sandbox.policy)
    ))
    || createHash("sha256").update(readFileSync(binding.dockerPath)).digest("hex") !== execution.dockerExecutableSha256
  ) {
    throw new TypeError("OCI image, Docker runtime, or worker source drifted after selection");
  }
}

/** Starts the sealed broker image, validates its health contract, then removes all transient OCI
 * resources. It performs no model request and receives only an opaque host descriptor path. */
export async function assertInspectOciBrokerReady(
  binding: InspectOciHostBinding,
  manifest: InspectSelectionManifest,
  hostConnectionDescriptor: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!manifest.arms.some((arm) => arm.provider !== undefined)) return;
  if (hostConnectionDescriptor === undefined) throw new TypeError("OpenAI connection is not configured");
  const name = `jinn-inspect-preflight-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await runBoundedProcess(
    process.execPath,
    [inspectOciRunnerPath(), "probe-broker", binding.dockerPath, binding.imageDigest, name],
    undefined,
    signal,
    { LANG: "C.UTF-8", JINN_INSPECT_HOST_CONNECTION_DESCRIPTOR: hostConnectionDescriptor },
    true,
  );
}
