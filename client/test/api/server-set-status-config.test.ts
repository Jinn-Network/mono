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
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';

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

    const digest = `sha256:${'a'.repeat(64)}`;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS native_canonical_observations (
        observation_id TEXT PRIMARY KEY, observation_json TEXT NOT NULL, accepted_at TEXT NOT NULL
      );
    `);
    store.db
      .prepare(
        `INSERT INTO native_engagements
          (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
           submission_uri, submission_digest, state, attempt_index, attempt_uri, request_id,
           policy_json, capability_json, created_at, updated_at)
         VALUES ('eng-77', '84532', '0xcoord', '77', 'solver', '0xop', ?,
                 'urn:uuid:00000000-0000-0000-0000-000000000077', 'sha256:${'b'.repeat(64)}',
                 'solution-settled', 0, NULL, '0xreq77', '{}', '{}',
                 '2026-08-01T00:00:02.000Z', '2026-08-01T00:00:05.000Z')`,
      )
      .run(digest);
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
