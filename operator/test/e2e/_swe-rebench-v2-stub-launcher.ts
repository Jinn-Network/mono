// operator/test/e2e/_swe-rebench-v2-stub-launcher.ts
/**
 * Test-only deterministic launcher for `swe-rebench-v2.v1` legacy-bridged tasks.
 *
 * Post-Wave-4 D1 the composition `WorkLoop` is the only claim path, and it executes work
 * through `LauncherContract`s rather than the legacy `HarnessRegistry` that
 * `buildHarnesses` populates — so the env-gated `StubHarness` the swe-rebench-v2 e2e used
 * to solve with is unreachable from a composition-backed daemon. This is that stub's
 * launcher-shaped equivalent: same premise (return a canned patch keyed by the instance id,
 * never call an LLM, never touch Docker), expressed against the contract the composition
 * actually dispatches through.
 *
 * It deliberately does NOT join `ALL_LAUNCHERS` in `operator/src/daemon/composition-root.ts`.
 * A test stub in the shipped launcher registry — or an env-gated branch inside it — would be
 * production surface that exists only for a test; instead `buildOperatorComposition` takes an
 * explicit `extraLaunchers` host seam and this file stays in the e2e tree.
 *
 * Shape follows `operator/src/daemon/legacy-prediction-v1-launcher.ts`, the in-repo precedent
 * for a deterministic legacy-bridge launcher: `process.execPath -e <runner>` reading the
 * legacy `SignedTaskV1` the bridge writes into the attempt input directory
 * (`synthesizeLegacyExecutionDocuments`, `bridge-legacy-delivery.ts`).
 *
 * Output naming is load-bearing. `buildLegacyExecutionEnvelope` takes the delivered envelope's
 * `payload` from `harvest.manifest[0]` (`readPrimaryOutputPayload`), and harvest sorts the
 * manifest by path code units (`packages/task-execution/backend-local/workspace/src/harvest.ts`).
 * `solution-swe-rebench-v2.json` sorts before `structured-output.json` (`o` < `t`), so the
 * solution payload — not the structured-output envelope — is what reaches the envelope. The
 * same ordering constraint is what makes `prediction-v1-solution.json` work for the legacy
 * prediction launcher.
 */
import type { LauncherContract } from '@jinn-network/task-execution-launchers';

/** Env var carrying the fixtures directory the stub reads `<instance_id>.patch` from. */
export const STUB_FIXTURES_DIR_ENV = 'JINN_SWE_REBENCH_V2_STUB_FIXTURES_DIR' as const;

export const SWE_REBENCH_V2_STUB_LAUNCHER_ID = 'swe-rebench-v2-stub' as const;

/**
 * @param fixturesDir Directory holding one `<instance_id>.patch` file per instance the rig
 *   posts. Read at solve time, so a caller may rewrite the file between two postings of the
 *   same instance to serve a different patch (the gold/garbage pair this e2e needs).
 */
export function makeSweRebenchV2StubLauncher(fixturesDir: string): LauncherContract {
  return {
    id: SWE_REBENCH_V2_STUB_LAUNCHER_ID,
    capabilities: () => ({
      taskProfiles: ['https://spec.jinn.network/task-profiles/repository-work/1.0'],
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
const fixturesDir = process.env.${STUB_FIXTURES_DIR_ENV};
let task;
try { task = JSON.parse(fs.readFileSync(inputPath, 'utf8')); }
catch { console.error('swe-rebench-v2-stub: missing or malformed SignedTaskV1 input'); process.exit(2); }
const instanceId = task && task.spec && task.spec.instance_id;
if (typeof instanceId !== 'string' || instanceId.length === 0) {
  console.error('swe-rebench-v2-stub: task carries no spec.instance_id'); process.exit(2);
}
let patch;
try { patch = fs.readFileSync(path.join(fixturesDir, instanceId + '.patch'), 'utf8'); }
catch { console.error('swe-rebench-v2-stub: no fixture patch for instance ' + instanceId); process.exit(2); }
if (patch.length === 0) {
  console.error('swe-rebench-v2-stub: empty fixture patch for instance ' + instanceId); process.exit(2);
}
const payload = { schemaVersion: 'swe-rebench-v2-solution.v1', patch };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'solution-swe-rebench-v2.json'), JSON.stringify(payload));
fs.writeFileSync(path.join(out, 'structured-output.json'), JSON.stringify({
  subtype: 'success', status: 'success', structuredOutput: payload,
  harnessVersion: '1.0.0', sessionId: process.env.JINN_ATTEMPT_ID || 'swe-rebench-v2-stub',
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
          [STUB_FIXTURES_DIR_ENV]: fixturesDir,
          TMPDIR: paths.tmp,
        },
        validExitCodes: [0],
        blameExitCodes: [
          { match: { exitCode: 2 }, blame: 'task', reasonCode: 'invalid-swe-rebench-v2-stub-input' },
          { match: { signal: 'SIGKILL' }, blame: 'infrastructure', reasonCode: 'killed' },
        ],
        resultContract: {
          envelopeFormat: 'swe-rebench-v2-stub-json',
          structuredOutputArtifact: 'out/structured-output.json',
          correlationFields: ['harnessVersion', 'sessionId'],
        },
        interruptionBehavior: 'repeatable',
        secretForwards: [],
      };
    },
  };
}
