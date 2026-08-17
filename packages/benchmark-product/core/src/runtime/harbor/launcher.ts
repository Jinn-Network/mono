/** Official Harbor CLI launcher. The local TEP backend owns Submission/Attempt/Delivery. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { LauncherCapabilities, LauncherContract, LaunchPlan } from "@jinn-network/task-execution-launchers";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { HARBOR_ADAPTER_ID, type HarborSelectionManifest } from "./manifest.js";
import type { HarborHostBinding } from "./host.js";

export const HARBOR_LAUNCHER_ID = "harbor";

export function harborJobName(submissionSha256: string, dispatch: number): string {
  if (!/^[a-f0-9]{64}$/.test(submissionSha256) || !Number.isInteger(dispatch) || dispatch < 1) throw new TypeError("Harbor Job naming requires a Submission digest and positive dispatch index");
  return `jinn-${submissionSha256.slice(0, 24)}-d${dispatch}`;
}

export function harborArmJobName(runSha256: string, armId: string): string {
  if (!/^[a-f0-9]{64}$/.test(runSha256)) throw new TypeError("Harbor per-arm Job naming requires a Run digest");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(armId)) throw new TypeError("Harbor per-arm Job naming requires a well-formed arm id");
  return `jinn-${runSha256.slice(0, 24)}-${armId}`;
}

function requirePinnedHarbor(view: TaskView, manifest: HarborSelectionManifest): void {
  const requirements = view.effectiveRequirements as Record<string, unknown>;
  const harness = requirements.harness as { id?: unknown; version?: unknown } | undefined;
  if (harness?.id !== HARBOR_LAUNCHER_ID || harness.version !== manifest.harbor.version) {
    throw new TypeError("Harbor Submission does not carry the exact selected Harbor harness/version pin");
  }
  const model = requirements.model as { id?: unknown } | undefined;
  const agent = requirements.agent as { id?: unknown } | undefined;
  const arm = manifest.arms.find((candidate) => candidate.agent.id === agent?.id && candidate.model.id === model?.id);
  if (arm === undefined) throw new TypeError("Harbor Submission does not carry an exact selected arm AgentConfig/model pin");
}

export function makeHarborLauncher(input: { readonly manifest: HarborSelectionManifest; readonly host: HarborHostBinding }): LauncherContract {
  const executable = input.host.executable;
  const executableDigest = createHash("sha256").update(readFileSync(executable)).digest("hex");
  if (executableDigest !== input.manifest.harbor.executableSha256) throw new TypeError("Harbor executable bytes drifted from the sealed selection manifest");
  return {
    id: HARBOR_LAUNCHER_ID,
    capabilities: (): LauncherCapabilities => ({
      taskProfiles: ["https://spec.jinn.network/task-profiles/prediction-forecast/1.0", "https://spec.jinn.network/task-profiles/repository-work/1.0"],
      inputMediaTypes: ["application/json", "text/plain"], outputMediaTypes: ["application/json"], structuredOutput: true,
      resume: false, interruptionBehaviorDefault: "nonrepeatable", secretForwards: [],
      runPinning: { keys: [
        { key: "harness", inventory: [HARBOR_LAUNCHER_ID], posture: "enforced" },
        { key: "agent", inventory: input.manifest.arms.map((arm) => arm.agent.id), posture: "enforced" },
        { key: "model", inventory: input.manifest.arms.map((arm) => arm.model.id), posture: "enforced" },
        { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
      ] },
    }),
    async probe() {
      const actual = createHash("sha256").update(readFileSync(executable)).digest("hex");
      if (actual !== input.manifest.harbor.executableSha256) return { ready: false, detail: "Harbor executable bytes drifted from selection" };
      let version: string;
      try { version = execFileSync(executable, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1" } }).trim().replace(/^harbor\s+/iu, ""); }
      catch { return { ready: false, detail: "Harbor version probe failed" }; }
      return version === input.manifest.harbor.version
        ? { ready: true }
        : { ready: false, detail: `Harbor version drifted: expected ${input.manifest.harbor.version}, got ${version}` };
    },
    plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan {
      requirePinnedHarbor(view, input.manifest);
      return {
        // The product deliberately invokes the official CLI only; no synthetic JSON stdout protocol exists.
        argv: [executable, "run", "-c", join(paths.input, "harbor-job.json")], cwd: paths.work,
        // The backend spawns with exactly this environment. Keep the surface closed while
        // retaining PATH so an already byte-pinned executable with an `/usr/bin/env` shebang can
        // resolve its interpreter and installed dependencies. No credentials or arbitrary
        // ambient variables cross the boundary.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HARBOR_TELEMETRY: "0", DO_NOT_TRACK: "1", TMPDIR: paths.tmp }, validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGTERM" }, blame: "infrastructure", reasonCode: "cancelled" }],
        resultContract: { envelopeFormat: "harbor-job-directory-v1", correlationFields: ["harnessVersion"] }, interruptionBehavior: "nonrepeatable",
      };
    },
  };
}
