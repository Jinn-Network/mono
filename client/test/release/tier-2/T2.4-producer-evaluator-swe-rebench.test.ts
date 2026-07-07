/**
 * Vitest wrapper for T2.4 — swe-rebench-v2 producer/evaluator on an Anvil fork.
 *
 * Invokes runT24ProducerEvaluatorSweRebench and asserts the structural contract
 * (valid ScenarioVerdict shape). The solve leg is hermetic (StubHarness patch
 * injection); the evaluator leg runs the REAL swe-rebench-v2 Docker evaluator
 * only when Docker + the enabled upstream repo + a seeded admission record are
 * present, and returns a classified `skip` otherwise — so on a Dockerless CI
 * host this returns `skip`, and on a provisioned host it returns `pass`. Both
 * satisfy the structural invariants below.
 *
 * Like T2.2's wrapper, this is a full Anvil-fork e2e: it needs Foundry's
 * `anvil`/`forge` on PATH and the compiled `contracts/` artifacts. When that
 * infrastructure is absent the callable returns a classified `fail` rather than
 * throwing, so these structural assertions still hold.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT24ProducerEvaluatorSweRebench } from './T2.4-producer-evaluator-swe-rebench.js';

describe('T2.4 producer-evaluator (swe-rebench-v2)', () => {
  it('returns a structured verdict (pass/fail/skip)', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T2.4-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T2.4.log');
    try {
      const verdict = await runT24ProducerEvaluatorSweRebench({
        evidencePath,
        wallClockBudgetMs: 18 * 60 * 1000,
      });

      // Structural invariants — always hold regardless of pass/fail/skip.
      expect(['pass', 'fail', 'skip']).toContain(verdict.verdict);
      expect(verdict.scenarioId).toBe('T2.4');
      expect(verdict.wallClockMs).toBeGreaterThanOrEqual(0);
      expect(verdict.evidencePath).toBe(evidencePath);
      // fail verdicts must carry a failClass (enforced by ScenarioVerdictSchema too).
      if (verdict.verdict === 'fail') {
        expect(verdict.failClass).not.toBeNull();
        console.error('[T2.4] fail verdict — failClass:', verdict.failClass);
        console.error('[T2.4] fail notes:', verdict.failNotes);
      }
      if (verdict.verdict === 'skip') {
        console.error('[T2.4] skip verdict — reason:', verdict.failNotes);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
    // 25 min: the callable enforces its own 18-min wall-clock budget via a
    // Promise.race deadline, so on overrun it returns a classified verdict well
    // before this fires. The extra margin covers post-deadline teardown.
  }, 25 * 60 * 1000);
});
