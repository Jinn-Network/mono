/**
 * Postgres access for the verdict-envelope enrichment worker (#779).
 *
 * The worker is a third process on the indexer's Ponder DATABASE_SCHEMA (the
 * indexer already runs `ponder start` + `ponder serve` replicas on the same
 * schema — this is the sanctioned-replica pattern, see the indexer deploy
 * README). It READS the `envelope` + `verdict_envelope_meta` tables and WRITES
 * `verdict_envelope_meta` plus the worker-owned `enrichment_attempt` table —
 * never Ponder's reorg/checkpoint bookkeeping.
 *
 * All statements are schema-qualified by DATABASE_SCHEMA. The worker owns one
 * small CID-keyed attempt table to make claim/backoff state durable before the
 * verdict body has yielded a requestId.
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
  publisherAgentId: string;
  manifestHash: string;
  publishedAtBlock: bigint;
  chainId: number;
}

export interface UpsertVerdictArgs {
  requestId: string;
  verdictIndex: number;
  attemptIndex: number;
  taskId: string;
  evaluator: string;
  manifestCid: string;
  publisherAgentId: string;
  manifestHash: string;
  solverType: string;
  evidenceTier: string;
  actualPassed: boolean;
  actualScore: string;
  passedCount: number;
  totalCount: number;
  instanceId: string;
  solverNetManifestCid: string;
  solutionRequestId: string;
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

  async ensureWorkerTables(): Promise<void> {
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${this.q('enrichment_attempt')} (
        "manifest_cid" text NOT NULL,
        "chain_id" integer NOT NULL,
        "status" text NOT NULL,
        "retry_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" bigint,
        "last_error" text NOT NULL DEFAULT '',
        "updated_at" bigint NOT NULL DEFAULT 0,
        PRIMARY KEY ("manifest_cid", "chain_id")
      )
    `);
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS "enrichment_attempt_status_due_idx"
        ON ${this.q('enrichment_attempt')} ("status", "next_attempt_at")
    `);
  }

  /**
   * Tolerate the schema not yet existing (fresh deploy / O3 rolling cutover):
   * a read against a missing schema must surface as "not ready, back off",
   * never crash the process. Returns true once the worker's tables resolve.
   */
  async ready(): Promise<boolean> {
    try {
      await this.db.execute(sql`SELECT 1 FROM ${this.q('verdict_envelope_meta')} LIMIT 1`);
      await this.db.execute(sql`SELECT 1 FROM ${this.q('enrichment_attempt')} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discover un-enriched, due evaluation anchors. An anchor is due when it is an
   * `evaluation` envelope and has NO `ok` verdict_envelope_meta row joined by
   * manifest_cid, AND (for any existing verdict row) the row is in
   * ('pending','retry') with nextAttemptAt null-or-past, AND the worker-owned
   * attempt state is absent or due. Failed attempts are quarantined; processing
   * attempts become due again only after their lease expires.
   *
   * `now` is epoch-ms (matches nextAttemptAt's unit). Bounded by `batchSize`.
   */
  async discoverDue(batchSize: number, now: number | bigint): Promise<DueAnchor[]> {
    return this.runDiscover(this.db, batchSize, now);
  }

  async claimDue(batchSize: number, now: number | bigint, leaseMs: number | bigint): Promise<DueAnchor[]> {
    const nowMs = BigInt(now);
    const leaseUntil = nowMs + BigInt(leaseMs);
    return this.db.transaction(async (tx) => {
      const rows = await this.runDiscover(tx, batchSize, nowMs);
      for (const row of rows) {
        await tx.execute(sql`
          INSERT INTO ${this.q('enrichment_attempt')}
            ("manifest_cid","chain_id","status","retry_count","next_attempt_at","last_error","updated_at")
          VALUES (${row.manifestCid}, ${row.chainId}, 'processing', 0, ${leaseUntil}, '', ${nowMs})
          ON CONFLICT ("manifest_cid","chain_id") DO UPDATE SET
            "status" = 'processing',
            "next_attempt_at" = ${leaseUntil},
            "updated_at" = ${nowMs}
          WHERE ${this.q('enrichment_attempt')}."status" != 'failed'
        `);
      }
      return rows;
    });
  }

  /** Test-only helper for proving transactional discovery still emits valid locking SQL. */
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
      SELECT e."manifest_cid" AS manifest_cid,
             e."agent_id" AS publisher_agent_id,
             e."manifest_hash" AS manifest_hash,
             e."published_at_block" AS published_at_block,
             e."chain_id" AS chain_id
      FROM ${this.q('envelope')} e
      LEFT JOIN ${this.q('verdict_envelope_meta')} v
        ON v."manifest_cid" = e."manifest_cid"
       AND v."publisher_agent_id" = e."agent_id"
       AND v."chain_id" = e."chain_id"
      LEFT JOIN ${this.q('enrichment_attempt')} a
        ON a."manifest_cid" = e."manifest_cid" AND a."chain_id" = e."chain_id"
      WHERE e."kind" = 'evaluation'
        AND (
          v."request_id" IS NULL
          OR (
            v."enrichment_status" IN ('pending', 'retry')
            AND (v."next_attempt_at" IS NULL OR v."next_attempt_at" <= ${nowMs})
          )
        )
        AND (
          a."manifest_cid" IS NULL
          OR (
            a."status" IN ('retry', 'processing')
            AND (a."next_attempt_at" IS NULL OR a."next_attempt_at" <= ${nowMs})
          )
        )
      ORDER BY e."published_at_block" ASC
      LIMIT ${batchSize}
      FOR UPDATE OF e SKIP LOCKED
    `);
    return res.rows.map((r) => ({
      manifestCid: String(r.manifest_cid),
      publisherAgentId: String(r.publisher_agent_id),
      manifestHash: String(r.manifest_hash),
      publishedAtBlock: BigInt(String(r.published_at_block)),
      chainId: Number(r.chain_id),
    }));
  }

  async markAttemptFailure(args: {
    manifestCid: string;
    chainId: number;
    now: number | bigint;
    maxRetries: number;
    error: string;
  }): Promise<void> {
    const nowMs = BigInt(args.now);
    const current = await this.db.execute(sql`
      SELECT "retry_count" AS retry_count
      FROM ${this.q('enrichment_attempt')}
      WHERE "manifest_cid" = ${args.manifestCid} AND "chain_id" = ${args.chainId}
      LIMIT 1
    `);
    const attempts = Number(current.rows[0]?.retry_count ?? 0) + 1;
    const terminal = attempts >= Math.max(1, args.maxRetries);
    const nextAttemptAt = terminal ? null : nowMs + this.backoffMs(attempts);
    await this.db.execute(sql`
      INSERT INTO ${this.q('enrichment_attempt')}
        ("manifest_cid","chain_id","status","retry_count","next_attempt_at","last_error","updated_at")
      VALUES (
        ${args.manifestCid}, ${args.chainId}, ${terminal ? 'failed' : 'retry'},
        ${attempts}, ${nextAttemptAt}, ${args.error.slice(0, 500)}, ${nowMs}
      )
      ON CONFLICT ("manifest_cid","chain_id") DO UPDATE SET
        "status" = EXCLUDED."status",
        "retry_count" = EXCLUDED."retry_count",
        "next_attempt_at" = EXCLUDED."next_attempt_at",
        "last_error" = EXCLUDED."last_error",
        "updated_at" = EXCLUDED."updated_at"
    `);
  }

  async clearAttempt(manifestCid: string, chainId: number): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM ${this.q('enrichment_attempt')}
      WHERE "manifest_cid" = ${manifestCid} AND "chain_id" = ${chainId}
    `);
  }

  private backoffMs(attempts: number): bigint {
    return BigInt(Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 900_000));
  }

  /**
   * Upsert a fully-enriched verdict candidate keyed by
   * (request_id, publisher_agent_id, manifest_cid, chain_id), guarded by
   * enriched_at_block most-recent-wins — mirrors the handler's
   * onConflictDoUpdate (handlers.ts). Competing publisher/CID anchors remain
   * separate rows. On a newer block the exact candidate is updated with
   * enrichment_status='ok' and retry bookkeeping cleared; on an older or equal
   * block it is a no-op (AC6).
   */
  async upsertVerdict(args: UpsertVerdictArgs): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO ${this.q('verdict_envelope_meta')}
        ("request_id","verdict_index","attempt_index","task_id","evaluator","manifest_cid","publisher_agent_id","manifest_hash","solver_type","evidence_tier","actual_passed","actual_score","passed_count","total_count","instance_id","solver_net_manifest_cid","solution_request_id","evaluator_verdict","enrichment_status","retry_count","next_attempt_at","enriched_at_block","chain_id")
      VALUES (
        ${args.requestId}, ${args.verdictIndex}, ${args.attemptIndex}, ${args.taskId}, ${args.evaluator},
        ${args.manifestCid}, ${args.publisherAgentId}, ${args.manifestHash}, ${args.solverType}, ${args.evidenceTier}, ${args.actualPassed}, ${args.actualScore},
        ${args.passedCount}, ${args.totalCount}, ${args.instanceId}, ${args.solverNetManifestCid}, ${args.solutionRequestId}, ${args.evaluatorVerdict},
        'ok', 0, NULL, ${args.enrichedAtBlock}, ${args.chainId}
      )
      ON CONFLICT ("request_id","publisher_agent_id","manifest_cid","chain_id") DO UPDATE SET
        "verdict_index" = EXCLUDED."verdict_index",
        "attempt_index" = EXCLUDED."attempt_index",
        "task_id" = EXCLUDED."task_id",
        "evaluator" = EXCLUDED."evaluator",
        "manifest_hash" = EXCLUDED."manifest_hash",
        "solver_type" = EXCLUDED."solver_type",
        "evidence_tier" = EXCLUDED."evidence_tier",
        "actual_passed" = EXCLUDED."actual_passed",
        "actual_score" = EXCLUDED."actual_score",
        "passed_count" = EXCLUDED."passed_count",
        "total_count" = EXCLUDED."total_count",
        "instance_id" = EXCLUDED."instance_id",
        "solver_net_manifest_cid" = EXCLUDED."solver_net_manifest_cid",
        "solution_request_id" = EXCLUDED."solution_request_id",
        "evaluator_verdict" = EXCLUDED."evaluator_verdict",
        "enrichment_status" = 'ok',
        "retry_count" = 0,
        "next_attempt_at" = NULL,
        "enriched_at_block" = EXCLUDED."enriched_at_block"
      WHERE EXCLUDED."enriched_at_block" > ${this.q('verdict_envelope_meta')}."enriched_at_block"
    `);
  }
}
