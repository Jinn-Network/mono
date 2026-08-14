import {
  PREDICTION_FORECAST_PROFILE_DIGEST_HEX,
  PREDICTION_FORECAST_PROFILE_URI,
} from "@jinn-network/task-execution-profiles";
import { STAGED_SEALED_TASK_FILENAME } from "@jinn-network/task-execution-workspace";
import type { LauncherContract } from "./contract.js";
import {
  baseEnv, capabilities, isolation, requireHarness, type LauncherOptions,
} from "./planning.js";

/**
 * Zero-credential reference forecaster for prediction.v1. Spawns `node -e` that reads the
 * sealed native forecast Task JSON from the attempt input dir and emits the profile's one
 * deterministic `prediction` output. No legacy task syntax, ambient clock, or extra fields
 * are admitted on this native launcher path.
 *
 * #39: the declared output is written to `out/prediction` -- the LOGICAL name, which is what
 * `prediction-forecast/1.0`'s `outputConventions.slots[0].name` carries and therefore what the
 * requester's signed Task declares. The workspace harvest binds each declared output to the file
 * at `out/<name>`; writing `out/prediction.json` put a FILENAME into the sealed Delivery's
 * `outputs`, which the evaluator's `verifyEvaluationSubject` refused with "subject Delivery output
 * prediction.json is not declared by the Task" -- after four hours of the verdict window had
 * already gone. The structured envelope stays at `out/structured-output.json` because the
 * backend's `readResultEnvelope` requires a contained, harvested `out/` path; it is backend
 * metadata and is never declared as a Task output (see `deliveryOutputsFromHarvest`).
 *
 * #2538: the Task is read at the provisioner's contracted path
 * (`STAGED_SEALED_TASK_FILENAME`), not found by walking the input tree for `*.json`. The glob
 * never matched the staged `task.sealed`, so this launcher exited 2 on every real attempt while
 * its own test — which hand-wrote `task.json` — stayed green. Reading the contracted path also
 * removes the substitution surface the glob had: a materialized input that happens to parse as a
 * native Task can no longer stand in for the sealed one.
 */
export function makePredictionV1BaselineLauncher(options: LauncherOptions = {}): LauncherContract {
  return {
    id: "prediction-v1-baseline",
    capabilities: () => capabilities([
      { key: "harness", inventory: ["prediction-v1-baseline"] },
      { key: "isolationPolicy", inventory: ["unrestricted"] },
    ], false, [], [PREDICTION_FORECAST_PROFILE_URI]),
    probe: options.probe ?? (async () => ({ ready: true })),
    plan(view, paths, attempt) {
      requireHarness(view, "prediction-v1-baseline");
      isolation(view);
      // Inline runner: locate the one sealed native Task and use the sealed observedAt value as
      // the deterministic submission time. The structured envelope remains backend metadata;
      // the sole Task output is out/prediction, named for the Task's declaration.
      const runner = `
const fs = require('node:fs');
const path = require('node:path');
const input = process.env.JINN_ATTEMPT_INPUT;
const out = process.env.JINN_ATTEMPT_OUT;
const PROFILE_URI = '${PREDICTION_FORECAST_PROFILE_URI}';
const PROFILE_DIGEST = '${PREDICTION_FORECAST_PROFILE_DIGEST_HEX}';
const TASK_FILE = ${JSON.stringify(STAGED_SEALED_TASK_FILENAME)};
const PROBABILITY = /^(0(\\.\\d+)?|1(\\.0+)?)$/;
const UTC = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value) => Object.keys(value).sort().join(',');
function isPredictionOutput(output) {
  if (!isObject(output) || keys(output) !== 'mediaType,name,required,schema' || output.name !== 'prediction' || output.mediaType !== 'application/json' || output.required !== true) return false;
  const schema = output.schema;
  if (!isObject(schema) || keys(schema) !== 'additionalProperties,properties,required,type' || schema.type !== 'object' || schema.additionalProperties !== false || !Array.isArray(schema.required) || schema.required.join(',') !== 'probabilityYes,submittedAt') return false;
  const properties = schema.properties;
  return isObject(properties) && keys(properties) === 'probabilityYes,submittedAt'
    && isObject(properties.probabilityYes) && keys(properties.probabilityYes) === 'pattern,type' && properties.probabilityYes.type === 'string' && properties.probabilityYes.pattern === '^(0(\\\\.\\\\d+)?|1(\\\\.0+)?)$'
    && isObject(properties.submittedAt) && keys(properties.submittedAt) === 'format,type' && properties.submittedAt.type === 'string' && properties.submittedAt.format === 'date-time';
}
function isNativeTask(doc) {
  if (!isObject(doc) || doc.protocol !== 'https://spec.jinn.network/profiles/task-execution/v1' || typeof doc.instructions !== 'string' || doc.instructions.length === 0) return false;
  const required = ['evaluation','instructions','outputs','payload','profile','protocol'];
  const documentKeys = Object.keys(doc);
  if (!required.every((key) => documentKeys.includes(key))) return false;
  if (documentKeys.some((key) => !required.includes(key) && key !== 'author' && !/^[a-z][a-z0-9+.-]*:/i.test(key))) return false;
  if (doc.author !== undefined && (typeof doc.author !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(doc.author))) return false;
  if (!isObject(doc.profile) || keys(doc.profile) !== 'digest,uri' || doc.profile.uri !== PROFILE_URI || !isObject(doc.profile.digest) || keys(doc.profile.digest) !== 'sha256' || doc.profile.digest.sha256 !== PROFILE_DIGEST) return false;
  if (!isObject(doc.evaluation) || keys(doc.evaluation) !== 'digest,name' || doc.evaluation.name !== 'evaluation-spec.json' || !isObject(doc.evaluation.digest) || keys(doc.evaluation.digest) !== 'sha256' || !/^[0-9a-f]{64}$/.test(doc.evaluation.digest.sha256)) return false;
  if (!Array.isArray(doc.outputs) || doc.outputs.length !== 1 || !isPredictionOutput(doc.outputs[0])) return false;
  if (!isObject(doc.payload) || keys(doc.payload) !== 'forecast' || !isObject(doc.payload.forecast)) return false;
  const forecast = doc.payload.forecast;
  return keys(forecast) === 'consensusProbabilityYes,marketId,observedAt,question,resolvesAt'
    && typeof forecast.marketId === 'string' && forecast.marketId.length > 0 && typeof forecast.question === 'string' && forecast.question.length > 0
    && typeof forecast.consensusProbabilityYes === 'string' && PROBABILITY.test(forecast.consensusProbabilityYes)
    && typeof forecast.observedAt === 'string' && UTC.test(forecast.observedAt) && !Number.isNaN(Date.parse(forecast.observedAt))
    && typeof forecast.resolvesAt === 'string' && UTC.test(forecast.resolvesAt) && !Number.isNaN(Date.parse(forecast.resolvesAt)) && Date.parse(forecast.resolvesAt) > Date.parse(forecast.observedAt);
}
const taskPath = path.join(input, TASK_FILE);
let task;
try {
  task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
} catch (error) {
  console.error('prediction-v1-baseline: cannot read the staged native Task at input/' + TASK_FILE + ': ' + ((error && error.message) || String(error)));
  process.exit(2);
}
if (!isNativeTask(task)) {
  console.error('prediction-v1-baseline: input/' + TASK_FILE + ' is not a native prediction-forecast Task');
  process.exit(2);
}
const payload = { probabilityYes: task.payload.forecast.consensusProbabilityYes, submittedAt: task.payload.forecast.observedAt };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'prediction'), JSON.stringify(payload));
fs.writeFileSync(path.join(out, 'structured-output.json'), JSON.stringify({
  subtype: 'success', status: 'success', structuredOutput: payload,
  harnessVersion: '1.0.0', sessionId: process.env.JINN_ATTEMPT_ID || 'baseline',
}));
process.exit(0);
`;
      return {
        argv: [process.execPath, "-e", runner],
        cwd: paths.work,
        env: { ...baseEnv(paths, attempt) },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: {
          envelopeFormat: "prediction-v1-baseline-json",
          structuredOutputArtifact: "out/structured-output.json",
          correlationFields: ["harnessVersion", "sessionId"],
        },
        interruptionBehavior: "repeatable",
        secretForwards: [],
      };
    },
  };
}
export const predictionV1BaselineLauncher = makePredictionV1BaselineLauncher();
