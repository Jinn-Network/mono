import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  addStopHookRoutes,
  normalizeStopHookPayload,
  type StopHookPayload,
} from '../../src/api/stop-hook.js';

describe('stop-hook API', () => {
  it('normalizes common hook payload fields', () => {
    const payload = normalizeStopHookPayload({
      tool: 'claude-code',
      now: new Date('2026-05-08T00:00:00.000Z'),
      stdin: JSON.stringify({
        session_id: 'sess-1',
        transcript_path: '/tmp/session.jsonl',
        cwd: '/repo',
      }),
    });
    expect(payload).toMatchObject({
      tool: 'claude-code',
      sessionId: 'sess-1',
      stoppedAt: '2026-05-08T00:00:00.000Z',
      transcriptPath: '/tmp/session.jsonl',
      repoRoot: '/repo',
    });
  });

  it('accepts valid daemon POST payloads', async () => {
    const seen: StopHookPayload[] = [];
    const app = new Hono();
    addStopHookRoutes(app, { onStopHook: (payload) => seen.push(payload) });

    const res = await app.request('/api/stop-hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'codex',
        sessionId: 'sess-2',
        stoppedAt: '2026-05-08T00:00:00.000Z',
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionId: 'sess-2' });
    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe('codex');
  });

  it('rejects invalid payloads', async () => {
    const app = new Hono();
    addStopHookRoutes(app, { onStopHook: () => undefined });
    const res = await app.request('/api/stop-hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'unknown' }),
    });
    expect(res.status).toBe(400);
  });
});
