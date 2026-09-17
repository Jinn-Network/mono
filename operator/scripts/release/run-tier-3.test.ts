import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ScenarioVerdict } from './scenario-types.js';

const runners = vi.hoisted(() => ({
  runT31ProducerEvaluatorReal: vi.fn(),
}));

vi.mock('../../test/release/tier-3/T3.1-producer-evaluator-real.js', () => ({
  runT31ProducerEvaluatorReal: runners.runT31ProducerEvaluatorReal,
}));

import { runTier3 } from './run-tier-3.js';

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

function failVerdict(scenarioId: string, evidencePath: string, failClass: 'real-bug'): ScenarioVerdict {
  return {
    scenarioId,
    verdict: 'fail',
    wallClockMs: 1,
    evidencePath,
    failClass,
    failNotes: 'boom',
  };
}

describe('runTier3', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-tier-3-test-'));
    runners.runT31ProducerEvaluatorReal.mockImplementation(async (opts: { evidencePath: string }) =>
      passVerdict('T3.1', opts.evidencePath),
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  // The marker ternary had no `skip` arm, so a skipped T3.1 emitted `failed:null` — a
  // skip misreported as a failure — above `tier-3-overall=failed`. run-tier-1.ts and
  // run-tier-2.ts already treat skip as non-blocking (#4483).
  it('writes a skipped T3.1 as skipped, not failed', async () => {
    runners.runT31ProducerEvaluatorReal.mockImplementation(async (opts: { evidencePath: string }) =>
      skipVerdict('T3.1', opts.evidencePath, 'docker-absent'),
    );

    const result = await runTier3({ outputDir, candidateVersion: 'v0.0.0-test' });
    const marker = await fs.readFile(path.join(outputDir, 'marker.txt'), 'utf-8');

    expect(marker).toContain('tier-3-t3-1=skipped:docker-absent');
    expect(marker).toContain('tier-3-overall=passed');
    expect(marker).not.toContain('failed:null');
    expect(marker).not.toContain('tier-3-overall=failed');
    expect(result.allPassed).toBe(true);
  });

  it('writes a passed T3.1 as passed', async () => {
    const result = await runTier3({ outputDir, candidateVersion: 'v0.0.0-test' });
    const marker = await fs.readFile(path.join(outputDir, 'marker.txt'), 'utf-8');

    expect(marker).toContain('tier-3-t3-1=passed');
    expect(marker).toContain('tier-3-overall=passed');
    expect(result.allPassed).toBe(true);
  });

  it('writes a failed T3.1 with its failClass', async () => {
    runners.runT31ProducerEvaluatorReal.mockImplementation(async (opts: { evidencePath: string }) =>
      failVerdict('T3.1', opts.evidencePath, 'real-bug'),
    );

    const result = await runTier3({ outputDir, candidateVersion: 'v0.0.0-test' });
    const marker = await fs.readFile(path.join(outputDir, 'marker.txt'), 'utf-8');

    expect(marker).toContain('tier-3-t3-1=failed:real-bug');
    expect(marker).toContain('tier-3-overall=failed');
    expect(result.allPassed).toBe(false);
  });
});
