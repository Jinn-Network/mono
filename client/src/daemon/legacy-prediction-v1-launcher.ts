import type { LauncherContract } from '@jinn-network/task-execution-launchers';

/**
 * Legacy-only deterministic launcher for the SignedTaskV1 compatibility bridge.
 *
 * The native prediction launcher deliberately accepts only the sealed prediction-forecast
 * profile. The legacy projector, however, correctly synthesizes a repository-work Task whose
 * exact input is `legacy-signed-task-v1.json`. Keeping this adapter separate preserves that
 * native boundary while allowing the explicitly selected legacy pipeline to close without an
 * ambient model credential or network call.
 */
export const legacyPredictionV1BaselineLauncher: LauncherContract = {
  id: 'legacy-prediction-v1-baseline',
  capabilities: () => ({
    taskProfiles: ['https://jinn.network/task-profiles/repository-work/1.0'],
    inputMediaTypes: ['application/json'],
    outputMediaTypes: ['application/json'],
    structuredOutput: true,
    resume: false,
    interruptionBehaviorDefault: 'repeatable',
    secretForwards: [],
    runPinning: { keys: [] },
  }),
  probe: async () => ({ ready: true }),
  plan(_view, paths, attempt) {
    const runner = `
const fs = require('node:fs');
const path = require('node:path');
const inputPath = path.join(process.env.JINN_ATTEMPT_INPUT, 'legacy-signed-task-v1.json');
const out = process.env.JINN_ATTEMPT_OUT;
const DECIMAL = /^(0(\\.\\d+)?|1(\\.0+)?)$/;
let task;
try { task = JSON.parse(fs.readFileSync(inputPath, 'utf8')); }
catch { console.error('legacy-prediction-v1-baseline: missing or malformed SignedTaskV1 input'); process.exit(2); }
const snapshot = task && task.spec && task.spec.consensusSnapshot;
const source = task && task.spec && task.spec.source;
const probabilityYes = snapshot && snapshot.probabilityYes;
if (typeof probabilityYes !== 'string' || !DECIMAL.test(probabilityYes)) {
  console.error('legacy-prediction-v1-baseline: invalid consensus probability'); process.exit(2);
}
const submittedAt = typeof snapshot.sampledAt === 'string'
  ? snapshot.sampledAt
  : (typeof task.createdAt === 'number' ? new Date(task.createdAt).toISOString() : null);
if (submittedAt === null || Number.isNaN(Date.parse(submittedAt))) {
  console.error('legacy-prediction-v1-baseline: invalid deterministic submission time'); process.exit(2);
}
const payload = {
  probabilityYes,
  submittedAt,
  format: 'decimal',
  modelId: 'prediction-v1-baseline/consensus',
  confidence: 'medium',
  methodology: 'Used the Task posted-time Polymarket consensus snapshot.',
  sourceRefs: typeof source?.url === 'string' ? [{ title: 'Polymarket market', url: source.url }] : [],
};
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'prediction-v1-solution.json'), JSON.stringify(payload));
fs.writeFileSync(path.join(out, 'structured-output.json'), JSON.stringify({
  subtype: 'success', status: 'success', structuredOutput: payload,
  harnessVersion: '1.0.0', sessionId: process.env.JINN_ATTEMPT_ID || 'legacy-baseline',
}));
process.exit(0);
`;
    return {
      argv: [process.execPath, '-e', runner],
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
      blameExitCodes: [
        { match: { exitCode: 2 }, blame: 'task', reasonCode: 'invalid-legacy-prediction-input' },
        { match: { signal: 'SIGKILL' }, blame: 'infrastructure', reasonCode: 'killed' },
      ],
      resultContract: {
        envelopeFormat: 'legacy-prediction-v1-baseline-json',
        structuredOutputArtifact: 'out/structured-output.json',
        correlationFields: ['harnessVersion', 'sessionId'],
      },
      interruptionBehavior: 'repeatable',
      secretForwards: [],
    };
  },
};
