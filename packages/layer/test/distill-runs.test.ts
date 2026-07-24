import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDistillRun, readDistillRuns, type DistillRunRecord } from '../src/distill-runs.js';

function tmpRunsPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'jinn-distill-runs-')), 'distill-runs.jsonl');
}

function record(over: Partial<DistillRunRecord> = {}): DistillRunRecord {
  return {
    runId: 'distill-1-aaaa',
    startedAt: '2026-07-10T12:00:00.000Z',
    durationMs: 5000,
    outcome: 'ok',
    clusterCount: 2,
    published: ['skill-a', 'skill-b'],
    rejectedCount: 0,
    errorCount: 0,
    installed: ['skill-a'],
    distillModel: 'claude-opus-4-8',
    ...over,
  };
}

describe('distill run log (#1535)', () => {
  it('appends one JSON line per run and reads them back newest-first', () => {
    const path = tmpRunsPath();
    appendDistillRun(record({ runId: 'r1', startedAt: '2026-07-10T10:00:00.000Z' }), path);
    appendDistillRun(record({ runId: 'r2', startedAt: '2026-07-10T11:00:00.000Z' }), path);

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const runs = readDistillRuns(10, path);
    expect(runs.map((r) => r.runId)).toEqual(['r2', 'r1']);
  });

  it('respects the limit', () => {
    const path = tmpRunsPath();
    for (let i = 0; i < 5; i += 1) appendDistillRun(record({ runId: `r${i}` }), path);
    expect(readDistillRuns(2, path)).toHaveLength(2);
  });

  it('tolerates corrupt lines (skips them, keeps the rest)', () => {
    const path = tmpRunsPath();
    appendDistillRun(record({ runId: 'good-1' }), path);
    writeFileSync(path, readFileSync(path, 'utf-8') + '{ not json\n', { encoding: 'utf-8' });
    appendDistillRun(record({ runId: 'good-2' }), path);
    const runs = readDistillRuns(10, path);
    expect(runs.map((r) => r.runId)).toEqual(['good-2', 'good-1']);
  });

  it('reads an absent file as no runs', () => {
    expect(readDistillRuns(10, tmpRunsPath())).toEqual([]);
  });

  it('creates the parent directory when appending', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jinn-distill-runs-nested-')), 'a', 'b', 'runs.jsonl');
    appendDistillRun(record(), path);
    expect(readDistillRuns(1, path)).toHaveLength(1);
  });
});
