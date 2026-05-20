/**
 * Vitest wrapper for T2.2 — producer/evaluator on Anvil-fork.
 *
 * Invokes the callable exported by T2.2-producer-evaluator.ts and asserts only
 * the structural contract (valid ScenarioVerdict shape). The callable handles
 * all skip/pass/fail logic itself.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT22ProducerEvaluator } from './T2.2-producer-evaluator.js';

describe('T2.2 producer-evaluator', () => {
  it('returns a structured verdict (pass/fail/skip)', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T2.2-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T2.2.log');
    try {
      const verdict = await runT22ProducerEvaluator({
        evidencePath,
        wallClockBudgetMs: 5 * 60 * 1000,
      });

      // Structural invariants — always hold regardless of pass/fail/skip.
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
      if (verdict.verdict === 'skip') {
        console.info('[T2.2] skip verdict —', verdict.failNotes);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 6 * 60 * 1000);
});
