import { describe, it, expect } from 'vitest';
import { createNdjsonProgressEmitter, newRunId } from '../src/distill-progress.js';

/** Collect written chunks and parse them back as one JSON object per line. */
function sink(): { stream: { write: (s: string) => boolean }; events: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  return {
    stream: { write: (s: string) => (chunks.push(s), true) },
    events: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('newRunId', () => {
  it('mints distill-<unixms>-<4hex> ids', () => {
    expect(newRunId()).toMatch(/^distill-\d+-[0-9a-f]{4}$/);
  });
});

describe('createNdjsonProgressEmitter (#1533)', () => {
  it('stamps every event with v, event, ts, and runId — one JSON object per line', () => {
    const { stream, events } = sink();
    const em = createNdjsonProgressEmitter(stream, 'distill-1-aaaa');
    em.runStart({ capturesConsidered: 2, toDistill: 2, resume: false, distillProvider: 'claude', distillModel: 'm' });
    em.runEnd({ outcome: 'empty', clusterCount: 0, published: [], rejectedCount: 0, errorCount: 0, installed: [] });

    const evs = events();
    expect(evs).toHaveLength(2);
    for (const ev of evs) {
      expect(ev['v']).toBe(1);
      expect(typeof ev['event']).toBe('string');
      expect(ev['runId']).toBe('distill-1-aaaa');
      // ts is a parseable ISO-8601 instant.
      expect(Number.isNaN(Date.parse(ev['ts'] as string))).toBe(false);
    }
    expect(evs.map((e) => e['event'])).toEqual(['run_start', 'run_end']);
  });

  it('preserves the run_start → cluster_plan → cluster_start → cluster_end → run_end order', () => {
    const { stream, events } = sink();
    const em = createNdjsonProgressEmitter(stream, newRunId());
    em.runStart({ capturesConsidered: 1, toDistill: 1, resume: false, distillProvider: 'claude', distillModel: 'm' });
    em.clusterPlan({ clusterCount: 1, clusters: [{ clusterId: 'c1', index: 1, captureCount: 2, label: 'fix retry test' }] });
    em.clusterStart({ clusterId: 'c1', index: 1, total: 1, label: 'fix retry test' });
    em.clusterEnd({ clusterId: 'c1', index: 1, total: 1, outcome: 'published', skillName: 's', durationMs: 5 });
    em.runEnd({ outcome: 'ok', clusterCount: 1, published: ['s'], rejectedCount: 0, errorCount: 0, installed: [] });

    expect(events().map((e) => e['event'])).toEqual([
      'run_start',
      'cluster_plan',
      'cluster_start',
      'cluster_end',
      'run_end',
    ]);
  });

  it('emits heartbeats while a cluster is in flight and stops them at cluster_end', async () => {
    const { stream, events } = sink();
    const em = createNdjsonProgressEmitter(stream, newRunId(), { heartbeatMs: 5 });
    em.clusterStart({ clusterId: 'c1', index: 1, total: 2 });
    await wait(25);
    em.clusterEnd({ clusterId: 'c1', index: 1, total: 2, outcome: 'published', skillName: 's', durationMs: 25 });
    const inFlight = events().filter((e) => e['event'] === 'heartbeat');
    expect(inFlight.length).toBeGreaterThanOrEqual(1);
    for (const hb of inFlight) {
      expect(hb['clusterId']).toBe('c1');
      expect(hb['index']).toBe(1);
      expect(hb['total']).toBe(2);
      expect(typeof hb['elapsedMs']).toBe('number');
    }
    // Quiescent after cluster_end: no further heartbeats arrive.
    const before = events().length;
    await wait(25);
    expect(events().length).toBe(before);
  });

  it('runEnd clears a live heartbeat (error paths end mid-cluster)', async () => {
    const { stream, events } = sink();
    const em = createNdjsonProgressEmitter(stream, newRunId(), { heartbeatMs: 5 });
    em.clusterStart({ clusterId: 'c1', index: 1, total: 1 });
    em.runEnd({ outcome: 'partial', clusterCount: 1, published: [], rejectedCount: 0, errorCount: 1, installed: [] });
    const before = events().length;
    await wait(25);
    expect(events().length).toBe(before);
    expect(events().at(-1)?.['event']).toBe('run_end');
  });

  it('run_end carries durationMs for the whole run', () => {
    const { stream, events } = sink();
    const em = createNdjsonProgressEmitter(stream, newRunId());
    em.runEnd({ outcome: 'empty', clusterCount: 0, published: [], rejectedCount: 0, errorCount: 0, installed: [] });
    expect(typeof events()[0]?.['durationMs']).toBe('number');
  });
});
