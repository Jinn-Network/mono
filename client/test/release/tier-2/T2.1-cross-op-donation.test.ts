/**
 * Vitest wrapper for T2.1 — cross-operator corpus donation.
 *
 * Invokes the callable exported by T2.1-cross-op-donation.ts and asserts only
 * the structural contract (valid ScenarioVerdict shape). The callable handles
 * all pass/fail/skip logic itself.
 *
 * The scenario forks Base Sepolia and boots two operator daemons, so the full
 * run needs `BASE_SEPOLIA_RPC_URL` and the built `dist/bin/jinn.js`. Without the
 * RPC env var the callable returns a clean `skip` — the structural assertions
 * below still hold.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT21CrossOpDonation } from './T2.1-cross-op-donation.js';

describe('T2.1 cross-op-donation', () => {
  it('returns a structured verdict (pass/fail/skip)', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T2.1-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T2.1.log');
    try {
      const verdict = await runT21CrossOpDonation({
        evidencePath,
        wallClockBudgetMs: 5 * 60 * 1000,
      });

      // Structural invariants — always hold regardless of pass/fail/skip.
      expect(['pass', 'fail', 'skip']).toContain(verdict.verdict);
      expect(verdict.scenarioId).toBe('T2.1');
      expect(verdict.wallClockMs).toBeGreaterThanOrEqual(0);
      expect(verdict.evidencePath).toBe(evidencePath);
      // fail verdicts must carry a failClass (enforced by ScenarioVerdictSchema too).
      if (verdict.verdict === 'fail') {
        expect(verdict.failClass).not.toBeNull();
        console.error('[T2.1] fail verdict — failClass:', verdict.failClass);
        console.error('[T2.1] fail notes:', verdict.failNotes);
      }
      if (verdict.verdict === 'skip') {
        console.info('[T2.1] skip verdict —', verdict.failNotes);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 6 * 60 * 1000);
});
