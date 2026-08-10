/**
 * The product-bundled sample launcher (M1 dossier
 * `docs/superpowers/plans/2026-08-05-benchmark-product-m1-composition-dossier.md` §3 decision 1):
 * a REAL coin-flip baseline for the quickstart, honestly labeled as such. It spawns a genuine
 * `node -e` subprocess — same shape as the platform's own `prediction-v1-baseline` launcher
 * (`packages/task-execution/backend-local/launchers/src/prediction-v1-baseline.ts`) — and always
 * predicts `probabilityYes: "0.5"`. It is not a mock and not a serious forecasting strategy;
 * paired against the platform's baseline (which echoes the posted consensus), the two arms'
 * Brier-score comparison has a true winner.
 *
 * This is product content, not platform code: it lives in the benchmark-product tree because the
 * platform's `@jinn-network/task-execution-launchers` package intentionally exposes no non-public
 * planning helpers (`requireHarness`/`isolation`/`baseEnv`) to import, so the guard logic below is
 * a small, self-contained reimplementation rather than a reuse of platform internals.
 */

import type {
  LauncherCapabilities,
  LauncherContract,
  LaunchPlan,
  ProbeResult,
} from "@jinn-network/task-execution-launchers";
import { PREDICTION_FORECAST_PROFILE_URI } from "@jinn-network/task-execution-profiles";
import {
  STAGED_SEALED_TASK_FILENAME,
  type TaskView,
  type WorkspacePaths,
} from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";

export const SAMPLE_UNIFORM_LAUNCHER_ID = "sample-uniform";
export const SAMPLE_UNIFORM_HARNESS_VERSION = "0.1.0";

/**
 * The inline runner, spawned via `node -e`. Unlike the platform's `prediction-v1-baseline`
 * launcher — which defensively walks its input directory and validates the full native Task
 * shape — this runner reads the ONE shared fixed path the product's provisioner contract writes
 * (`input/${STAGED_SEALED_TASK_FILENAME}`, venue/provisioner.ts) and performs only the minimal sanity check it
 * needs: the prediction-forecast profile URI and a string `payload.forecast.observedAt`.
 * Full Task validity is the platform's job (sealed digests, admission receipts); duplicating
 * its acceptance predicate here would be copied platform code (spec §3/§11 refusal).
 */
export const SAMPLE_UNIFORM_RUNNER_SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const input = process.env.JINN_ATTEMPT_INPUT;
const out = process.env.JINN_ATTEMPT_OUT;
const PROFILE_URI = '${PREDICTION_FORECAST_PROFILE_URI}';
const TASK_FILE = ${JSON.stringify(STAGED_SEALED_TASK_FILENAME)};
let doc;
try {
  doc = JSON.parse(fs.readFileSync(path.join(input, TASK_FILE), 'utf8'));
} catch (error) {
  console.error('sample-uniform: could not read input/' + TASK_FILE + ': ' + (error && error.message ? error.message : String(error)));
  process.exit(2);
}
const forecast = doc && doc.payload && doc.payload.forecast;
const observedAt = forecast && typeof forecast.observedAt === 'string' && forecast.observedAt.length > 0 ? forecast.observedAt : undefined;
if (!doc || !doc.profile || doc.profile.uri !== PROFILE_URI || observedAt === undefined) {
  console.error('sample-uniform: input/' + TASK_FILE + ' is not a prediction-forecast Task with payload.forecast.observedAt');
  process.exit(2);
}
const payload = { probabilityYes: '0.5', submittedAt: observedAt };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'prediction.json'), JSON.stringify(payload));
fs.writeFileSync(path.join(out, 'structured-output.json'), JSON.stringify({
  subtype: 'success', status: 'success', structuredOutput: payload,
  harnessVersion: '${SAMPLE_UNIFORM_HARNESS_VERSION}', sessionId: process.env.JINN_ATTEMPT_ID || 'sample-uniform',
}));
process.exit(0);
`;

function requireHarness(view: TaskView): void {
  const value = (view.effectiveRequirements as Record<string, unknown>)["harness"];
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || (value as { id?: unknown }).id !== SAMPLE_UNIFORM_LAUNCHER_ID) {
    throw new Error(`${SAMPLE_UNIFORM_LAUNCHER_ID}: harness pin does not select this launcher`);
  }
}

function requireIsolation(view: TaskView): void {
  const value = (view.effectiveRequirements as Record<string, unknown>)["isolationPolicy"];
  if (value === undefined) return;
  if (value !== "unrestricted") throw new Error(`unsupported isolationPolicy ${String(value)}`);
}

export function makeSampleUniformLauncher(options: { readonly probe?: () => Promise<ProbeResult> } = {}): LauncherContract {
  return {
    id: SAMPLE_UNIFORM_LAUNCHER_ID,
    capabilities: (): LauncherCapabilities => ({
      taskProfiles: [PREDICTION_FORECAST_PROFILE_URI],
      inputMediaTypes: ["application/json", "text/plain"],
      outputMediaTypes: ["application/json", "text/plain"],
      structuredOutput: true,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: [],
      runPinning: {
        keys: [
          { key: "harness", inventory: [SAMPLE_UNIFORM_LAUNCHER_ID], posture: "enforced" },
          { key: "isolationPolicy", inventory: ["unrestricted"], posture: "enforced" },
        ],
      },
    }),
    probe: options.probe ?? (async () => ({ ready: true })),
    plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan {
      requireHarness(view);
      requireIsolation(view);
      return {
        argv: [process.execPath, "-e", SAMPLE_UNIFORM_RUNNER_SOURCE],
        cwd: paths.work,
        env: {
          JINN_ATTEMPT_ID: attempt.attemptUri,
          JINN_ATTEMPT_INPUT: paths.input,
          JINN_ATTEMPT_OUT: paths.out,
          JINN_ATTEMPT_LOGS: paths.logs,
          JINN_ATTEMPT_META: paths.meta,
          TMPDIR: paths.tmp,
        },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: {
          envelopeFormat: "sample-uniform-json",
          structuredOutputArtifact: "out/structured-output.json",
          correlationFields: ["harnessVersion", "sessionId"],
        },
        interruptionBehavior: "repeatable",
        secretForwards: [],
      };
    },
  };
}

export const sampleUniformLauncher: LauncherContract = makeSampleUniformLauncher();
