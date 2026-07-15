import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { describeLocalLearningPortContract } from '@jinn-network/plugin/testing';
import type { CapturedTask } from '../../src/capture.js';
import { createLocalDistiller, createLocalSkillSink, type Distiller } from '../../src/distiller.js';
import type { DistillCluster, DistillLLMOutput } from '../../src/distill.js';
import { createLocalLearningAdapter } from '../../src/adapters/local-learning-adapter.js';

/** A no-network distill LLM stub. */
const stubDistill = async (_cluster: DistillCluster): Promise<DistillLLMOutput> => ({
  name: 'stub-skill',
  description: 'Not for: anything. A stub skill.',
  body: 'stub body',
});

function makeDistiller(distill = stubDistill): Distiller {
  const sinkDir = mkdtempSync(join(tmpdir(), 'll-sink-'));
  return createLocalDistiller({ distill, sink: createLocalSkillSink(sinkDir) });
}

const loadNothing = async (_episodeIds: string[]): Promise<CapturedTask[]> => [];

function makeAdapter() {
  return createLocalLearningAdapter({ distiller: makeDistiller(), loadCaptures: loadNothing });
}

describeLocalLearningPortContract(makeAdapter);

describe('LocalLearningAdapter — run lifecycle', () => {
  it('a distiller that throws marks the run failed (not a port error)', async () => {
    const throwingDistiller: Distiller = {
      async distill(): Promise<never> {
        throw new Error('distill blew up');
      },
    };
    const adapter = createLocalLearningAdapter({
      distiller: throwingDistiller,
      loadCaptures: loadNothing,
    });
    const runResult = await adapter.run({ episodeIds: ['e1'] });
    expect(runResult.status).toBe('ok');
    if (runResult.status !== 'ok') return;
    await adapter.awaitRun(runResult.value.runId);
    const status = await adapter.status(runResult.value.runId);
    expect(status.status).toBe('ok');
    if (status.status === 'ok') expect(status.value.state).toBe('failed');
  });

  it('a successful run reaches done', async () => {
    const adapter = makeAdapter();
    const runResult = await adapter.run({ episodeIds: [] });
    if (runResult.status !== 'ok') throw new Error('run failed');
    await adapter.awaitRun(runResult.value.runId);
    const status = await adapter.status(runResult.value.runId);
    expect(status.status).toBe('ok');
    if (status.status === 'ok') expect(status.value.state).toBe('done');
  });

  it('status on an unknown runId is unavailable', async () => {
    const adapter = makeAdapter();
    const result = await adapter.status('nope');
    expect(result.status).toBe('unavailable');
  });

  it('loadCaptures resolves the requested episode ids', async () => {
    const loadCaptures = vi.fn(loadNothing);
    const adapter = createLocalLearningAdapter({ distiller: makeDistiller(), loadCaptures });
    const runResult = await adapter.run({ episodeIds: ['e1', 'e2'] });
    if (runResult.status !== 'ok') throw new Error('run failed');
    await adapter.awaitRun(runResult.value.runId);
    expect(loadCaptures).toHaveBeenCalledWith(['e1', 'e2']);
  });
});
