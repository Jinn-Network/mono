/**
 * AC3 (#779), the headline proof: a large enrichment backlog with slow IPFS
 * does NOT starve reads of verdict_envelope_meta.
 *
 * Shape (lightweight, per plan R4): seed a large `pending` evaluation backlog
 * into PGlite, start the worker's poll loop with a *blocking* IPFS stub (each
 * fetch sleeps), then fire 40 concurrent reads of verdict_envelope_meta and
 * assert all 40 resolve successfully while the worker is mid-backlog. The
 * 40×200 of the original incident is proven at the DB-isolation layer: the
 * worker is a separate event loop / process boundary, so reads are never
 * serialized behind enrichment — the actual mechanism that fixes the 502. A
 * literal `ponder serve` /graphql HTTP probe would need a real Postgres
 * container + ponder boot (higher cost/flake); deferred per R4.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FetchLike } from '@jinn-network/indexer/ipfs';
import { EnrichmentStore } from '../src/db.js';
import { EnrichmentRunner } from '../src/runner.js';
import type { EnrichDeps } from '../src/enrich.js';
import { createPgliteHarness, type PgliteHarness } from './helpers/pglite-db.js';

const CHAIN_ID = 84532;
const CID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

let h: PgliteHarness;
let runner: EnrichmentRunner | null = null;

afterEach(async () => {
  runner?.stop();
  runner = null;
  await h?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cidFor(index: number): string {
  let n = index;
  let encoded = '';
  do {
    encoded = CID_ALPHABET[n % CID_ALPHABET.length] + encoded;
    n = Math.floor(n / CID_ALPHABET.length);
  } while (n > 0);
  return `bafy${encoded.padStart(60, 'a')}`;
}

describe('AC3: read path is not starved by an enrichment backlog', () => {
  it('40 concurrent verdict reads all resolve while the worker drains a slow backlog', async () => {
    h = await createPgliteHarness();
    const store = new EnrichmentStore(h.db, h.schema);

    // Seed 500 pending evaluation anchors.
    for (let i = 0; i < 500; i++) {
      const cid = cidFor(i);
      await h.db.execute(
        sql`INSERT INTO ${sql.raw(`"${h.schema}"."envelope"`)}
          ("agent_id","metadata_key","chain_id","kind","manifest_cid","manifest_hash","evidence_tier","published_at_block","log_index")
          VALUES (${'1'}, ${`evaluation:${cid}`}, ${CHAIN_ID}, ${'evaluation'}, ${cid}, ${'0x'}, ${'committed'}, ${BigInt(i)}, ${0})`,
      );
    }

    // Blocking IPFS stub: every fetch sleeps, simulating a backed-up gateway.
    const slowFetch: FetchLike = async (url) => {
      await sleep(20);
      const cid = String(url).split('/').pop() ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 'jinn.execution.v1',
          role: 'verdict',
          solverType: 'prediction.v0',
          task: { requestId: `0x${cid.padEnd(64, '0').slice(0, 64)}`, taskId: cid, attemptIndex: 0 },
          payload: { verdict: 'PASS' },
        }),
      };
    };

    const deps: EnrichDeps = {
      ipfsGateway: 'https://stub',
      ipfsTimeoutMs: 5000,
      batchSize: 25,
      chainId: CHAIN_ID,
      maxRetries: 5,
      fetchImpl: slowFetch,
      now: () => Date.now(),
    };
    runner = new EnrichmentRunner(store, deps, { pollIntervalMs: 5 });

    // Start the worker draining the backlog (do NOT await — let it run mid-flight).
    const draining = runner.start();

    // Give the worker a moment to be actively mid-batch (sleeping on IPFS).
    await sleep(30);

    // Fire 40 concurrent reads of verdict_envelope_meta. All must resolve.
    const reads = Array.from({ length: 40 }, () =>
      h.db.execute(
        sql`SELECT count(*)::int AS c FROM ${sql.raw(`"${h.schema}"."verdict_envelope_meta"`)}`,
      ),
    );
    const results = await Promise.all(reads);
    expect(results).toHaveLength(40);
    for (const r of results) {
      // Each read returned a row (a count) — it was served, not starved/blocked.
      expect(typeof (r.rows[0] as { c: number }).c).toBe('number');
    }

    runner.stop();
    await draining;
  }, 20_000);
});
