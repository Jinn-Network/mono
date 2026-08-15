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
import { seedNativeRun } from '@test/seed-native-run.js';

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

  it('enriches COMPLETE solve outcomes from the native verdict tally store (#502)', async () => {
    store = freshStore();
    const digest = `sha256:${'a'.repeat(64)}`;
    seedNativeRun(store, {
      requestId: 'swe-complete',
      taskId: '77',
      taskCid: digest,
      solverType: 'swe-rebench-v2.v1',
      taskRole: 'restoration',
      windowStartTs: 1_000,
      windowEndTs: 2_000,
      state: 'COMPLETE',
      stateUpdatedAt: 2_500,
      task: {
        id: 'swe-complete',
        description: 'SWE task',
        solverType: 'swe-rebench-v2.v1',
        role: 'restoration',
      },
    });
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS native_canonical_observations (
        observation_id TEXT PRIMARY KEY, observation_json TEXT NOT NULL, accepted_at TEXT NOT NULL
      );
    `);
    store.db
      .prepare(
        `INSERT INTO native_canonical_observations (observation_id, observation_json, accepted_at)
         VALUES ('obs-77a', ?, '2026-08-01T00:00:06.000Z'),
                ('obs-77b', ?, '2026-08-01T00:00:07.000Z')`,
      )
      .run(
        JSON.stringify({
          id: 'obs-77a',
          type: 'network.jinn.task-execution.attempt-terminal.v1',
          taskdigest: digest,
          data: { state: 'delivered' },
        }),
        JSON.stringify({
          id: 'obs-77b',
          type: 'network.jinn.task-execution.attempt-terminal.v1',
          taskdigest: digest,
          data: { state: 'delivered' },
        }),
      );

    server = await startApiServer({
      port: 0,
      store,
      apiToken: 't',
      status: {
        earningDir: mkdtempSync(join(tmpdir(), 'set-status-earn-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      },
    });

    const body = await fetchStatus(server);
    const taskRuns = body.taskRuns as { recentTasks: Array<{ requestId: string; outcome: string | null }> };
    const row = taskRuns.recentTasks.find((r) => r.requestId === 'swe-complete');
    expect(row?.outcome).toBe('pass');
  });
});
