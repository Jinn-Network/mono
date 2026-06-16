import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ScenarioVerdict } from './scenario-types.js';

const runners = vi.hoisted(() => ({
  runT21CrossOpDonation: vi.fn(),
  runT22ProducerEvaluator: vi.fn(),
}));

vi.mock('../../test/release/tier-2/T2.1-cross-op-donation.js', () => ({
  runT21CrossOpDonation: runners.runT21CrossOpDonation,
}));

vi.mock('../../test/release/tier-2/T2.2-producer-evaluator.js', () => ({
  runT22ProducerEvaluator: runners.runT22ProducerEvaluator,
}));

import { runTier2 } from './run-tier-2.js';

function passVerdict(scenarioId: string, evidencePath: string): ScenarioVerdict {
  return {
    scenarioId,
    verdict: 'pass',
    wallClockMs: 1,
    evidencePath,
    failClass: null,
    failNotes: null,
  };
}

describe('runTier2', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-tier-2-test-'));
    runners.runT21CrossOpDonation.mockImplementation(async (opts: { evidencePath: string }) =>
      passVerdict('T2.1', opts.evidencePath),
    );
    runners.runT22ProducerEvaluator.mockImplementation(async (opts: { evidencePath: string }) =>
      passVerdict('T2.2', opts.evidencePath),
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('keeps T2.1 on the short budget and gives T2.2 its full scenario budget', async () => {
    const result = await runTier2({ outputDir, candidateVersion: 'test-sha' });

    expect(result.allPassed).toBe(true);
    expect(runners.runT21CrossOpDonation).toHaveBeenCalledWith({
      evidencePath: path.join(outputDir, 'T2.1.log'),
      wallClockBudgetMs: 5 * 60 * 1000,
    });
    expect(runners.runT22ProducerEvaluator).toHaveBeenCalledWith({
      evidencePath: path.join(outputDir, 'T2.2.log'),
      wallClockBudgetMs: 18 * 60 * 1000,
    });
  });
});
