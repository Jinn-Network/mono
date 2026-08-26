import type Database from 'better-sqlite3';

export type TaskPostingPolicyType = 'once_per_safe' | 'once_per_bucket' | 'interval';
type LauncherTaskProjectionState = 'open' | 'claims-in-flight' | 'fully-claimed' | 'settled' | 'failed';

export interface TaskPostRecord {
  creatorSafeAddress: string;
  sourceKey: string;
  policyType: TaskPostingPolicyType;
  scopeKey: string;
  taskId: string;
  protocolTaskId?: string | null;
  taskCid?: string | null;
  requestId: string;
  firstPostedAt: string;
  lastPostedAt: string;
  postCount: number;
  canonicalTaskJson?: string | null;
  requestJson?: string | null;
  creationTxHash?: `0x${string}` | null;
  creationBlockNumber?: number | null;
  broadcastIntentAt?: string | null;
}

interface LocalTaskRunProjectionRow {
  request_id: string;
  state: string;
  task_role: string | null;
  task_payload: string | null;
  delivery_tx_hash: string | null;
  state_updated_at: number;
}

export function nativeEngagementStateToProjection(state: string): string {
  if (state === 'failed') return 'FAILED';
  if (state === 'solution-settled') return 'COMPLETE';
  if (state === 'lost' || state === 'withdrawn') return 'RACE_LOST';
  return 'RUNNING';
}

export function readClaimPolicyMaxClaims(taskPayload: string | null): number | undefined {
  if (!taskPayload) return undefined;
  try {
    const parsed = JSON.parse(taskPayload) as {
      claimPolicy?: { maxClaims?: unknown };
      signedTask?: { claimPolicy?: { maxClaims?: unknown } };
    };
    const value = parsed.claimPolicy?.maxClaims ?? parsed.signedTask?.claimPolicy?.maxClaims;
    return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
  } catch {
    return undefined;
  }
}

export function derivePostedTaskLocalState(args: {
  runs: LocalTaskRunProjectionRow[];
  localRestorationClaims: number;
  maxClaims?: number;
}): LauncherTaskProjectionState | undefined {
  if (args.runs.some((run) => run.state === 'FAILED')) return 'failed';
  if (args.runs.some((run) => run.state === 'COMPLETE' || run.delivery_tx_hash)) return 'settled';
  if (args.maxClaims !== undefined && args.localRestorationClaims >= args.maxClaims) {
    return 'fully-claimed';
  }
  if (args.localRestorationClaims > 0 || args.runs.length > 0) return 'claims-in-flight';
  return undefined;
}

export class TaskPostsStore {
  constructor(private readonly db: Database.Database) {}

  runMigrations(): void {
    this.ensureTaskPostsTaskCoordinatorColumns();
  }

  /** Fresh v1 state is Task-first; older local DBs get additive columns only. */
  private ensureTaskPostsTaskCoordinatorColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(task_posts)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('task_id')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN task_id TEXT`);
    }
    if (!names.has('protocol_task_id')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN protocol_task_id TEXT`);
    }
    if (!names.has('task_cid')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN task_cid TEXT`);
    }
    if (!names.has('canonical_task_json')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN canonical_task_json TEXT`);
    }
    if (!names.has('request_json')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN request_json TEXT`);
    }
    if (!names.has('creation_tx_hash')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN creation_tx_hash TEXT`);
    }
    if (!names.has('creation_block_number')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN creation_block_number INTEGER`);
    }
    if (!names.has('broadcast_intent_at')) {
      this.db.exec(`ALTER TABLE task_posts ADD COLUMN broadcast_intent_at TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_task_posts_task ON task_posts (task_id)`);
  }

  getTaskPostRecord(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
  }): TaskPostRecord | null {
    const row = this.db.prepare(
      `SELECT creator_safe_address, source_key, policy_type, scope_key, task_id,
              protocol_task_id, task_cid, request_id,
              first_posted_at, last_posted_at, post_count, canonical_task_json, request_json,
              creation_tx_hash, creation_block_number, broadcast_intent_at
       FROM task_posts
       WHERE creator_safe_address = @creatorSafeAddress
         AND source_key = @sourceKey
         AND policy_type = @policyType
         AND scope_key = @scopeKey`,
    ).get(args) as {
      creator_safe_address: string;
      source_key: string;
      policy_type: TaskPostingPolicyType;
      scope_key: string;
      task_id: string;
      protocol_task_id: string | null;
      task_cid: string | null;
      request_id: string;
      first_posted_at: string;
      last_posted_at: string;
      post_count: number;
      canonical_task_json: string | null;
      request_json: string | null;
      creation_tx_hash: `0x${string}` | null;
      creation_block_number: number | null;
      broadcast_intent_at: string | null;
    } | undefined;
    if (!row) return null;
    return {
      creatorSafeAddress: row.creator_safe_address,
      sourceKey: row.source_key,
      policyType: row.policy_type,
      scopeKey: row.scope_key,
      taskId: row.task_id,
      protocolTaskId: row.protocol_task_id,
      taskCid: row.task_cid,
      requestId: row.request_id,
      firstPostedAt: row.first_posted_at,
      lastPostedAt: row.last_posted_at,
      postCount: row.post_count,
      canonicalTaskJson: row.canonical_task_json,
      requestJson: row.request_json,
      creationTxHash: row.creation_tx_hash,
      creationBlockNumber: row.creation_block_number,
      broadcastIntentAt: row.broadcast_intent_at,
    };
  }

  /**
   * Posted Tasks for the launcher mode (`GET /v1/launcher/tasks`,
   * spec/2026-05-05-launcher-role-and-mode.md §5.3). Returns rows from
   * `task_posts` filtered by creator Safe address, sorted by `last_posted_at
   * DESC` (most recent first). The `solverType` is denormalised in by joining
   * `activity_events` on `request_id` for the `task_posted` kind — that's
   * where `posting-service.ts` writes the SolverType when the post lands.
   *
   * `before` filters to rows with `last_posted_at < before` (ISO-8601). When
   * `before` is undefined, returns the most recent `limit` rows.
   *
   * Caller-side: `gatherLauncherTasks` (`api/launcher-tasks.ts`) maps the
   * solver_type back to the operator's SolverNet name via config lookup.
   */
  listPostedTasksByCreator(args: {
    creatorSafeAddress: string;
    limit: number;
    before?: string;
  }): Array<{
    taskId: string;
    /**
     * On-chain decimal taskId (#579), decoded from the `TaskCreated` event.
     * DISTINCT from `taskId`, which is the off-chain task-document id. The
     * launcher's on-chain status chip keys its indexer lookup on this. Empty
     * string when no on-chain id was recorded (pre-migration / lost event).
     */
    protocolTaskId: string;
    taskCid: string;
    solverType: string | null;
    requestId: string;
    postedAt: string;
    state?: LauncherTaskProjectionState;
    claims?: { current?: number; max?: number };
  }> {
    const limit = Math.max(0, Math.min(args.limit, 1000));
    if (limit === 0) return [];
    const params: Record<string, unknown> = {
      creator: args.creatorSafeAddress,
      limit,
    };
    let beforeClause = '';
    if (args.before) {
      beforeClause = ' AND tp.last_posted_at < @before';
      params['before'] = args.before;
    }
    // LEFT JOIN: a stale `task_posts` row from before activity_events backfill
    // (or one whose event was lost to `recordActivityEvent` failure) still
    // surfaces with a NULL solver_type — the gather function falls back to
    // `solverNet: 'unknown'` rather than dropping the row, because the
    // operator should still see the Task they posted.
    const rows = this.db.prepare(
      `SELECT
         tp.task_id,
         tp.task_cid,
         tp.protocol_task_id,
         tp.request_id,
         tp.last_posted_at,
         tp.canonical_task_json,
         (
           SELECT ae.solver_type
           FROM activity_events ae
           WHERE ae.request_id = tp.request_id
             AND ae.kind = 'task_posted'
             AND ae.solver_type IS NOT NULL
           ORDER BY ae.id DESC
           LIMIT 1
         ) AS solver_type
       FROM task_posts tp
       WHERE tp.creator_safe_address = @creator${beforeClause}
       ORDER BY tp.last_posted_at DESC
       LIMIT @limit`,
    ).all(params) as Array<{
      task_id: string | null;
      task_cid: string | null;
      protocol_task_id: string | null;
      request_id: string;
      last_posted_at: string;
      canonical_task_json: string | null;
      solver_type: string | null;
    }>;
    const localRunsForPost = this.db.prepare(
      `SELECT
         COALESCE(e.request_id, e.engagement_id) AS request_id,
         e.state AS native_state,
         e.task_id AS native_task_id,
         e.updated_at AS updated_at,
         (SELECT o.tx_hash FROM native_operations o
            WHERE o.engagement_id = e.engagement_id
              AND o.kind = 'solution-settlement'
              AND o.tx_hash IS NOT NULL
            ORDER BY o.updated_at DESC LIMIT 1) AS delivery_tx_hash
       FROM native_engagements e
       WHERE COALESCE(e.request_id, '') = @requestId
          OR (@taskId != '' AND e.task_id = @taskId)
          OR (@protocolTaskId != '' AND e.task_id = @protocolTaskId)
       ORDER BY e.updated_at DESC`,
    );
    return rows.map((r) => {
      // task_id was added by an additive migration; the column exists on every
      // post-migration insert (posting-service.ts always writes it). Older
      // rows fall back to protocol_task_id (chain Task ID) and finally
      // request_id so the response shape's `taskId` is always populated.
      const taskId = r.task_id ?? r.protocol_task_id ?? r.request_id;
      const protocolTaskId = r.protocol_task_id ?? '';
      const taskCid = r.task_cid ?? '';
      const runs = (localRunsForPost.all({
        requestId: r.request_id,
        taskId,
        protocolTaskId,
      }) as Array<{
        request_id: string;
        native_state: string;
        native_task_id: string;
        updated_at: string;
        delivery_tx_hash: string | null;
      }>).map((run) => ({
        request_id: run.request_id,
        state: nativeEngagementStateToProjection(run.native_state),
        task_role: 'restoration',
        task_payload: r.canonical_task_json,
        delivery_tx_hash: run.delivery_tx_hash,
        state_updated_at: Date.parse(run.updated_at) || 0,
      })) as LocalTaskRunProjectionRow[];
      const maxClaims = readClaimPolicyMaxClaims(r.canonical_task_json);
      const localRestorationClaims = new Set(
        runs
          .filter((run) => run.task_role !== 'evaluation')
          .map((run) => run.request_id),
      ).size;
      const state = derivePostedTaskLocalState({
        runs,
        localRestorationClaims,
        maxClaims,
      });
      return {
        taskId,
        protocolTaskId,
        taskCid,
        solverType: r.solver_type,
        requestId: r.request_id,
        postedAt: r.last_posted_at,
        ...(state ? { state } : {}),
        ...(runs.length > 0 || maxClaims !== undefined
          ? {
              claims: {
                current: localRestorationClaims,
                ...(maxClaims !== undefined ? { max: maxClaims } : {}),
              },
            }
          : {}),
      };
    });
  }

  /** Count of posted Tasks for this creator with the given solver_type. v1
   *  treats every posted Task as in-flight (state derivation lands with
   *  router-watcher hardening, jinn-mono-l2zl.12). */
  countPostedTasksByCreatorAndSolverType(args: {
    creatorSafeAddress: string;
    solverType: string;
  }): number {
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT tp.task_id) AS c
       FROM task_posts tp
       INNER JOIN activity_events ae
         ON ae.request_id = tp.request_id
         AND ae.kind = 'task_posted'
       WHERE tp.creator_safe_address = @creator
         AND ae.solver_type = @solverType`,
    ).get({
      creator: args.creatorSafeAddress,
      solverType: args.solverType,
    }) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  upsertTaskPostRecord(record: TaskPostRecord): void {
    const params = {
      ...record,
      protocolTaskId: record.protocolTaskId ?? null,
      taskCid: record.taskCid ?? null,
      canonicalTaskJson: record.canonicalTaskJson ?? null,
      requestJson: record.requestJson ?? null,
      creationTxHash: record.creationTxHash ?? null,
      creationBlockNumber: record.creationBlockNumber ?? null,
      broadcastIntentAt: record.broadcastIntentAt ?? null,
    };
    this.db.prepare(
      `INSERT INTO task_posts
         (creator_safe_address, source_key, policy_type, scope_key, task_id, protocol_task_id, task_cid, request_id,
          first_posted_at, last_posted_at, post_count, canonical_task_json, request_json,
          creation_tx_hash, creation_block_number, broadcast_intent_at)
       VALUES
         (@creatorSafeAddress, @sourceKey, @policyType, @scopeKey, @taskId, @protocolTaskId, @taskCid, @requestId,
          @firstPostedAt, @lastPostedAt, @postCount, @canonicalTaskJson, @requestJson,
          @creationTxHash, @creationBlockNumber, @broadcastIntentAt)
       ON CONFLICT(creator_safe_address, source_key, policy_type, scope_key) DO UPDATE SET
         task_id = excluded.task_id,
         protocol_task_id = excluded.protocol_task_id,
         task_cid = excluded.task_cid,
         request_id = excluded.request_id,
         first_posted_at = excluded.first_posted_at,
         last_posted_at = excluded.last_posted_at,
         post_count = excluded.post_count,
         canonical_task_json = excluded.canonical_task_json,
         request_json = excluded.request_json,
         creation_tx_hash = COALESCE(excluded.creation_tx_hash, task_posts.creation_tx_hash),
         creation_block_number = COALESCE(excluded.creation_block_number, task_posts.creation_block_number),
         broadcast_intent_at = COALESCE(excluded.broadcast_intent_at, task_posts.broadcast_intent_at)`,
    ).run(params);
  }

  acquireTaskPostLock(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
    ownerToken: string;
    lockedAt: string;
    staleAfterMs: number;
  }): boolean {
    const tx = this.db.transaction((params: typeof args) => {
      const existing = this.db.prepare(
        `SELECT owner_token, locked_at
         FROM task_post_locks
         WHERE creator_safe_address = @creatorSafeAddress
           AND source_key = @sourceKey
           AND policy_type = @policyType
           AND scope_key = @scopeKey`,
      ).get(params) as { owner_token: string; locked_at: string } | undefined;

      if (!existing) {
        this.db.prepare(
          `INSERT INTO task_post_locks
             (creator_safe_address, source_key, policy_type, scope_key, owner_token, locked_at)
           VALUES
             (@creatorSafeAddress, @sourceKey, @policyType, @scopeKey, @ownerToken, @lockedAt)`,
        ).run(params);
        return true;
      }

      const lockedAtMs = Date.parse(existing.locked_at);
      const nowMs = Date.parse(params.lockedAt);
      const isStale = Number.isFinite(lockedAtMs)
        && Number.isFinite(nowMs)
        && (nowMs - lockedAtMs) >= params.staleAfterMs;
      if (!isStale) {
        return false;
      }

      this.db.prepare(
        `UPDATE task_post_locks
         SET owner_token = @ownerToken, locked_at = @lockedAt
         WHERE creator_safe_address = @creatorSafeAddress
           AND source_key = @sourceKey
           AND policy_type = @policyType
           AND scope_key = @scopeKey`,
      ).run(params);
      return true;
    });

    return tx(args);
  }

  releaseTaskPostLock(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
    ownerToken: string;
  }): void {
    this.db.prepare(
      `DELETE FROM task_post_locks
       WHERE creator_safe_address = @creatorSafeAddress
         AND source_key = @sourceKey
         AND policy_type = @policyType
         AND scope_key = @scopeKey
         AND owner_token = @ownerToken`,
    ).run(args);
  }

  renewTaskPostLock(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
    ownerToken: string;
    lockedAt: string;
  }): boolean {
    const result = this.db.prepare(
      `UPDATE task_post_locks
       SET locked_at = @lockedAt
       WHERE creator_safe_address = @creatorSafeAddress
         AND source_key = @sourceKey
         AND policy_type = @policyType
         AND scope_key = @scopeKey
         AND owner_token = @ownerToken`,
    ).run(args);
    return result.changes === 1;
  }

  markTaskPostBroadcastIntent(args: {
    creatorSafeAddress: string;
    sourceKey: string;
    policyType: TaskPostingPolicyType;
    scopeKey: string;
    ownerToken: string;
    lockedAt: string;
    broadcastIntentAt: string;
  }): boolean {
    const tx = this.db.transaction((params: typeof args) => {
      const renewed = this.db.prepare(
        `UPDATE task_post_locks
         SET locked_at = @lockedAt
         WHERE creator_safe_address = @creatorSafeAddress
           AND source_key = @sourceKey
           AND policy_type = @policyType
           AND scope_key = @scopeKey
           AND owner_token = @ownerToken`,
      ).run(params);
      if (renewed.changes !== 1) return false;

      const marked = this.db.prepare(
        `UPDATE task_posts
         SET broadcast_intent_at = @broadcastIntentAt
         WHERE creator_safe_address = @creatorSafeAddress
           AND source_key = @sourceKey
           AND policy_type = @policyType
           AND scope_key = @scopeKey`,
      ).run(params);
      if (marked.changes !== 1) {
        throw new Error(
          `Task post record disappeared while marking broadcast intent for ${params.sourceKey}`,
        );
      }
      return true;
    });

    return tx(args);
  }
}
