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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import type { DiscoveryAPI } from '../../src/discovery/types.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'set-status-config-')), 'jinn.db'));
}

// `/v1/status` is operator-class as of spec §14.5 (issue #2404); every server built
// below passes `apiToken: 't'` and no `ui`, so the bearer token is the gate credential.
async function fetchStatus(server: ApiServer): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${server.port}/v1/status`, {
    headers: { Authorization: 'Bearer t' },
  });
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

  it('threads the configured DiscoveryAPI into /v1/status so outcomes are enriched (#502)', async () => {
    store = freshStore();
    const persistence = new TaskRunPersistence(store.db);
    persistence.insertDiscovered({
      requestId: 'swe-complete',
      taskId: '77',
      taskCid: 'bafy-swe-complete',
      onchainCreationTx: '0xabc',
      onchainCreationBlock: 1,
      solverType: 'swe-rebench-v2.v1',
      taskRole: 'restoration',
      windowStartTs: 1_000,
      windowEndTs: 2_000,
      task: {
        id: 'swe-complete',
        description: 'SWE task',
        solverType: 'swe-rebench-v2.v1',
        role: 'restoration',
      },
    });
    store.db.prepare(
      `UPDATE task_runs SET state = 'COMPLETE', state_updated_at = ? WHERE request_id = ?`,
    ).run(2_500, 'swe-complete');

    const getVerdictTallies = vi.fn(async () =>
      new Map([['77', { pass: 2, fail: 0 }]]),
    );
    const discovery = { getVerdictTallies } as unknown as DiscoveryAPI;

    server = await startApiServer({
      port: 0,
      store,
      apiToken: 't',
      discovery,
      status: {
        earningDir: mkdtempSync(join(tmpdir(), 'set-status-earn-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      },
    });

    const body = await fetchStatus(server);
    expect(getVerdictTallies).toHaveBeenCalledWith({ taskIds: ['77'] });
    const taskRuns = body.taskRuns as { recentTasks: Array<{ requestId: string; outcome: string | null }> };
    const row = taskRuns.recentTasks.find((r) => r.requestId === 'swe-complete');
    expect(row?.outcome).toBe('pass');
  });
});
