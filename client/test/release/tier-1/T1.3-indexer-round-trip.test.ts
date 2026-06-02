import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT13IndexerRoundTrip } from './T1.3-indexer-round-trip.js';

describe('T1.3 indexer-round-trip', () => {
  // The pass path requires a live RPC to fork (BASE_SEPOLIA_RPC_URL), the anvil
  // binary, and the Ponder indexer package. When any is absent the scenario
  // skips cleanly. A thrown infrastructure error (fork/RPC/Ponder spawn) must
  // classify as flake-infra or flake-timing — never real-bug — so a CI box
  // without network is never misread as a product regression.
  it('runs the real round-trip, or skips cleanly when prerequisites are absent', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.3-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.3.log');
    try {
      const verdict = await runT13IndexerRoundTrip({ evidencePath, wallClockBudgetMs: 120000 });
      expect(verdict.scenarioId).toBe('T1.3');
      expect(verdict.evidencePath).toBe(evidencePath);
      expect(verdict.wallClockMs).toBeGreaterThanOrEqual(0);

      if (verdict.verdict === 'pass') {
        expect(verdict.failClass).toBeNull();
        const logContent = await fs.readFile(evidencePath, 'utf-8');
        expect(logContent).toContain('Phase 1');
        expect(logContent).toContain('schema OK');
      } else if (verdict.verdict === 'skip') {
        expect(verdict.failClass).toBeNull();
        // No stale #341 reason — the helper exists. The skip is a runtime
        // prerequisite gap (RPC / anvil / Ponder), not a missing helper.
        expect(verdict.failNotes ?? '').not.toMatch(/341/);
        expect(verdict.failNotes ?? '').toMatch(/RPC|anvil|Ponder/i);
      } else {
        // A fail is only acceptable when it is classified infra/timing, never a
        // real-bug, because this test box may simply lack network/anvil/Ponder.
        expect(verdict.failClass).toMatch(/^(flake-infra|flake-timing)$/);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 180000);
});
