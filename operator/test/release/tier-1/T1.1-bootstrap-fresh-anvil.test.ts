import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT11BootstrapFreshAnvil } from './T1.1-bootstrap-fresh-anvil.js';

describe('T1.1 bootstrap-fresh-anvil', () => {
  // The pass test requires real Base mainnet RPC; mark as long-running and skip if env signals.
  it('returns pass verdict when bootstrap completes', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.1-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.1.log');
    try {
      const verdict = await runT11BootstrapFreshAnvil({ evidencePath, wallClockBudgetMs: 180000 });
      expect(verdict.scenarioId).toBe('T1.1');
      expect(verdict.verdict).toBe('pass');
      expect(verdict.evidencePath).toBe(evidencePath);
      expect(verdict.wallClockMs).toBeGreaterThan(0);
      expect(verdict.failClass).toBeNull();
      const logContent = await fs.readFile(evidencePath, 'utf-8');
      expect(logContent).toContain('Phase 1');
      expect(logContent).toContain('Phase 11');
      expect(logContent).toContain('complete');
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 240000);

  it('returns fail verdict when bootstrap stalls (wall-clock budget exceeded)', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.1-evidence-stall-'));
    const evidencePath = path.join(evidenceDir, 'T1.1.log');
    try {
      const verdict = await runT11BootstrapFreshAnvil({ evidencePath, wallClockBudgetMs: 1 });
      expect(verdict.verdict).toBe('fail');
      // Budget exceeded → throws "timed out after 1ms" → classifyFailure → flake-timing
      expect(verdict.failClass).toMatch(/^(flake-timing|real-bug|flake-infra)$/);
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 30000);
});
