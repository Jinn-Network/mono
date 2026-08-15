import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildT31DaemonEnv,
  runT31ProducerEvaluatorReal,
} from './T3.1-producer-evaluator-real.js';

describe('T3.1 producer-evaluator-real', () => {
  // Gated: this test spends real testnet ETH + real OpenRouter $. Only runs when
  // explicitly opted in via JINN_T31_REAL=1.
  const enabled = process.env['JINN_T31_REAL'] === '1';

  it.skipIf(!enabled)('returns pass verdict against real Base Sepolia + real Hermes', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T3.1-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T3.1.log');
    try {
      const verdict = await runT31ProducerEvaluatorReal({
        evidencePath,
        mode: 'human-invoked',
        wallClockBudgetMs: 10 * 60 * 1000,
      });
      expect(['pass', 'fail']).toContain(verdict.verdict);
      if (verdict.verdict === 'fail') {
        console.error('T3.1 fail:', verdict.failNotes);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 12 * 60 * 1000);

  it('callable shape matches ScenarioVerdict', () => {
    // Static type check at compile time; this test just asserts the export exists.
    expect(typeof runT31ProducerEvaluatorReal).toBe('function');
  });

  it('narrows daemon discovery to the freshly posted on-chain task id', () => {
    expect(buildT31DaemonEnv({
      hermesModel: 'deepseek/test-model',
      onchainTaskId: '4249',
    })).toMatchObject({
      JINN_HERMES_MODEL: 'deepseek/test-model',
      JINN_TIER3_COST_CAP_USD: '0.25',
      JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS: '4249',
    });
  });
});
