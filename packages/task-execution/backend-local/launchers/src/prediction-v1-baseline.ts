import type { LauncherContract } from "./contract.js";
import {
  baseEnv, capabilities, isolation, requireHarness, type LauncherOptions,
} from "./planning.js";

/**
 * Zero-credential reference forecaster for prediction.v1. Spawns `node -e` that reads the
 * sealed Task JSON from the attempt input dir, copies `consensusSnapshot.probabilityYes` into
 * a solution artifact, and exits 0. Mirrors the in-process `PredictionV1BaselineImpl` harness
 * used by the legacy TaskEngine path so the stage-1 work loop can close without an LLM key.
 */
export function makePredictionV1BaselineLauncher(options: LauncherOptions = {}): LauncherContract {
  return {
    id: "prediction-v1-baseline",
    capabilities: () => capabilities([
      { key: "harness", inventory: ["prediction-v1-baseline"] },
      { key: "isolationPolicy", inventory: ["unrestricted"] },
    ], false),
    probe: options.probe ?? (async () => ({ ready: true })),
    plan(view, paths, attempt) {
      requireHarness(view, "prediction-v1-baseline");
      isolation(view);
      // Inline runner: find the task document under the input dir (TEP sealed Task or legacy
      // SignedTaskV1), extract consensusSnapshot.probabilityYes, write solution + envelope.
      const runner = `
const fs = require('node:fs');
const path = require('node:path');
const input = process.env.JINN_ATTEMPT_INPUT;
const out = process.env.JINN_ATTEMPT_OUT;
function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = walk(p); if (r) return r; }
    else if (e.name.endsWith('.json')) {
      try {
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        const snap = doc.spec && doc.spec.consensusSnapshot
          || doc.task && doc.task.spec && doc.task.spec.consensusSnapshot
          || doc.payload && doc.payload.spec && doc.payload.spec.consensusSnapshot;
        if (snap && typeof snap.probabilityYes === 'number') return { doc, snap, source: doc.spec && doc.spec.source || {} };
      } catch {}
    }
  }
  return null;
}
const found = walk(input);
if (!found) { console.error('prediction-v1-baseline: no consensusSnapshot in input'); process.exit(2); }
const probabilityYes = found.snap.probabilityYes;
const submittedAt = new Date().toISOString();
const modelId = 'prediction-v1-baseline/consensus';
const payload = {
  probabilityYes, submittedAt, format: 'decimal', modelId, confidence: 'medium',
  methodology: 'Used the Task posted-time Polymarket consensus snapshot.',
  sourceRefs: found.source.url ? [{ title: 'Polymarket market', url: found.source.url }] : [],
};
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'prediction-v1-solution.json'), JSON.stringify(payload, null, 2));
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
