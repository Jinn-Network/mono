import type { LauncherContract } from "./contract.js";
import {
  baseEnv, capabilities, isolation, requireHarness, type LauncherOptions,
} from "./planning.js";

/**
 * Zero-credential reference forecaster for prediction.v1. Spawns `node -e` that reads the
 * sealed native forecast Task JSON from the attempt input dir and emits the profile's one
 * deterministic `prediction` output. No legacy task syntax, ambient clock, or extra fields
 * are admitted on this native launcher path.
 */
export function makePredictionV1BaselineLauncher(options: LauncherOptions = {}): LauncherContract {
  return {
    id: "prediction-v1-baseline",
    capabilities: () => capabilities([
      { key: "harness", inventory: ["prediction-v1-baseline"] },
      { key: "isolationPolicy", inventory: ["unrestricted"] },
    ], false, [], ["https://jinn.network/task-profiles/prediction-forecast/1.0"]),
    probe: options.probe ?? (async () => ({ ready: true })),
    plan(view, paths, attempt) {
      requireHarness(view, "prediction-v1-baseline");
      isolation(view);
      // Inline runner: locate the one sealed native Task and use the sealed observedAt value as
      // the deterministic submission time. The structured envelope remains backend metadata;
      // the sole Task output is out/prediction.json.
      const runner = `
const fs = require('node:fs');
const path = require('node:path');
const input = process.env.JINN_ATTEMPT_INPUT;
const out = process.env.JINN_ATTEMPT_OUT;
const PROFILE_URI = 'https://jinn.network/task-profiles/prediction-forecast/1.0';
const PROFILE_DIGEST = 'e61dc765d1a93b71639cb566d6bd3ca1335cfd53cb415e904ff840670d212937';
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
  if (!isObject(doc) || keys(doc) !== 'evaluation,instructions,outputs,payload,profile,protocol' || doc.protocol !== 'https://jinn.network/profiles/task-execution/1.0' || typeof doc.instructions !== 'string' || doc.instructions.length === 0) return false;
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
function walk(dir, matches) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, matches);
    else if (e.name.endsWith('.json')) {
      try {
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (isNativeTask(doc)) matches.push(doc);
      } catch {}
    }
  }
}
const tasks = [];
walk(input, tasks);
if (tasks.length !== 1) { console.error('prediction-v1-baseline: expected exactly one native prediction-forecast Task'); process.exit(2); }
const payload = { probabilityYes: tasks[0].payload.forecast.consensusProbabilityYes, submittedAt: tasks[0].payload.forecast.observedAt };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'prediction.json'), JSON.stringify(payload));
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
