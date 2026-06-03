/**
 * ApiServer.setStatusConfig — the daemon swaps the running-mode status
 * block in after the setup-mode server is already up. Without this, the
 * running-mode aiUnits + spendCaps config built in main.ts never reaches
 * the GET /v1/status handler, and the SPA's AiUnitsPauseAlert + spend
 * row stay empty even though the daemon is actually enforcing the gate.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { startApiServer, type ApiServer } from '../../src/api/server.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'set-status-config-')), 'jinn.db'));
}

async function fetchStatus(server: ApiServer): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${server.port}/v1/status`);
  return (await res.json()) as Record<string, unknown>;
}

describe('ApiServer.setStatusConfig', () => {
  let store: Store;
  let server: ApiServer;
  afterEach(async () => {
    await server?.close();
    store?.close();
  });

  it('serves the running-mode aiUnits block after setStatusConfig', async () => {
    store = freshStore();
    server = await startApiServer({ port: 0, store, apiToken: 't' });

    const before = await fetchStatus(server);
    expect(before.aiUnits).toBeUndefined();

    server.setStatusConfig({
      aiUnits: {
        capPerBlock: 100,
        capPerWeek: 2800,
        capPerBlockUsdMicros: 500_000,
        capPerWeekUsdMicros: 14_000_000,
        manifestCredentials: { 'cid-1': 'anthropic:api-key' },
        manifestProjectedAiUnits: { 'cid-1': 5 },
        manifestProjectedUsdMicros: { 'cid-1': 25_000 },
        manifestModels: { 'cid-1': 'claude-haiku-4-5' },
      },
    });

    const after = await fetchStatus(server);
    expect(after.aiUnits).toBeDefined();
    const block = after.aiUnits as { credentials: Array<Record<string, unknown>> };
    expect(block.credentials).toHaveLength(1);
    expect(block.credentials[0]).toMatchObject({
      credentialId: 'anthropic:api-key',
      capPerBlock: 100,
      capPerWeek: 2800,
      paused: false,
    });
  });

  it('drops the aiUnits block when setStatusConfig is called with undefined', async () => {
    store = freshStore();
    server = await startApiServer({
      port: 0,
      store,
      apiToken: 't',
      status: {
        aiUnits: {
          capPerBlock: 100,
          capPerWeek: 2800,
          capPerBlockUsdMicros: 500_000,
          capPerWeekUsdMicros: 14_000_000,
          manifestCredentials: { 'cid-1': 'anthropic:api-key' },
          manifestProjectedAiUnits: { 'cid-1': 5 },
          manifestProjectedUsdMicros: { 'cid-1': 25_000 },
          manifestModels: { 'cid-1': 'claude-haiku-4-5' },
        },
      },
    });
    const before = await fetchStatus(server);
    expect(before.aiUnits).toBeDefined();

    server.setStatusConfig(undefined);
    const after = await fetchStatus(server);
    expect(after.aiUnits).toBeUndefined();
  });
});
