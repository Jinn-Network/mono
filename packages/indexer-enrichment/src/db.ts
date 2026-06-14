/**
 * Postgres access for the verdict-envelope enrichment worker (#779).
 *
 * The worker is a third process on the indexer's Ponder DATABASE_SCHEMA (the
 * indexer already runs `ponder start` + `ponder serve` replicas on the same
 * schema — this is the sanctioned-replica pattern, see the indexer deploy
 * README). It READS the `envelope` + `verdict_envelope_meta` tables and WRITES
 * ONLY `verdict_envelope_meta` — never Ponder's reorg/checkpoint bookkeeping.
 *
 * All statements are schema-qualified by DATABASE_SCHEMA. Discovery uses
 * `FOR UPDATE SKIP LOCKED` so two worker instances never double-process a CID.
 *
 * The store is constructed with an injected Drizzle instance so tests run it
 * against PGlite (a real Postgres engine, handbook rule 6) and production runs
 * it against `pg`'s `Pool` via `drizzle-orm/node-postgres` — identical SQL.
 */
import { sql } from 'drizzle-orm';

/** Minimal structural surface of a Drizzle pg client we use (PGlite + node-postgres both satisfy it). */
export interface DrizzleLike {
  execute: (query: unknown) => Promise<{ rows: Record<string, unknown>[] }>;
  transaction: <T>(fn: (tx: DrizzleLike) => Promise<T>) => Promise<T>;
}

/** A due anchor: an evaluation envelope with no `ok` verdict row (or a due retry). */
export interface DueAnchor {
  manifestCid: string;
  publishedAtBlock: bigint;
}

export interface UpsertVerdictArgs {
  requestId: string;
  verdictIndex: number;
  attemptIndex: number;
  taskId: string;
  evaluator: string;
  manifestCid: string;
  solverType: string;
  evidenceTier: string;
  actualPassed: boolean;
  actualScore: string;
  passedCount: number;
  totalCount: number;
  instanceId: string;
  solverNetManifestCid: string;
  evaluatorVerdict: string;
  enrichedAtBlock: bigint;
  chainId: number;
}

export class EnrichmentStore {
  constructor(
    private readonly db: DrizzleLike,
    private readonly schema: string,
  ) {}

  private q(table: string): ReturnType<typeof sql.raw> {
    // Schema is operator-supplied env, not user input; quote it defensively.
    return sql.raw(`"${this.schema}"."${table}"`);
  }

  /**
   * Tolerate the schema not yet existing (fresh deploy / O3 rolling cutover):
   * a read against a missing schema must surface as "not ready, back off",
   * never crash the process. Returns true once the worker's tables resolve.
   */
  async ready(): Promise<boolean> {
    try {
      await this.db.execute(sql`SELECT 1 FROM ${this.q('verdict_envelope_meta')} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discover un-enriched, due evaluation anchors. An anchor is due when it is an
   * `evaluation` envelope and has NO `ok` verdict_envelope_meta row joined by
   * manifest_cid, AND (for any existing verdict row) the row is in
   * ('pending','retry') with nextAttemptAt null-or-past. The worker no longer
   * WRITES 'retry' rows (it graceful-degrades to 'ok' like the handler), but the
   * 'retry'/'pending' branch is kept so any such pre-existing rows still get
   * re-discovered — it is cheap and harmless.
   *
   * `now` is epoch-ms (matches nextAttemptAt's unit). Bounded by `batchSize`.
   * The select is `FOR UPDATE OF e SKIP LOCKED` — it locks the `envelope` (anchor)
   * side, NOT the nullable verdict side (Postgres rejects FOR UPDATE on the
   * LEFT JOIN's nullable side). Two workers therefore claim disjoint anchor sets.
   */
  async discoverDue(batchSize: number, now: number | bigint): Promise<DueAnchor[]> {
    return this.runDiscover(this.db, batchSize, now);
  }

  /**
   * Run discovery inside a held-open transaction and pass the locked rows to
   * `body`; the locks are released when `body` resolves and the txn commits.
   * Used to prove SKIP LOCKED disjointness in tests, and available to the
   * worker if it ever wants claim+process in one txn.
   */
  async withLockedDue<T>(
    batchSize: number,
    now: number | bigint,
    body: (rows: DueAnchor[]) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const rows = await this.runDiscover(tx, batchSize, now);
      return body(rows);
    });
  }

  private async runDiscover(
    exec: DrizzleLike,
    batchSize: number,
    now: number | bigint,
  ): Promise<DueAnchor[]> {
    const nowMs = BigInt(now);
    const res = await exec.execute(sql`
      SELECT e."manifest_cid" AS manifest_cid, e."published_at_block" AS published_at_block
      FROM ${this.q('envelope')} e
      LEFT JOIN ${this.q('verdict_envelope_meta')} v
        ON v."manifest_cid" = e."manifest_cid"
      WHERE e."kind" = 'evaluation'
        AND (
          v."request_id" IS NULL
          OR (
            v."enrichment_status" IN ('pending', 'retry')
            AND (v."next_attempt_at" IS NULL OR v."next_attempt_at" <= ${nowMs})
          )
        )
      ORDER BY e."published_at_block" ASC
      LIMIT ${batchSize}
      FOR UPDATE OF e SKIP LOCKED
    `);
    return res.rows.map((r) => ({
      manifestCid: String(r.manifest_cid),
      publishedAtBlock: BigInt(String(r.published_at_block)),
    }));
  }

  /**
   * Upsert a fully-enriched verdict row keyed (request_id, chain_id), guarded by
   * enriched_at_block most-recent-wins — mirrors the handler's onConflictDoUpdate
   * (handlers.ts). On a newer/equal block the row is overwritten with
   * enrichment_status='ok' and retry bookkeeping cleared; on an older block it is
   * a no-op (AC6).
   */
  async upsertVerdict(args: UpsertVerdictArgs): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO ${this.q('verdict_envelope_meta')}
        ("request_id","verdict_index","attempt_index","task_id","evaluator","manifest_cid","solver_type","evidence_tier","actual_passed","actual_score","passed_count","total_count","instance_id","solver_net_manifest_cid","evaluator_verdict","enrichment_status","retry_count","next_attempt_at","enriched_at_block","chain_id")
      VALUES (
        ${args.requestId}, ${args.verdictIndex}, ${args.attemptIndex}, ${args.taskId}, ${args.evaluator},
        ${args.manifestCid}, ${args.solverType}, ${args.evidenceTier}, ${args.actualPassed}, ${args.actualScore},
        ${args.passedCount}, ${args.totalCount}, ${args.instanceId}, ${args.solverNetManifestCid}, ${args.evaluatorVerdict},
        'ok', 0, NULL, ${args.enrichedAtBlock}, ${args.chainId}
      )
      ON CONFLICT ("request_id","chain_id") DO UPDATE SET
        "verdict_index" = EXCLUDED."verdict_index",
        "attempt_index" = EXCLUDED."attempt_index",
        "task_id" = EXCLUDED."task_id",
        "evaluator" = EXCLUDED."evaluator",
        "manifest_cid" = EXCLUDED."manifest_cid",
        "solver_type" = EXCLUDED."solver_type",
        "evidence_tier" = EXCLUDED."evidence_tier",
        "actual_passed" = EXCLUDED."actual_passed",
        "actual_score" = EXCLUDED."actual_score",
        "passed_count" = EXCLUDED."passed_count",
        "total_count" = EXCLUDED."total_count",
        "instance_id" = EXCLUDED."instance_id",
        "solver_net_manifest_cid" = EXCLUDED."solver_net_manifest_cid",
        "evaluator_verdict" = EXCLUDED."evaluator_verdict",
        "enrichment_status" = 'ok',
        "retry_count" = 0,
        "next_attempt_at" = NULL,
        "enriched_at_block" = EXCLUDED."enriched_at_block"
      WHERE EXCLUDED."enriched_at_block" >= ${this.q('verdict_envelope_meta')}."enriched_at_block"
    `);
  }
}
