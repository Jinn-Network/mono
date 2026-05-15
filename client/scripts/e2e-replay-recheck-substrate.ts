/**
 * E2E replay of the verdict-time substrate recheck against real upstream
 * substrate. Picks an admitted (scorable:true) instance from
 * validated-pool.json, constructs a SignedEnvelope whose "solution" is the
 * dataset's gold patch (guaranteed to pass by construction), and invokes
 * SweRebenchV2EvaluatorHarness.run() with real HF + real Docker. Asserts
 * that the new recheckSubstrate path succeeds and grading produces PASS.
 *
 * This is the live counterpart to harness.test.ts's stubbed substrate-recheck
 * tests. It exists to catch:
 *   - rowHash field-set drift between validate-pool and recheckSubstrate
 *   - imageDigest comparison failures against real registry digests
 *   - Real HF row shape mismatches (vs the hardcoded test fixture)
 *
 * Usage: yarn jinn ... no — this script is standalone. Run with tsx:
 *   yarn tsx scripts/e2e-replay-recheck-substrate.ts <instance_id>
 * Defaults to `pandas-dev__pandas-60736` when no arg supplied.
 *
 * Per jinn-mono-fufn — not committed as a CI test (too slow + needs Docker).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidatedPoolStore, EVAL_SEMANTICS_VERSION } from '../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { loadSweRebenchV2Pool } from '../src/solver-types/swe-rebench-v2.js';
import { SweRebenchV2EvaluatorHarness } from '../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import type { Task } from '../src/types/task.js';
import type { HarnessContext } from '../src/harnesses/types.js';

const STATE_DIR = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ?? join(homedir(), '.jinn-client', 'swe-rebench-v2');
const IMPL_STATE_DIR = join(homedir(), '.jinn-client', 'engine', 'impl-state', 'swe-rebench-v2-evaluator');

async function main() {
  const instanceId = process.argv[2] ?? 'pandas-dev__pandas-60736';
  console.log(`[replay] instance: ${instanceId}`);

  // 1. Confirm scorable admission
  const store = new ValidatedPoolStore({ stateDir: STATE_DIR });
  const admission = await store.getEntry(instanceId, EVAL_SEMANTICS_VERSION);
  if (!admission) {
    console.error(`[replay] no admission entry for ${instanceId} — run validate-pool first`);
    process.exit(1);
  }
  if (!admission.scorable) {
    console.error(`[replay] admission entry is unscorable: ${admission.reason}`);
    process.exit(1);
  }
  console.log(`[replay] admission: scorable=true, rowHash=${admission.rowHash?.slice(0, 24)}..., digest=${admission.imageDigest?.slice(0, 24)}...`);

  // 2. Find the pool task for the gold patch
  console.log('[replay] loading pool to get gold patch...');
  const pool = await loadSweRebenchV2Pool();
  const poolTask = pool.find((t) => t.instance_id === instanceId);
  if (!poolTask) {
    console.error(`[replay] ${instanceId} not in current pool`);
    process.exit(1);
  }
  if (!poolTask.patch) {
    console.error(`[replay] pool task has no gold patch`);
    process.exit(1);
  }
  console.log(`[replay] pool task: repo=${poolTask.repo}, base=${poolTask.base_commit?.slice(0, 12)}, patch=${poolTask.patch.length} bytes`);

  // 3. Construct the SignedEnvelope (solver's "solution" = the gold patch)
  const envelope = {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    generatedAt: Date.now(),
    task: {
      cid: 'bafy-replay',
      onchainCreationTx: `0x${'0'.repeat(64)}`,
      onchainCreationBlock: 1,
      requestId: `0x${'1'.repeat(64)}`,
    },
    participant: {
      safeAddress: `0x${'2'.repeat(40)}`,
      agentEoa: `0x${'3'.repeat(40)}`,
    },
    window: {
      startTs: Date.now() - 60_000,
      endTs: Date.now() + 60 * 60_000,
    },
    executor: {
      implName: 'replay-script',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: `sha256:${'0'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'1'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa' as const, pubkey: `0x${'3'.repeat(40)}` },
      mode: 'train' as const,
    },
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: poolTask.patch, // ← the gold patch
    },
    signature: {
      algo: 'secp256k1' as const,
      signer: `0x${'3'.repeat(40)}`,
      hash: `0x${'4'.repeat(64)}`,
      sig: `0x${'5'.repeat(130)}`,
    },
  };
  const envelopeJson = JSON.stringify(envelope);

  // 4. Construct the on-chain Task (SweRebenchV2Task spec)
  const task: Task = {
    requestId: `0x${'1'.repeat(64)}`,
    solverType: 'swe-rebench-v2.v1',
    role: 'evaluation',
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: instanceId,
      repo: poolTask.repo,
      base_commit: poolTask.base_commit ?? '0'.repeat(40),
      language: poolTask.language ?? 'python',
      problem_statement: 'replay',
      interface: '',
      hf_dataset: poolTask.hf_dataset,
      hf_split: poolTask.hf_split,
      deadline_unix: Math.floor(Date.now() / 1000) + 86400,
      round_month: '2026-05',
    },
    context: { restorationResult: envelopeJson },
  };

  // 5. Construct HarnessContext + Harness
  const workingDir = await mkdtemp(join(tmpdir(), 'swe-replay-'));
  try {
    const ctx: HarnessContext = {
      task,
      implStateDir: IMPL_STATE_DIR,
      workingDir,
      log: (msg) => console.log(`[harness] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`),
      abort: new AbortController().signal,
      msUntilEndTs: () => 60 * 60_000,
      trajectory: { addSpan: () => undefined } as unknown as HarnessContext['trajectory'],
      mode: 'train',
    };
    const harness = new SweRebenchV2EvaluatorHarness({
      implStateDir: IMPL_STATE_DIR,
    });

    console.log('[replay] invoking harness.run()...');
    const start = Date.now();
    const result = await harness.run(ctx);
    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\n[replay] PASS — harness.run() returned in ${elapsedSec}s`);
    console.log(`[replay] verdict: ${(result.gating as Record<string, unknown>)?.['verdict']}`);
    console.log(`[replay] passed_match: ${(result.gating as Record<string, unknown>)?.['passed_match']}`);
    console.log(`[replay] score: ${(result.gating as Record<string, unknown>)?.['score']}`);

    const verdict = (result.gating as Record<string, unknown>)?.['verdict'];
    if (verdict === 'PASS') {
      console.log('\n[replay] PASS — verdict-time recheck succeeded + gold patch graded correctly');
      process.exit(0);
    }
    console.error(`\n[replay] UNEXPECTED — verdict was ${verdict}, expected PASS`);
    process.exit(1);
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  const name = (err as { name?: string })?.name;
  if (name === 'SkippableError') {
    console.error(`\n[replay] FAIL — SkippableError thrown: ${(err as { reason?: string })?.reason ?? 'unknown'}`);
    console.error(`[replay] message: ${(err as Error).message}`);
  } else {
    console.error(`\n[replay] FAIL — unexpected error:`, err);
  }
  process.exit(1);
});
