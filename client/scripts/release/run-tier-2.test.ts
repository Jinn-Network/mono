import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ScenarioVerdict } from './scenario-types.js';

const runners = vi.hoisted(() => ({
  runT22ProducerEvaluator: vi.fn(),
  runT24ProducerEvaluatorSweRebench: vi.fn(),
}));

vi.mock('../../test/release/tier-2/T2.2-producer-evaluator.js', () => ({
  runT22ProducerEvaluator: runners.runT22ProducerEvaluator,
}));

vi.mock('../../test/release/tier-2/T2.4-producer-evaluator-swe-rebench.js', () => ({
  runT24ProducerEvaluatorSweRebench: runners.runT24ProducerEvaluatorSweRebench,
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

function skipVerdict(scenarioId: string, evidencePath: string, reason: string): ScenarioVerdict {
  return {
    scenarioId,
    verdict: 'skip',
    wallClockMs: 1,
    evidencePath,
    failClass: null,
    failNotes: reason,
  };
}

describe('runTier2', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-tier-2-test-'));
    runners.runT22ProducerEvaluator.mockImplementation(async (opts: { evidencePath: string }) =>
      passVerdict('T2.2', opts.evidencePath),
    );
    runners.runT24ProducerEvaluatorSweRebench.mockImplementation(async (opts: { evidencePath: string }) =>
      passVerdict('T2.4', opts.evidencePath),
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('gives T2.2 + T2.4 their full scenario budget', async () => {
    const result = await runTier2({ outputDir, candidateVersion: 'test-sha' });

    expect(result.allPassed).toBe(true);
    expect(runners.runT22ProducerEvaluator).toHaveBeenCalledWith({
      evidencePath: path.join(outputDir, 'T2.2.log'),
      wallClockBudgetMs: 18 * 60 * 1000,
    });
    expect(runners.runT24ProducerEvaluatorSweRebench).toHaveBeenCalledWith({
      evidencePath: path.join(outputDir, 'T2.4.log'),
      wallClockBudgetMs: 18 * 60 * 1000,
    });
  });

  it('treats a T2.4 skip as non-blocking — allPassed stays true and the marker is not failed', async () => {
    runners.runT24ProducerEvaluatorSweRebench.mockImplementation(async (opts: { evidencePath: string }) =>
      skipVerdict('T2.4', opts.evidencePath, 'docker-absent'),
    );

    const result = await runTier2({ outputDir, candidateVersion: 'test-sha' });

    expect(result.allPassed).toBe(true);

    const marker = await fs.readFile(path.join(outputDir, 'marker.txt'), 'utf8');
    expect(marker).toContain('tier-2-t2-4=skipped:docker-absent');
    expect(marker).toContain('tier-2-overall=passed');
  });
});
