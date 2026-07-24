import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { envelope, verdictEnvelopeMeta } from '@jinn-network/indexer/schema';
import { EnrichmentStore } from '../src/db.js';
import { createPgliteHarness, tableColumnNames, type PgliteHarness } from './helpers/pglite-db.js';

const CHAIN_ID = 84532;

let h: PgliteHarness;
let store: EnrichmentStore;

beforeEach(async () => {
  h = await createPgliteHarness();
  store = new EnrichmentStore(h.db, h.schema);
});

afterEach(async () => {
  await h.close();
});

// ── Seed helpers (raw inserts, schema-qualified) ──────────────────────────────

async function seedEnvelope(args: {
  agentId: string;
  cid: string;
  kind: 'envelope' | 'evaluation' | 'capture';
  publishedAtBlock: bigint;
  logIndex?: number;
  chainId?: number;
}): Promise<void> {
  await h.db.execute(
    sql`INSERT INTO ${sql.raw(`"${h.schema}"."envelope"`)}
      ("agent_id","metadata_key","chain_id","kind","manifest_cid","manifest_hash","evidence_tier","published_at_block","log_index")
      VALUES (${args.agentId}, ${`${args.kind}:${args.cid}`}, ${args.chainId ?? CHAIN_ID}, ${args.kind}, ${args.cid}, ${'0x'}, ${'committed'}, ${args.publishedAtBlock}, ${args.logIndex ?? 0})`,
  );
}

async function seedVerdict(args: {
  requestId: string;
  manifestCid: string;
  enrichmentStatus: string;
  enrichedAtBlock: bigint;
  nextAttemptAt?: bigint | null;
  retryCount?: number;
  actualScore?: string;
  publisherAgentId?: string;
  manifestHash?: string;
  chainId?: number;
}): Promise<void> {
  await h.db.execute(
    sql`INSERT INTO ${sql.raw(`"${h.schema}"."verdict_envelope_meta"`)}
      ("request_id","verdict_index","attempt_index","task_id","evaluator","manifest_cid","publisher_agent_id","manifest_hash","solver_type","evidence_tier","actual_passed","actual_score","passed_count","total_count","instance_id","solver_net_manifest_cid","evaluator_verdict","enrichment_status","retry_count","next_attempt_at","enriched_at_block","chain_id")
      VALUES (${args.requestId}, ${0}, ${0}, ${''}, ${'0x'}, ${args.manifestCid}, ${args.publisherAgentId ?? '1'}, ${args.manifestHash ?? '0x'}, ${''}, ${''}, ${false}, ${args.actualScore ?? ''}, ${0}, ${0}, ${''}, ${''}, ${'UNKNOWN'}, ${args.enrichmentStatus}, ${args.retryCount ?? 0}, ${args.nextAttemptAt ?? null}, ${args.enrichedAtBlock}, ${args.chainId ?? CHAIN_ID})`,
  );
}

// ── Column parity (guards against silent schema drift; R1 belt-and-suspenders)

describe('schema parity', () => {
  it('the worker types its writes against the real ponder.schema.ts tables', () => {
    // The worker imports the live Drizzle tables; this asserts the columns the
    // worker writes exist on the real schema so a future column rename fails
    // here rather than at runtime in production.
    const cols = tableColumnNames(verdictEnvelopeMeta);
    for (const required of [
      'request_id',
      'publisher_agent_id',
      'manifest_hash',
      'instance_id',
      'solver_net_manifest_cid',
      'solution_request_id',
      'actual_passed',
      'actual_score',
      'evaluator_verdict',
      'enrichment_status',
      'retry_count',
      'next_attempt_at',
      'enriched_at_block',
      'chain_id',
    ]) {
      expect(cols).toContain(required);
    }
    expect(tableColumnNames(envelope)).toContain('published_at_block');
  });
});

// ── discoverDue ───────────────────────────────────────────────────────────────

describe('discoverDue', () => {
  it('returns un-enriched evaluation anchors and excludes ok / future-retry / failed / execution', async () => {
    const now = 1_000_000n;
    // (a) un-enriched eval anchor → appears
    await seedEnvelope({ agentId: '1', cid: 'cidA', kind: 'evaluation', publishedAtBlock: 10n });
    // (b) eval anchor with ok verdict → excluded
    await seedEnvelope({ agentId: '1', cid: 'cidB', kind: 'evaluation', publishedAtBlock: 11n });
    await seedVerdict({ requestId: '0xbb', manifestCid: 'cidB', enrichmentStatus: 'ok', enrichedAtBlock: 11n });
    // (c) eval anchor with retry row due now → appears
    await seedEnvelope({ agentId: '1', cid: 'cidC', kind: 'evaluation', publishedAtBlock: 12n });
    await seedVerdict({ requestId: '0xcc', manifestCid: 'cidC', enrichmentStatus: 'retry', enrichedAtBlock: 12n, nextAttemptAt: now - 1n });
    // (d) retry row with nextAttemptAt in the future → excluded
    await seedEnvelope({ agentId: '1', cid: 'cidD', kind: 'evaluation', publishedAtBlock: 13n });
    await seedVerdict({ requestId: '0xdd', manifestCid: 'cidD', enrichmentStatus: 'retry', enrichedAtBlock: 13n, nextAttemptAt: now + 100_000n });
    // (e) failed row → excluded
    await seedEnvelope({ agentId: '1', cid: 'cidE', kind: 'evaluation', publishedAtBlock: 14n });
    await seedVerdict({ requestId: '0xee', manifestCid: 'cidE', enrichmentStatus: 'failed', enrichedAtBlock: 14n });
    // (f) execution envelope (kind='envelope') → excluded (not the verdict path)
    await seedEnvelope({ agentId: '1', cid: 'cidF', kind: 'envelope', publishedAtBlock: 15n });

    const due = await store.discoverDue(100, now);
    const cids = due.map((d) => d.manifestCid).sort();
    expect(cids).toEqual(['cidA', 'cidC']);
  });

  it('returns the anchor publishedAtBlock so the worker can guard the upsert', async () => {
    await seedEnvelope({ agentId: '1', cid: 'cidA', kind: 'evaluation', publishedAtBlock: 99n });
    const due = await store.discoverDue(100, 1_000_000n);
    expect(due).toHaveLength(1);
    expect(due[0]?.manifestCid).toBe('cidA');
    expect(due[0]?.publishedAtBlock).toBe(99n);
    expect(due[0]?.publisherAgentId).toBe('1');
    expect(due[0]?.manifestHash).toBe('0x');
  });

  it('honours the batch size', async () => {
    for (let i = 0; i < 5; i++) {
      await seedEnvelope({ agentId: '1', cid: `cid${i}`, kind: 'evaluation', publishedAtBlock: BigInt(10 + i) });
    }
    const due = await store.discoverDue(3, 1_000_000n);
    expect(due).toHaveLength(3);
  });

  it('does not let an ok verdict on chain A suppress the same CID anchor on chain B', async () => {
    const otherChainId = 1;
    await seedEnvelope({
      agentId: '1',
      cid: 'sharedCid',
      kind: 'evaluation',
      publishedAtBlock: 10n,
      chainId: CHAIN_ID,
    });
    await seedEnvelope({
      agentId: '1',
      cid: 'sharedCid',
      kind: 'evaluation',
      publishedAtBlock: 11n,
      chainId: otherChainId,
    });
    await seedVerdict({
      requestId: '0xchaina',
      manifestCid: 'sharedCid',
      publisherAgentId: '1',
      enrichmentStatus: 'ok',
      enrichedAtBlock: 10n,
      chainId: CHAIN_ID,
    });

    const due = await store.discoverDue(100, 1_000_000n);
    expect(due).toEqual([
      expect.objectContaining({ manifestCid: 'sharedCid', chainId: otherChainId }),
    ]);
  });

  it('does not let one publisher suppress another publisher of the same CID on the same chain', async () => {
    await seedEnvelope({
      agentId: '1',
      cid: 'sharedPublisherCid',
      kind: 'evaluation',
      publishedAtBlock: 10n,
    });
    await seedEnvelope({
      agentId: '666',
      cid: 'sharedPublisherCid',
      kind: 'evaluation',
      publishedAtBlock: 11n,
    });
    await seedVerdict({
      requestId: '0xlegitimate',
      manifestCid: 'sharedPublisherCid',
      publisherAgentId: '1',
      enrichmentStatus: 'ok',
      enrichedAtBlock: 10n,
    });

    const due = await store.discoverDue(100, 1_000_000n);
    expect(due).toEqual([
      expect.objectContaining({
        manifestCid: 'sharedPublisherCid',
        publisherAgentId: '666',
        chainId: CHAIN_ID,
      }),
    ]);
  });

  it('uses FOR UPDATE SKIP LOCKED so concurrent workers claim disjoint sets', async () => {
    // PGlite is a single-connection engine, so true multi-session lock
    // disjointness cannot be exercised in-process (a second discoverDue on the
    // same connection would deadlock on the held locks, not skip them). What we
    // CAN prove against the real engine is that the discovery statement carries
    // a syntactically-valid `FOR UPDATE ... SKIP LOCKED` clause that Postgres
    // accepts and that the clause runs inside a held transaction — the two
    // ingredients that give cross-worker disjointness in production.
    for (let i = 0; i < 4; i++) {
      await seedEnvelope({ agentId: '1', cid: `cid${i}`, kind: 'evaluation', publishedAtBlock: BigInt(10 + i) });
    }
    // The clause is present in the emitted SQL (string-level guard against a
    // future refactor silently dropping it).
    expect(await captureDiscoverSql()).toMatch(/FOR UPDATE OF e\s+SKIP LOCKED/);

    // And the locking discovery executes successfully against the real engine
    // inside a transaction (proves the clause is accepted, not just present).
    const locked = await store.withLockedDue(2, 1_000_000n, async (rows) => rows.map((r) => r.manifestCid));
    expect(locked).toHaveLength(2);
  });
});

// ── worker-owned CID attempt state ────────────────────────────────────────────

describe('CID attempt state', () => {
  it('claimDue marks anchors as processing so a second worker cannot claim the same batch', async () => {
    await seedEnvelope({ agentId: '1', cid: 'bafyclaim0000000000000000000000000000000000000000000000000000000000', kind: 'evaluation', publishedAtBlock: 10n });

    const first = await store.claimDue(25, 1_000_000n, 60_000n);
    expect(first.map((r) => r.manifestCid)).toEqual([
      'bafyclaim0000000000000000000000000000000000000000000000000000000000',
    ]);

    const second = await store.claimDue(25, 1_000_000n, 60_000n);
    expect(second).toEqual([]);
  });

  it('markAttemptFailure backs off failed verdict-body fetches and eventually quarantines the CID', async () => {
    const cid = 'bafyfail00000000000000000000000000000000000000000000000000000000000';
    await seedEnvelope({ agentId: '1', cid, kind: 'evaluation', publishedAtBlock: 10n });
    await store.claimDue(25, 1_000_000n, 60_000n);

    await store.markAttemptFailure({
      manifestCid: cid,
      chainId: CHAIN_ID,
      now: 1_000_000n,
      maxRetries: 2,
      error: 'IPFS offline',
    });

    const backedOff = await store.discoverDue(25, 1_000_001n);
    expect(backedOff).toEqual([]);

    await store.markAttemptFailure({
      manifestCid: cid,
      chainId: CHAIN_ID,
      now: 2_000_000n,
      maxRetries: 2,
      error: 'IPFS still offline',
    });

    const failed = await store.discoverDue(25, 9_000_000n);
    expect(failed).toEqual([]);
  });
});

// ── upsertVerdict ─────────────────────────────────────────────────────────────

describe('upsertVerdict', () => {
  const baseRow = {
    requestId: '0xaa',
    verdictIndex: 0,
    attemptIndex: 1,
    taskId: '42',
    evaluator: '0xbb',
    manifestCid: 'cidA',
    publisherAgentId: '1',
    manifestHash: '0x',
    solverType: 'swe-rebench-v2.v1',
    evidenceTier: 'committed',
    actualPassed: true,
    actualScore: '1',
    passedCount: 0,
    totalCount: 0,
    instanceId: 'sympy__sympy-27510',
    solverNetManifestCid: 'bafyManifest',
    solutionRequestId: `0x${'99'.repeat(32)}`,
    evaluatorVerdict: 'PASS' as const,
  };

  it('inserts a full-field-set row with enrichmentStatus=ok', async () => {
    await store.upsertVerdict({ ...baseRow, enrichedAtBlock: 100n, chainId: CHAIN_ID });
    const row = await readVerdict('0xaa');
    expect(row).toMatchObject({
      request_id: '0xaa',
      instance_id: 'sympy__sympy-27510',
      solver_net_manifest_cid: 'bafyManifest',
      actual_passed: true,
      actual_score: '1',
      evaluator_verdict: 'PASS',
      enrichment_status: 'ok',
    });
    // PGlite returns bigint columns as strings.
    expect(String(row?.enriched_at_block)).toBe('100');
  });

  it('on conflict updates only when blockNumber is newer than existing.enrichedAtBlock', async () => {
    await store.upsertVerdict({ ...baseRow, enrichedAtBlock: 100n, chainId: CHAIN_ID });
    // older block → no-op
    await store.upsertVerdict({ ...baseRow, instanceId: 'STALE', actualScore: '0', enrichedAtBlock: 50n, chainId: CHAIN_ID });
    let row = await readVerdict('0xaa');
    expect(row?.instance_id).toBe('sympy__sympy-27510');
    expect(row?.actual_score).toBe('1');
    // equal block → also no-op, preserving the first complete enrichment if a
    // duplicate worker replays the same anchor with partial fields.
    await store.upsertVerdict({ ...baseRow, instanceId: 'EQUAL_STALE', actualScore: '0', enrichedAtBlock: 100n, chainId: CHAIN_ID });
    row = await readVerdict('0xaa');
    expect(row?.instance_id).toBe('sympy__sympy-27510');
    expect(row?.actual_score).toBe('1');
    // newer block → applies
    await store.upsertVerdict({ ...baseRow, instanceId: 'NEWER', enrichedAtBlock: 200n, chainId: CHAIN_ID });
    row = await readVerdict('0xaa');
    expect(row?.instance_id).toBe('NEWER');
    expect(String(row?.enriched_at_block)).toBe('200');
  });

  it('retains a later untrusted publisher/CID candidate for the same request', async () => {
    await store.upsertVerdict({
      ...baseRow,
      enrichedAtBlock: 100n,
      chainId: CHAIN_ID,
    });
    await store.upsertVerdict({
      ...baseRow,
      manifestCid: 'cidAttacker',
      publisherAgentId: '666',
      manifestHash: `0x${'66'.repeat(32)}`,
      actualPassed: false,
      evaluatorVerdict: 'FAIL',
      enrichedAtBlock: 200n,
      chainId: CHAIN_ID,
    });

    const rows = await readVerdicts('0xaa', CHAIN_ID);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        manifest_cid: 'cidA',
        publisher_agent_id: '1',
        actual_passed: true,
      }),
      expect.objectContaining({
        manifest_cid: 'cidAttacker',
        publisher_agent_id: '666',
        actual_passed: false,
      }),
    ]));
  });

  it('clears any retry bookkeeping when a row goes ok', async () => {
    await seedVerdict({ requestId: '0xaa', manifestCid: 'cidA', enrichmentStatus: 'retry', enrichedAtBlock: 90n, retryCount: 2, nextAttemptAt: 5n });
    await store.upsertVerdict({ ...baseRow, enrichedAtBlock: 100n, chainId: CHAIN_ID });
    const row = await readVerdict('0xaa');
    expect(row?.enrichment_status).toBe('ok');
    expect(row?.retry_count).toBe(0);
    expect(row?.next_attempt_at).toBeNull();
  });

  it('clearAttempt removes worker CID attempt state after a row goes ok', async () => {
    const cid = 'bafyok000000000000000000000000000000000000000000000000000000000000';
    await seedEnvelope({ agentId: '1', cid, kind: 'evaluation', publishedAtBlock: 100n });
    await store.claimDue(25, 1_000_000n, 60_000n);
    await store.upsertVerdict({ ...baseRow, manifestCid: cid, enrichedAtBlock: 100n, chainId: CHAIN_ID });
    await store.clearAttempt(cid, CHAIN_ID);

    const due = await store.discoverDue(25, 1_000_001n);
    expect(due).toEqual([]);
  });
});

/** Capture the SQL the store emits for discovery by spying on a one-shot exec. */
async function captureDiscoverSql(): Promise<string> {
  let captured = '';
  const spy = {
    async execute(query: unknown) {
      // Drizzle sql`` carries its raw text in queryChunks; stringify the whole
      // template — enough to assert the locking clause is present.
      captured = JSON.stringify(query, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      return { rows: [] };
    },
    async transaction() {
      throw new Error('not used');
    },
  };
  await new EnrichmentStore(spy as never, 'jinn_capture').discoverDue(1, 0n);
  return captured;
}

async function readVerdict(requestId: string): Promise<Record<string, unknown> | undefined> {
  const res = await h.db.execute(
    sql`SELECT * FROM ${sql.raw(`"${h.schema}"."verdict_envelope_meta"`)} WHERE "request_id" = ${requestId}`,
  );
  return (res.rows as Record<string, unknown>[])[0];
}

async function readVerdicts(
  requestId: string,
  chainId: number,
): Promise<Record<string, unknown>[]> {
  const res = await h.db.execute(
    sql`SELECT * FROM ${sql.raw(`"${h.schema}"."verdict_envelope_meta"`)}
        WHERE "request_id" = ${requestId} AND "chain_id" = ${chainId}
        ORDER BY "manifest_cid"`,
  );
  return res.rows as Record<string, unknown>[];
}
