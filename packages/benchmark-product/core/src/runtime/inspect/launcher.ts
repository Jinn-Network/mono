import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { LauncherCapabilities, LauncherContract, LaunchPlan } from "@jinn-network/task-execution-launchers";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { INSPECT_TASK_PROFILE_URI, INSPECT_NATIVE_LOG_MEDIA_TYPE, INSPECT_SUMMARY_MEDIA_TYPE } from "./artifacts.js";
import { INSPECT_ARM_REQUIREMENT_KEY, type InspectSelectionManifest } from "./manifest.js";
import { inspectWorkerPath, type InspectHostBinding } from "./host.js";
import { buildInspectOciRunArgs, inspectOciRunnerPath } from "./oci.js";

export const INSPECT_LAUNCHER_ID = "inspect-ai";

export interface InspectLauncherOptions {
  readonly host: InspectHostBinding;
  readonly manifest: InspectSelectionManifest;
  readonly hostConnectionDescriptor?: string;
}

function requirePinning(view: TaskView, manifest: InspectSelectionManifest): void {
  const requirements = view.effectiveRequirements as Record<string, unknown>;
  const harness = requirements.harness as { id?: unknown; version?: unknown } | undefined;
  const armId = requirements[INSPECT_ARM_REQUIREMENT_KEY];
  const arm = manifest.arms.find((candidate) => candidate.armId === armId);
  if (
    harness?.id !== INSPECT_LAUNCHER_ID
    || harness.version !== manifest.runtime.inspectVersion
    || arm === undefined
  ) {
    throw new TypeError("Inspect cell does not carry the selected Inspect harness/version pin");
  }
  const model = requirements.model as { id?: unknown } | undefined;
  if (typeof model?.id !== "string" || arm.model !== model.id) {
    throw new TypeError("Inspect cell model pin is absent from the selected arm configuration");
  }
}

export function makeInspectLauncher(options: InspectLauncherOptions): LauncherContract {
  return {
    id: INSPECT_LAUNCHER_ID,
    capabilities: (): LauncherCapabilities => ({
      taskProfiles: [INSPECT_TASK_PROFILE_URI],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: [INSPECT_NATIVE_LOG_MEDIA_TYPE, INSPECT_SUMMARY_MEDIA_TYPE, "application/vnd.in-toto+json"],
      structuredOutput: true,
      resume: false,
      interruptionBehaviorDefault: "nonrepeatable",
      secretForwards: [],
      runPinning: {
        keys: [
          { key: "harness", inventory: [INSPECT_LAUNCHER_ID], posture: "enforced" },
          { key: "model", inventory: options.manifest.arms.map((arm) => arm.model), posture: "enforced" },
          { key: INSPECT_ARM_REQUIREMENT_KEY, inventory: options.manifest.arms.map((arm) => arm.armId), posture: "enforced" },
          { key: "isolationPolicy", inventory: [options.host.kind === "oci" ? "oci-container" : "unrestricted"], posture: "enforced" },
        ],
      },
    }),
    probe: async () => ({ ready: true }),
    plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan {
      requirePinning(view, options.manifest);
      if (options.host.kind === "oci") {
        const suffix = createHash("sha256").update(attempt.attemptUri).digest("hex").slice(0, 24);
        return {
          argv: [process.execPath, inspectOciRunnerPath(), options.host.dockerPath, ...buildInspectOciRunArgs(options.host, {
            name: `jinn-inspect-${suffix}`,
            operation: "run",
            inputDir: paths.input,
            outputDir: paths.out,
            network: "none",
          })],
          cwd: paths.work,
          env: {
            LANG: "C.UTF-8",
            ...(options.hostConnectionDescriptor === undefined
              ? {}
              : { JINN_INSPECT_HOST_CONNECTION_DESCRIPTOR: options.hostConnectionDescriptor }),
          },
          validExitCodes: [0],
          resultContract: { envelopeFormat: "inspect-worker-v1" },
          interruptionBehavior: "nonrepeatable",
        };
      }
      return {
        argv: [options.host.pythonPath, inspectWorkerPath(), "run", join(paths.input, "inspect-run.json")],
        cwd: paths.work,
        env: {
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
          PYTHONUTF8: "1",
          LANG: "C.UTF-8",
          TMPDIR: paths.tmp,
        },
        validExitCodes: [0],
        resultContract: { envelopeFormat: "inspect-worker-v1" },
        interruptionBehavior: "nonrepeatable",
      };
    },
  };
}
