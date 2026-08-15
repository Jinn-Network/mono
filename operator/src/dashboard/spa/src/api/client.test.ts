import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.fetchLauncherTasks', () => {
  it('serializes manifestCid with pagination options', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ schemaVersion: 1, generatedAt: '', tasks: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);

    await api.fetchLauncherTasks({
      cursor: 'before:2026-05-05T10:00:00.000Z',
      limit: 5,
      manifestCid: 'bafy-owned-launch',
    });

    const path = String(fetchImpl.mock.calls[0]?.[0]);
    const url = new URL(path, 'http://localhost');
    expect(url.pathname).toBe('/v1/launcher/tasks');
    expect(url.searchParams.get('cursor')).toBe('before:2026-05-05T10:00:00.000Z');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('manifestCid')).toBe('bafy-owned-launch');
  });
});
