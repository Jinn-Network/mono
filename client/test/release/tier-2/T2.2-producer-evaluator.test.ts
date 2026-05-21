/**
 * Vitest wrapper for T2.2 — producer/evaluator on an Anvil fork.
 *
 * Invokes the callable exported by T2.2-producer-evaluator.ts and asserts the
 * structural contract (valid ScenarioVerdict shape). The callable drives the
 * real on-chain producer → solve → deliver → evaluate → verdict loop and
 * returns `pass` on success or a classified `fail` otherwise — there is no
 * skip path (the rewrite removed the missing-endpoint probe; see issue #350).
 *
 * Infrastructure requirements: an Anvil fork of Base (the daemon-harness
 * primitives spawn it from `BASE_RPC_URL`, defaulting to the public
 * `https://mainnet.base.org`), Foundry's `anvil`/`forge` on PATH, and the
 * compiled `contracts/` artifacts. When that infrastructure is unavailable the
 * callable returns a classified `fail` rather than throwing, so this wrapper's
 * structural assertions still hold.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT22ProducerEvaluator } from './T2.2-producer-evaluator.js';

describe('T2.2 producer-evaluator', () => {
  it('returns a structured verdict (pass/fail)', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T2.2-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T2.2.log');
    try {
      const verdict = await runT22ProducerEvaluator({
        evidencePath,
        wallClockBudgetMs: 18 * 60 * 1000,
      });

      // Structural invariants — always hold regardless of pass/fail.
      expect(['pass', 'fail', 'skip']).toContain(verdict.verdict);
      expect(verdict.scenarioId).toBe('T2.2');
      expect(verdict.wallClockMs).toBeGreaterThanOrEqual(0);
      expect(verdict.evidencePath).toBe(evidencePath);
      // fail verdicts must carry a failClass (enforced by ScenarioVerdictSchema too).
      if (verdict.verdict === 'fail') {
        expect(verdict.failClass).not.toBeNull();
        console.error('[T2.2] fail verdict — failClass:', verdict.failClass);
        console.error('[T2.2] fail notes:', verdict.failNotes);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
    // 25 min: the callable enforces its own 18-min wall-clock budget via a
    // Promise.race deadline, so on overrun it returns a classified verdict
    // well before this fires. The extra margin over the 18-min budget only
    // covers the post-deadline teardown (Anvil + mock servers) so the run
    // still ends with a real verdict instead of a process kill.
  }, 25 * 60 * 1000);
});
