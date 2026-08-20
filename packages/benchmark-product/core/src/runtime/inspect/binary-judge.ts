import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCellKey } from "@jinn-network/benchmarking-records";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type {
  LauncherCapabilities,
  LauncherContract,
  LaunchPlan,
} from "@jinn-network/task-execution-launchers";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import {
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  BinaryJudgmentInstrumentSchema,
  BinaryJudgmentPayloadSchema,
  buildBinaryJudgmentSemanticRequest,
  binaryJudgmentSemanticRequestDigest,
  parseBinaryJudgmentInstrument,
} from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { TaskSpecificationSchema, compareCodeUnitStrings } from "@jinn-network/task-execution-protocol";
import { runtimeHostPath } from "../../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import type {
  InspectBinaryJudgeArm,
  InspectBinaryJudgeHostBinding,
  InspectBinaryJudgeSelectionManifest,
} from "./binary-judge-manifest.js";
import {
  InspectBinaryJudgeHostBindingSchema,
  InspectBinaryJudgeSelectionManifestSchema,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
} from "./binary-judge-manifest.js";
import { inspectOciRunnerPath, inspectOciRunnerSha256 } from "./oci.js";

export const INSPECT_BINARY_JUDGE_CONFIG_FILENAME = "inspect-run.json" as const;
export const INSPECT_BINARY_JUDGE_INSTRUMENT_FILENAME = "judge-instrument.json" as const;
export const INSPECT_BINARY_JUDGE_SELECTION_FILENAME = "judge-selection.json" as const;
export const INSPECT_BINARY_JUDGE_OCI_CONFIG_PATH = "/jinn/input/inspect-run.json" as const;
export const INSPECT_BINARY_JUDGE_OCI_OUTPUT_DIR = "/jinn/output" as const;
export const INSPECT_BINARY_JUDGE_OUTPUT_FILES = Object.freeze({
  response: "judge-response",
  observation: "judge-observation",
  inspectLog: "inspect-log",
});

export function inspectBinaryJudgeWorkerPath(): string {
  return fileURLToPath(new URL("./binary_judge_worker.py", import.meta.url));
}

export function inspectBinaryJudgeWorkerSha256(): string {
  return createHash("sha256").update(readFileSync(inspectBinaryJudgeWorkerPath())).digest("hex");
}

function inspectBinaryJudgeRuntimeAssetSha256(name: "broker.py" | "model_provider.py"): string {
  return sha256Hex(new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url))));
}

export function readInspectBinaryJudgeSelectionManifest(
  workspaceDir: string,
  selectionManifestSha256: string,
): InspectBinaryJudgeSelectionManifest {
  if (!/^[0-9a-f]{64}$/u.test(selectionManifestSha256)) {
    throw new TypeError("Inspect binary-judge selection digest must be lowercase sha256 hex");
  }
  const bytes = getSealedBytes(workspaceDir, selectionManifestSha256);
  const manifest = InspectBinaryJudgeSelectionManifestSchema.parse(JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ));
  if (
    sha256Hex(bytes) !== selectionManifestSha256
    || !Buffer.from(bytes).equals(Buffer.from(canonicalJsonBytes(manifest)))
  ) {
    throw new TypeError("Inspect binary-judge selection bytes are not the exact canonical manifest");
  }
  return manifest;
}

export function readInspectBinaryJudgeHostBinding(
  workspaceDir: string,
  selectionManifestSha256: string,
): InspectBinaryJudgeHostBinding {
  return InspectBinaryJudgeHostBindingSchema.parse(JSON.parse(readFileSync(
    runtimeHostPath(workspaceDir, selectionManifestSha256),
    "utf8",
  )));
}

export function assertInspectBinaryJudgeSelectionUndrifted(
  workspaceDir: string,
  selectionManifestSha256: string,
): void {
  const manifest = readInspectBinaryJudgeSelectionManifest(workspaceDir, selectionManifestSha256);
  const host = readInspectBinaryJudgeHostBinding(workspaceDir, selectionManifestSha256);
  if (host.imageDigest !== manifest.runtime.imageDigest || host.platform !== manifest.runtime.platform) {
    throw new TypeError("Inspect binary-judge private host differs from the sealed runtime");
  }
  if (
    manifest.runtime.runtimeHostSourceSha256 !== inspectOciRunnerSha256()
    || manifest.runtime.workerSourceSha256 !== inspectBinaryJudgeWorkerSha256()
    || manifest.runtime.brokerSourceSha256 !== inspectBinaryJudgeRuntimeAssetSha256("broker.py")
    || manifest.runtime.modelProviderSourceSha256 !== inspectBinaryJudgeRuntimeAssetSha256("model_provider.py")
  ) {
    throw new TypeError("Inspect binary-judge runtime source drifted from the sealed selection");
  }
}

export interface InspectBinaryJudgeWorkerInput {
  readonly manifest: InspectBinaryJudgeSelectionManifest;
  readonly selectionManifestSha256: string;
  readonly arm: InspectBinaryJudgeArm & { readonly provider: { readonly surface: "openai-responses" } };
  readonly cellKey: string;
  readonly taskDigest: `sha256:${string}`;
  readonly armId: string;
  readonly replicate: number;
  readonly instrumentSha256: `sha256:${string}`;
  readonly semanticRequest: ReturnType<typeof buildBinaryJudgmentSemanticRequest>;
  readonly requestSha256: `sha256:${string}`;
  readonly outputDir: string;
}

function selectedArm(
  view: TaskView,
  manifest: InspectBinaryJudgeSelectionManifest,
): InspectBinaryJudgeArm {
  const requirements = view.effectiveRequirements as Record<string, unknown>;
  const harness = requirements.harness as { id?: unknown; version?: unknown } | undefined;
  if (
    harness?.id !== INSPECT_BINARY_JUDGE_LAUNCHER_ID
    || harness.version !== INSPECT_BINARY_JUDGE_LAUNCHER_VERSION
  ) {
    throw new TypeError("binary-judgment cell does not carry the selected Inspect judge harness/version pin");
  }
  // Resolve the arm from the instrument digest FIRST: the model check below compares against
  // the resolved arm's own model, not a fleet-wide literal, so it needs the arm in hand before it
  // can run (spec §1.6 / P1 change 3a).
  const instrument = requirements[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY];
  if (typeof instrument !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(instrument)) {
    throw new TypeError("binary-judgment cell carries no exact scalar instrument digest");
  }
  const arm = manifest.arms.find((candidate) => candidate.instrumentSha256 === instrument);
  if (arm === undefined) {
    throw new TypeError("binary-judgment instrument digest is absent from the sealed judge selection");
  }
  const model = requirements.model as { id?: unknown } | undefined;
  if (model?.id !== arm.model) {
    throw new TypeError("binary-judgment cell must request the exact selected arm's model");
  }
  return arm;
}

function assertBinaryTaskShape(view: TaskView): void {
  if (
    view.task.profile.uri !== BINARY_JUDGMENT_PROFILE_URI
    || view.task.profile.digest?.sha256 !== BINARY_JUDGMENT_PROFILE_DIGEST.slice("sha256:".length)
  ) {
    throw new TypeError("Inspect judge launcher accepts only the sealed binary-judgment v1 profile");
  }
  const expected = [
    ["judge-response", BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, true],
    ["judge-observation", BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE, true],
    ["inspect-log", BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE, false],
  ] as const;
  const actual = view.task.outputs.map((output) => [output.name, output.mediaType, output.required] as const);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError("binary-judgment Task outputs drifted from the closed profile contract");
  }
  BinaryJudgmentPayloadSchema.parse(view.task.payload);
}

export function validateInspectBinaryJudgePinning(
  view: TaskView,
  manifest: InspectBinaryJudgeSelectionManifest,
): InspectBinaryJudgeArm {
  manifest = InspectBinaryJudgeSelectionManifestSchema.parse(manifest);
  assertBinaryTaskShape(view);
  return selectedArm(view, manifest);
}

export function buildInspectBinaryJudgeWorkerInput(input: {
  readonly view: TaskView;
  readonly sealedTaskBytes: Uint8Array;
  readonly manifest: InspectBinaryJudgeSelectionManifest;
  readonly selectionManifestSha256: string;
  readonly instrumentBytes: Uint8Array;
  readonly cellKey: string;
  readonly armId: string;
  readonly replicate: number;
  readonly outputDir: string;
}): InspectBinaryJudgeWorkerInput {
  const manifest = InspectBinaryJudgeSelectionManifestSchema.parse(input.manifest);
  const expectedSelectionSha256 = recordDigest(canonicalJsonBytes(manifest));
  if (input.selectionManifestSha256 !== expectedSelectionSha256.slice("sha256:".length)) {
    throw new TypeError("selection manifest digest differs from the exact staged manifest");
  }
  const arm = validateInspectBinaryJudgePinning(input.view, manifest);
  if (arm.armId !== input.armId) throw new TypeError("Run coordinate arm differs from the instrument-selected arm");
  if (!Number.isInteger(input.replicate) || input.replicate < 1) {
    throw new TypeError("binary-judgment replicate must be a positive integer");
  }
  if (input.outputDir !== INSPECT_BINARY_JUDGE_OCI_OUTPUT_DIR) {
    throw new TypeError("binary-judgment OCI worker outputDir must be the exact staged output mount");
  }
  const parsedTask = TaskSpecificationSchema.parse(JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(input.sealedTaskBytes),
  ));
  if (
    !Buffer.from(canonicalJsonBytes(parsedTask)).equals(Buffer.from(input.sealedTaskBytes))
    || !Buffer.from(canonicalJsonBytes(parsedTask)).equals(Buffer.from(canonicalJsonBytes(input.view.task)))
  ) {
    throw new TypeError("staged binary-judgment Task bytes differ from the validated Task view");
  }
  const taskDigest = recordDigest(input.sealedTaskBytes);
  const coordinate = parseCellKey(input.cellKey);
  if (
    coordinate.taskDigest !== taskDigest.slice("sha256:".length)
    || coordinate.armId !== input.armId
    || coordinate.replicate !== input.replicate
  ) {
    throw new TypeError("binary-judgment cell key differs from the exact Task/arm/replicate coordinate");
  }
  const instrumentDigest = recordDigest(input.instrumentBytes);
  if (instrumentDigest !== arm.instrumentSha256) {
    throw new TypeError("staged judge instrument bytes differ from the effective arm requirement");
  }
  const instrument = parseBinaryJudgmentInstrument(input.instrumentBytes);
  BinaryJudgmentInstrumentSchema.parse(instrument);
  if (
    instrument.instrumentId !== arm.armId
    || instrument.model.requested !== arm.model
    || JSON.stringify(instrument.model.generation) !== JSON.stringify(arm.generation)
  ) {
    throw new TypeError("judge instrument model or generation block differs from the sealed arm");
  }
  const payload = BinaryJudgmentPayloadSchema.parse(input.view.task.payload);
  const semanticRequest = buildBinaryJudgmentSemanticRequest(payload, instrument);
  return {
    manifest,
    selectionManifestSha256: input.selectionManifestSha256,
    arm: { ...arm, provider: { surface: "openai-responses" } },
    cellKey: input.cellKey,
    taskDigest,
    armId: input.armId,
    replicate: input.replicate,
    instrumentSha256: instrumentDigest,
    semanticRequest,
    requestSha256: binaryJudgmentSemanticRequestDigest(payload, instrument),
    outputDir: input.outputDir,
  };
}

function bindMount(source: string, destination: string, readonly = false): string {
  if (!source.startsWith("/") || /[\n\r,]/u.test(source)) throw new TypeError("OCI bind source must be a safe absolute path");
  return `type=bind,src=${source},dst=${destination}${readonly ? ",readonly" : ""}`;
}

export function buildInspectBinaryJudgeOciRunArgs(
  host: InspectBinaryJudgeHostBinding,
  input: { readonly name: string; readonly inputDir: string; readonly outputDir: string },
): readonly string[] {
  host = InspectBinaryJudgeHostBindingSchema.parse(host);
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(input.name)) throw new TypeError("invalid OCI container name");
  return [
    "run", "--rm", "--interactive", "--pull=never", `--platform=${host.platform}`,
    `--name=${input.name}`, `--hostname=${input.name}`, `--user=${host.user}`,
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network=none",
    "--pids-limit=64", "--memory=1073741824", "--cpus=1", "--ulimit=nofile=1024:1024",
    "--ipc=none", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=536870912",
    "--tmpfs=/jinn/work:rw,noexec,nosuid,nodev,size=536870912", "--workdir=/jinn/work",
    "--env=PYTHONDONTWRITEBYTECODE=1", "--env=PYTHONNOUSERSITE=1", "--env=PYTHONUTF8=1",
    "--env=LANG=C.UTF-8", "--env=HOME=/tmp/home",
    "--mount", bindMount(input.inputDir, "/jinn/input", true),
    "--mount", bindMount(input.outputDir, "/jinn/output"),
    "--entrypoint=python", host.imageDigest, "/opt/jinn/binary_judge_worker.py", "run",
    INSPECT_BINARY_JUDGE_OCI_CONFIG_PATH,
  ];
}

export function makeInspectBinaryJudgeLauncher(options: {
  readonly host: InspectBinaryJudgeHostBinding;
  readonly manifest: InspectBinaryJudgeSelectionManifest;
  readonly hostConnectionDescriptor?: string;
}): LauncherContract {
  const host = InspectBinaryJudgeHostBindingSchema.parse(options.host);
  const manifest = InspectBinaryJudgeSelectionManifestSchema.parse(options.manifest);
  if (
    host.imageDigest !== manifest.runtime.imageDigest
    || host.platform !== manifest.runtime.platform
  ) {
    throw new TypeError("private Inspect judge host image or platform differs from the sealed runtime");
  }
  return {
    id: INSPECT_BINARY_JUDGE_LAUNCHER_ID,
    capabilities: (): LauncherCapabilities => ({
      taskProfiles: [BINARY_JUDGMENT_PROFILE_URI],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: [
        BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
        BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
        BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
      ],
      structuredOutput: true,
      resume: false,
      interruptionBehaviorDefault: "nonrepeatable",
      secretForwards: [],
      runPinning: {
        keys: [
          { key: "harness", inventory: [INSPECT_BINARY_JUDGE_LAUNCHER_ID], posture: "enforced" },
          {
            key: "model",
            // Deduplicated, code-unit-sorted arm models (spec §1.6 / P1 change 3b): a
            // dated-snapshot cell would be refused by an inventory that still advertised only
            // the reasoning model.
            inventory: [...new Set(manifest.arms.map((arm) => arm.model))].sort(compareCodeUnitStrings),
            posture: "enforced",
          },
          {
            key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
            inventory: manifest.arms.map((arm) => arm.instrumentSha256),
            posture: "enforced",
          },
          { key: "isolationPolicy", inventory: ["oci-container"], posture: "enforced" },
        ],
      },
    }),
    probe: async () => ({ ready: true }),
    plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan {
      validateInspectBinaryJudgePinning(view, manifest);
      if (inspectBinaryJudgeWorkerSha256() !== manifest.runtime.workerSourceSha256) {
        throw new TypeError("Inspect binary-judge worker source drifted from the sealed selection");
      }
      const suffix = createHash("sha256").update(attempt.attemptUri).digest("hex").slice(0, 24);
      return {
        argv: [
          process.execPath,
          inspectOciRunnerPath(),
          host.dockerPath,
          ...buildInspectBinaryJudgeOciRunArgs(host, {
            name: `jinn-inspect-judge-${suffix}`,
            inputDir: paths.input,
            outputDir: paths.out,
          }),
        ],
        cwd: paths.work,
        env: {
          LANG: "C.UTF-8",
          ...(options.hostConnectionDescriptor === undefined
            ? {}
            : { JINN_INSPECT_HOST_CONNECTION_DESCRIPTOR: options.hostConnectionDescriptor }),
        },
        validExitCodes: [0],
        resultContract: { envelopeFormat: "inspect-binary-judge-worker-v1" },
        interruptionBehavior: "nonrepeatable",
      };
    },
  };
}
