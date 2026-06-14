import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FetchLike } from '@jinn-network/indexer/ipfs';
import { EnrichmentStore } from '../src/db.js';
import { enrichBatch, type EnrichDeps } from '../src/enrich.js';
import { createPgliteHarness, type PgliteHarness } from './helpers/pglite-db.js';

const CHAIN_ID = 84532;
const REQUEST_ID = `0x${'aa'.repeat(32)}`;

let h: PgliteHarness;
let store: EnrichmentStore;

beforeEach(async () => {
  h = await createPgliteHarness();
  store = new EnrichmentStore(h.db, h.schema);
});

afterEach(async () => {
  await h.close();
});

async function seedEvalAnchor(cid: string, block: bigint): Promise<void> {
  await h.db.execute(
    sql`INSERT INTO ${sql.raw(`"${h.schema}"."envelope"`)}
      ("agent_id","metadata_key","chain_id","kind","manifest_cid","manifest_hash","evidence_tier","published_at_block","log_index")
      VALUES (${'1'}, ${`evaluation:${cid}`}, ${CHAIN_ID}, ${'evaluation'}, ${cid}, ${'0x'}, ${'committed'}, ${block}, ${0})`,
  );
}

async function readVerdict(requestId: string): Promise<Record<string, unknown> | undefined> {
  const res = await h.db.execute(
    sql`SELECT * FROM ${sql.raw(`"${h.schema}"."verdict_envelope_meta"`)} WHERE "request_id" = ${requestId}`,
  );
  return (res.rows as Record<string, unknown>[])[0];
}

function depsWith(fetchImpl: FetchLike): EnrichDeps {
  return {
    ipfsGateway: 'https://stub',
    ipfsTimeoutMs: 5000,
    batchSize: 25,
    chainId: CHAIN_ID,
    fetchImpl,
    now: () => 1_000_000,
  };
}

const SWE_VERDICT_BODY = {
  schemaVersion: 'jinn.execution.v1',
  role: 'verdict',
  solverType: 'swe-rebench-v2.v1',
  task: { requestId: REQUEST_ID, taskId: '42', attemptIndex: 1, cid: 'bafytask' },
  verdictIndex: 0,
  participant: { safeAddress: `0x${'bb'.repeat(20)}` },
  evidenceTier: 'committed',
  payload: { passed_match: true, score: 1 },
};

const SWE_TASK_BODY = {
  schemaVersion: 'task.v1',
  solverNetManifestCid: 'bafyManifestSweA',
  spec: { instance_id: 'sympy__sympy-27510' },
};

describe('enrichBatch', () => {
  it('writes the full #669 field set with enrichmentStatus=ok and the anchor block', async () => {
    await seedEvalAnchor('bafyeval', 41_500_000n);
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes('bafytask')) {
        return { ok: true, status: 200, json: async () => SWE_TASK_BODY };
      }
      return { ok: true, status: 200, json: async () => SWE_VERDICT_BODY };
    };
    const result = await enrichBatch(store, depsWith(fetchImpl));
    expect(result.enriched).toBe(1);

    const row = await readVerdict(REQUEST_ID);
    expect(row).toMatchObject({
      request_id: REQUEST_ID,
      instance_id: 'sympy__sympy-27510',
      solver_net_manifest_cid: 'bafyManifestSweA',
      actual_passed: true,
      actual_score: '1',
      evaluator_verdict: 'PASS',
      enrichment_status: 'ok',
      solver_type: 'swe-rebench-v2.v1',
    });
    expect(String(row?.enriched_at_block)).toBe('41500000');
  });

  it('does NOT fetch the task body for a non-swe-rebench-v2 verdict (instanceId stays empty)', async () => {
    await seedEvalAnchor('bafyeval', 41_500_000n);
    const genericBody = {
      schemaVersion: 'jinn.execution.v1',
      role: 'verdict',
      solverType: 'prediction.v0',
      task: { requestId: REQUEST_ID, taskId: '7', attemptIndex: 0 },
      payload: { verdict: 'PASS' },
    };
    let taskFetched = false;
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes('bafytask')) {
        taskFetched = true;
        return { ok: true, status: 200, json: async () => SWE_TASK_BODY };
      }
      return { ok: true, status: 200, json: async () => genericBody };
    };
    await enrichBatch(store, depsWith(fetchImpl));
    expect(taskFetched).toBe(false);
    const row = await readVerdict(REQUEST_ID);
    expect(row?.instance_id).toBe('');
    expect(row?.evaluator_verdict).toBe('PASS');
    expect(row?.enrichment_status).toBe('ok');
  });

  it('leaves NO row and keeps the CID re-discoverable when the verdict body fetch throws', async () => {
    await seedEvalAnchor('bafyeval', 41_500_000n);
    const fetchImpl: FetchLike = async () => {
      throw new Error('IPFS offline');
    };
    const result = await enrichBatch(store, depsWith(fetchImpl));
    expect(result.enriched).toBe(0);

    // No row written (we have no requestId without the body).
    const res = await h.db.execute(
      sql`SELECT count(*)::int AS c FROM ${sql.raw(`"${h.schema}"."verdict_envelope_meta"`)}`,
    );
    expect((res.rows[0] as { c: number }).c).toBe(0);

    // The anchor is still discoverable for a natural retry next tick.
    const due = await store.discoverDue(25, 1_000_000);
    expect(due.map((d) => d.manifestCid)).toContain('bafyeval');
  });

  it('graceful-degrades to ok + instanceId="" when the verdict parses but the task-body fetch fails (matches the handler)', async () => {
    await seedEvalAnchor('bafyeval', 41_500_000n);
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes('bafytask')) throw new Error('task body offline');
      return { ok: true, status: 200, json: async () => SWE_VERDICT_BODY };
    };
    const result = await enrichBatch(store, depsWith(fetchImpl));
    // The handler catches the task-fetch error, warns, leaves instanceId='' /
    // solverNetManifestCid='', and writes the verdict row with status 'ok'. The
    // worker must do the SAME (behaviour-preserving refactor, #779). NOT a retry row.
    expect(result.enriched).toBe(1);

    const row = await readVerdict(REQUEST_ID);
    expect(row?.enrichment_status).toBe('ok');
    expect(row?.instance_id).toBe('');
    expect(row?.solver_net_manifest_cid).toBe('');
    // The verdict fields still land (we had the verdict body).
    expect(row?.evaluator_verdict).toBe('PASS');
    // instanceId='' → the launcher's `instanceId_not:""` filter shape excludes
    // this partial row from success counts, exactly as today.
    expect(row?.instance_id).toBe('');
  });
});

// ── AC6: idempotency ──────────────────────────────────────────────────────────

describe('idempotency (AC6)', () => {
  it('re-running against an all-ok backlog does zero fetches and zero writes', async () => {
    await seedEvalAnchor('bafyeval', 41_500_000n);
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes('bafytask')) {
        return { ok: true, status: 200, json: async () => SWE_TASK_BODY };
      }
      return { ok: true, status: 200, json: async () => SWE_VERDICT_BODY };
    };
    // First run enriches it.
    await enrichBatch(store, depsWith(fetchImpl));

    // Second run: discovery must NOT return the now-ok CID, so the worker never
    // even fetches it.
    let fetchCount = 0;
    const countingFetch: FetchLike = async (url) => {
      fetchCount += 1;
      return fetchImpl(url);
    };
    const result = await enrichBatch(store, depsWith(countingFetch));
    expect(result.discovered).toBe(0);
    expect(result.enriched).toBe(0);
    expect(fetchCount).toBe(0);
  });

  it('a forced upsert at an older/equal block leaves the ok row field-for-field unchanged', async () => {
    const okRow = {
      requestId: REQUEST_ID,
      verdictIndex: 0,
      attemptIndex: 1,
      taskId: '42',
      evaluator: `0x${'bb'.repeat(20)}`,
      manifestCid: 'bafyeval',
      solverType: 'swe-rebench-v2.v1',
      evidenceTier: 'committed',
      actualPassed: true,
      actualScore: '1',
      passedCount: 0,
      totalCount: 0,
      instanceId: 'sympy__sympy-27510',
      solverNetManifestCid: 'bafyManifestSweA',
      evaluatorVerdict: 'PASS' as const,
      enrichedAtBlock: 41_500_000n,
      chainId: CHAIN_ID,
    };
    await store.upsertVerdict(okRow);
    const before = await readVerdict(REQUEST_ID);
    // Replay at an OLDER block with different field values → guarded no-op.
    await store.upsertVerdict({ ...okRow, instanceId: 'STALE', actualPassed: false, enrichedAtBlock: 41_400_000n });
    const after = await readVerdict(REQUEST_ID);
    expect(after).toEqual(before);
  });
});

// ── AC4 / #669: partial-enrichment matches the handler's graceful degrade ──────

describe('#669 partial-enrichment guard (AC4)', () => {
  it('task body present but missing instance_id → ok with instanceId="" (filtered by instanceId_not:"")', async () => {
    await seedEvalAnchor('bafyeval', 41_500_000n);
    const taskBodyNoInstance = { schemaVersion: 'task.v1', solverNetManifestCid: 'bafyManifestSweA', spec: {} };
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).includes('bafytask')) {
        return { ok: true, status: 200, json: async () => taskBodyNoInstance };
      }
      return { ok: true, status: 200, json: async () => SWE_VERDICT_BODY };
    };
    await enrichBatch(store, depsWith(fetchImpl));
    const row = await readVerdict(REQUEST_ID);
    // Matches handler graceful-degrade: status flips to ok, instanceId stays ''.
    // The launcher's instanceId_not:"" filter then excludes it from success
    // counts — the anti-farming property holds with the filter unchanged.
    expect(row?.enrichment_status).toBe('ok');
    expect(row?.instance_id).toBe('');
    expect(row?.solver_net_manifest_cid).toBe('bafyManifestSweA');
  });
});
