import type Database from 'better-sqlite3';
import { SEVEN_DAY_MS } from '../spend/ai-units.js';

export interface ActivityEventInput {
  ts: string | null;
  kind: string;
  requestId?: string | null;
  serviceIndex?: number | null;
  txHash?: string | null;
  solverType?: string | null;
  outcome?: string | null;
  detail?: string | null;
  credentialId?: string | null;
  costUsdMicros?: number | null;
  model?: string | null;
  /** Projected AI units debited at claim time (issue #815). Estimates are the gate input; never recomputed. */
  aiUnits?: number | null;
  /** Lifecycle stamp on the per-request row: 'claimed' | 'claim_failed' | 'delivered'. */
  claimStatus?: string | null;
  /** USD estimate captured at claim time (micros). Distinct from `actualCostUsdMicros` filled on completion. */
  estimatedCostUsdMicros?: number | null;
  /** USD actually billed (micros) — filled by the completion path; null until then. */
  actualCostUsdMicros?: number | null;
}

export interface ActivityEventRow {
  id: number;
  ts: string | null;
  kind: string;
  requestId: string | null;
  serviceIndex: number | null;
  txHash: string | null;
  solverType: string | null;
  outcome: string | null;
  detail: string | null;
  credentialId: string | null;
  costUsdMicros: number | null;
  model: string | null;
  aiUnits: number | null;
  claimStatus: string | null;
  estimatedCostUsdMicros: number | null;
  actualCostUsdMicros: number | null;
}

interface ActivityEventDbRow {
  id: number;
  ts: string | null;
  kind: string;
  request_id: string | null;
  service_index: number | null;
  tx_hash: string | null;
  solver_type: string | null;
  outcome: string | null;
  detail: string | null;
  credential_id: string | null;
  cost_usd_micros: number | null;
  model: string | null;
  ai_units: number | null;
  claim_status: string | null;
  estimated_cost_usd_micros: number | null;
  actual_cost_usd_micros: number | null;
}

function mapRow(r: ActivityEventDbRow): ActivityEventRow {
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    requestId: r.request_id,
    serviceIndex: r.service_index,
    txHash: r.tx_hash,
    solverType: r.solver_type,
    outcome: r.outcome,
    detail: r.detail,
    credentialId: r.credential_id,
    costUsdMicros: r.cost_usd_micros,
    model: r.model,
    aiUnits: r.ai_units,
    claimStatus: r.claim_status,
    estimatedCostUsdMicros: r.estimated_cost_usd_micros,
    actualCostUsdMicros: r.actual_cost_usd_micros,
  };
}

const ACTIVITY_EVENT_SELECT = `
  SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
         credential_id, cost_usd_micros, model,
         ai_units, claim_status, estimated_cost_usd_micros, actual_cost_usd_micros
  FROM activity_events`;

export class ActivityEventsStore {
  constructor(private readonly db: Database.Database) {}

  runMigrations(): void {
    this.ensureActivityEventCostColumns();
  }

  /** Older local DBs predate the per-credential spend-ledger columns on activity_events. */
  private ensureActivityEventCostColumns(): void {
    const activityCols = new Set(
      (this.db.prepare(`PRAGMA table_info(activity_events)`).all() as Array<{ name: string }>)
        .map(c => c.name),
    );
    const addActivityColumn = (name: string, ddl: string) => {
      if (!activityCols.has(name)) this.db.exec(`ALTER TABLE activity_events ADD COLUMN ${ddl}`);
    };
    addActivityColumn('credential_id', 'credential_id TEXT');
    addActivityColumn('cost_usd_micros', 'cost_usd_micros INTEGER');
    addActivityColumn('model', 'model TEXT');
    // Issue #815 — AI-units ceiling. ai_units is the gate-input projection
    // captured at claim time; claim_status tracks the per-request lifecycle
    // (claimed / claim_failed / delivered); the cost pair splits the
    // estimated-at-claim-time vs actual-at-completion telemetry.
    addActivityColumn('ai_units', 'ai_units REAL');
    addActivityColumn('claim_status', 'claim_status TEXT');
    addActivityColumn('estimated_cost_usd_micros', 'estimated_cost_usd_micros INTEGER');
    addActivityColumn('actual_cost_usd_micros', 'actual_cost_usd_micros INTEGER');
    // Issue #1004 (AC4): whether actual_cost_usd_micros is estimate-backed
    // (1) or harvested telemetry (0/null). A telemetry-less harness such as
    // Hermes still writes a NON-null actual cost via finalizeClaimDelivered,
    // so the column distinguishes a heuristic figure from a metered one. The
    // gate's estimated flag reads this so a heuristic is not shown as metered.
    addActivityColumn('actual_cost_estimated', 'actual_cost_estimated INTEGER');
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_activity_events_credential ON activity_events (credential_id, ts)`,
    );
    // Per-request lookup for the completion-time update path that fills
    // actualCostUsdMicros / sets claim_status='delivered'.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_activity_events_req_claim ON activity_events (request_id, claim_status)`,
    );
  }

  recordActivityEvent(event: ActivityEventInput): number {
    const info = this.db.prepare(
      `INSERT INTO activity_events
         (ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
          credential_id, cost_usd_micros, model,
          ai_units, claim_status, estimated_cost_usd_micros, actual_cost_usd_micros)
       VALUES
         (@ts, @kind, @requestId, @serviceIndex, @txHash, @solverType, @outcome, @detail,
          @credentialId, @costUsdMicros, @model,
          @aiUnits, @claimStatus, @estimatedCostUsdMicros, @actualCostUsdMicros)`,
    ).run({
      ts: event.ts ?? null,
      kind: event.kind,
      requestId: event.requestId ?? null,
      serviceIndex: event.serviceIndex ?? null,
      txHash: event.txHash ?? null,
      solverType: event.solverType ?? null,
      outcome: event.outcome ?? null,
      detail: event.detail ?? null,
      credentialId: event.credentialId ?? null,
      costUsdMicros: event.costUsdMicros ?? null,
      model: event.model ?? null,
      aiUnits: event.aiUnits ?? null,
      claimStatus: event.claimStatus ?? null,
      estimatedCostUsdMicros: event.estimatedCostUsdMicros ?? null,
      actualCostUsdMicros: event.actualCostUsdMicros ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  getRecentActivityEvents(
    limit: number,
    opts: { since?: string; cursor?: string } = {},
  ): ActivityEventRow[] {
    const effectiveLimit = Math.max(0, Math.min(limit, 1000));
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: effectiveLimit };
    if (opts.since) {
      clauses.push('ts IS NOT NULL AND ts >= @since');
      params['since'] = opts.since;
    }
    if (opts.cursor) {
      clauses.push('ts IS NOT NULL AND ts < @cursor');
      params['cursor'] = opts.cursor;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `${ACTIVITY_EVENT_SELECT}
       ${where}
       ORDER BY id DESC
       LIMIT @limit`,
    ).all(params) as ActivityEventDbRow[];
    return rows.map(mapRow);
  }

  /**
   * Total cost in micro-dollars recorded against a credential since the most
   * recent UTC midnight. Backs the daily spend cap.
   */
  spentTodayMicros(credentialId: string, now: Date = new Date()): number {
    const midnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(cost_usd_micros), 0) AS total
       FROM activity_events
       WHERE credential_id = @cid AND ts IS NOT NULL AND ts >= @midnight`,
    ).get({ cid: credentialId, midnight }) as { total: number };
    return row.total;
  }

  /**
   * Sum of `ai_units` for a credential within the current 6h UTC-aligned
   * block (00:00 / 06:00 / 12:00 / 18:00 boundaries). Reads only rows whose
   * `claim_status = 'claimed'` or `'delivered'` so failed-claim rows
   * (`ai_units = 0`, `claim_status = 'claim_failed'`) don't muddy the sum
   * even though their contribution is already zero.
   *
   * Issue #815. Backs the per-block AI-units ceiling gate.
   */
  aiUnitsThisBlock(credentialId: string, now: Date = new Date()): number {
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const sinceDayStart = now.getTime() - startOfDay;
    const sixHoursMs = 6 * 60 * 60 * 1_000;
    // Cap at 3 — there are 4 blocks per day (indices 0..3). Edge cases
    // where sinceDayStart ≈ 24h (millisecond rounding) would otherwise
    // overshoot into a non-existent 5th block in the *next* day.
    const blocksIn = Math.min(Math.floor(sinceDayStart / sixHoursMs), 3);
    const blockStart = new Date(startOfDay + blocksIn * sixHoursMs).toISOString();
    const blockEnd = new Date(startOfDay + (blocksIn + 1) * sixHoursMs).toISOString();
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(ai_units), 0) AS total
       FROM activity_events
       WHERE credential_id = @cid
         AND ts IS NOT NULL AND ts >= @blockStart AND ts < @blockEnd
         AND claim_status IN ('claimed', 'delivered')`,
    ).get({ cid: credentialId, blockStart, blockEnd }) as { total: number };
    return row.total ?? 0;
  }

  /**
   * Sum of `ai_units` for a credential within the trailing 7-day rolling
   * window from `now`. Backs the per-week AI-units safety-net ceiling.
   * Issue #815.
   */
  aiUnitsThisWeek(credentialId: string, now: Date = new Date()): number {
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(ai_units), 0) AS total
       FROM activity_events
       WHERE credential_id = @cid
         AND ts IS NOT NULL AND ts >= @weekStart
         AND claim_status IN ('claimed', 'delivered')`,
    ).get({ cid: credentialId, weekStart }) as { total: number };
    return row.total ?? 0;
  }

  /**
   * Actual-spend accumulator for the current 6h UTC block (issue #1004).
   *
   * Sums `COALESCE(actual_cost_usd_micros, estimated_cost_usd_micros, 0)`
   * over rows whose `claim_status` is `'claimed'` or `'delivered'`:
   *   - delivered rows contribute the real harvested cost (`actual_*`),
   *   - in-flight claimed rows contribute their estimate so a burst of
   *     concurrent claims cannot slip the cap before any of them deliver,
   *   - failed claims (status `'claim_failed'`) are excluded.
   *
   * `estimated` is true iff the summed figure includes any estimate-backed
   * cost: an in-flight `claimed` row with no `actual_cost_usd_micros` yet,
   * OR a `delivered` row whose actual cost is itself a heuristic
   * (`actual_cost_estimated = 1` — a telemetry-less harness such as Hermes).
   * It is false only when every contributing row is harvested actual
   * telemetry. The gate surfaces this so an estimate-backed figure is not
   * presented as metered. Block boundaries mirror `aiUnitsThisBlock`.
   */
  usdMicrosThisBlock(
    credentialId: string,
    now: Date = new Date(),
  ): { usdMicros: number; estimated: boolean } {
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const sinceDayStart = now.getTime() - startOfDay;
    const sixHoursMs = 6 * 60 * 60 * 1_000;
    const blocksIn = Math.min(Math.floor(sinceDayStart / sixHoursMs), 3);
    const blockStart = new Date(startOfDay + blocksIn * sixHoursMs).toISOString();
    const blockEnd = new Date(startOfDay + (blocksIn + 1) * sixHoursMs).toISOString();
    return this.sumUsdMicros(credentialId, blockStart, blockEnd);
  }

  /**
   * Actual-spend accumulator for the trailing 7-day rolling window from
   * `now` (issue #1004). Same COALESCE + claim_status filter + `estimated`
   * semantics as {@link usdMicrosThisBlock}.
   */
  usdMicrosThisWeek(
    credentialId: string,
    now: Date = new Date(),
  ): { usdMicros: number; estimated: boolean } {
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    return this.sumUsdMicros(credentialId, weekStart, undefined);
  }

  /**
   * The true "claims resume at" instant for the rolling 7-day window
   * (issue #830, item 1). `weekResetsAtUtc(now)` (`now + 7d`) is a fixed
   * instant that overstates the wait — a rolling window sheds its oldest
   * rows continuously, not all at once. This walks the in-window rows
   * oldest-to-newest, subtracting each from the running total, and returns
   * the instant `remaining + projectedUsdMicros` first falls to or below
   * `capUsdMicros` (that row's `ts + 7d`). The `<=` boundary exactly mirrors
   * the gate, which blocks only on `current + projected > cap`. Returns
   * `null` when the prospective claim is already allowed or when the
   * projection alone exceeds the cap, so no in-window row expiry can make
   * the claim eligible.
   */
  weekWindowResumeAt(
    credentialId: string,
    capUsdMicros: number,
    now: Date = new Date(),
    projectedUsdMicros = 0,
  ): string | null {
    if (projectedUsdMicros > capUsdMicros) return null;

    const weekStart = new Date(now.getTime() - SEVEN_DAY_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT ts, COALESCE(actual_cost_usd_micros, estimated_cost_usd_micros, 0) AS usdMicros
         FROM activity_events
         WHERE credential_id = @cid
           AND ts IS NOT NULL AND ts >= @weekStart AND ts < @now
           AND claim_status IN ('claimed', 'delivered')
         ORDER BY ts ASC`,
      )
      .all({ cid: credentialId, weekStart, now: now.toISOString() }) as {
      ts: string;
      usdMicros: number;
    }[];

    let remaining = rows.reduce((sum, r) => sum + r.usdMicros, 0);
    if (remaining + projectedUsdMicros <= capUsdMicros) return null;

    // Guaranteed to return inside this loop for a non-negative projection no
    // larger than the cap: after the last row, remaining is zero and the
    // prospective debit is within the cap.
    for (const row of rows) {
      remaining -= row.usdMicros;
      if (remaining + projectedUsdMicros <= capUsdMicros) {
        return new Date(new Date(row.ts).getTime() + SEVEN_DAY_MS).toISOString();
      }
    }
    return null;
  }

  /** Shared COALESCE-sum + estimate-flag query for the USD accumulators. */
  private sumUsdMicros(
    credentialId: string,
    fromIso: string,
    toIso: string | undefined,
  ): { usdMicros: number; estimated: boolean } {
    const upper = toIso ? 'AND ts < @to' : '';
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(COALESCE(actual_cost_usd_micros, estimated_cost_usd_micros, 0)), 0) AS total,
           COALESCE(SUM(CASE WHEN actual_cost_usd_micros IS NULL OR actual_cost_estimated = 1 THEN 1 ELSE 0 END), 0) AS estimatedRows
         FROM activity_events
         WHERE credential_id = @cid
           AND ts IS NOT NULL AND ts >= @from ${upper}
           AND claim_status IN ('claimed', 'delivered')`,
      )
      .get({ cid: credentialId, from: fromIso, to: toIso }) as {
        total: number;
        estimatedRows: number;
      };
    return { usdMicros: row.total ?? 0, estimated: (row.estimatedRows ?? 0) > 0 };
  }

  /**
   * True iff an `ai_units_cap_reached` row exists for the given
   * (credentialId, window, blockId). Used by the daemon to hydrate the
   * AI-units gate's in-memory pause memo across restarts so the
   * "exactly one event per (credential, window, block-id)" guarantee
   * holds across process boundaries (issue #815, finding 1).
   *
   * Lookup is by `credential_id` + `kind` + the `[block=...][window=...]`
   * markers that `daemon.ts` embeds in the row's `detail` string.
   */
  hasAiUnitsCapReachedFor(
    credentialId: string,
    window: 'block' | 'week',
    blockId: string,
  ): boolean {
    const marker = `[block=${blockId}][window=${window}]`;
    const row = this.db.prepare(
      `SELECT 1 AS hit
       FROM activity_events
       WHERE kind = 'ai_units_cap_reached'
         AND credential_id = @cid
         AND detail LIKE @marker
       LIMIT 1`,
    ).get({ cid: credentialId, marker: `${marker}%` }) as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * Mark the per-request `claimed` row as `delivered` and record
   * `actual_cost_usd_micros` (issue #1004 — the gate's accumulator now
   * reads this column via COALESCE, so a delivered row's real harvested
   * cost replaces its claim-time estimate in the running total). The
   * `ai_units` projection captured at claim time is intentionally NOT
   * recomputed — it remains the per-task estimate for the legacy unit
   * surfaces. For subscription credentials the resulting USD figure is a
   * *proxy* budget, not an exact bound on the provider's plan quota.
   *
   * `actualCostEstimated` (issue #1004, AC4) records whether the actual
   * cost is itself a heuristic — true for a telemetry-less harness such as
   * Hermes whose `harvestHarnessUsage` falls back to an a-priori estimate,
   * false when the figure is harvested telemetry. The gate reads it so a
   * delivered-but-heuristic row reports `estimated: true` rather than being
   * presented as metered. Idempotent: a no-op when no `claimed` row exists.
   */
  finalizeClaimDelivered(
    requestId: string,
    actualCostUsdMicros: number,
    actualCostEstimated: boolean,
  ): void {
    this.db.prepare(
      `UPDATE activity_events
         SET claim_status = 'delivered',
             actual_cost_usd_micros = @actual,
             actual_cost_estimated = @estimated
       WHERE request_id = @req AND claim_status = 'claimed'`,
    ).run({
      req: requestId,
      actual: actualCostUsdMicros,
      estimated: actualCostEstimated ? 1 : 0,
    });
  }

  /** Newer events first, then ascending id for `jinn logs --follow` (oldest in batch printed first in caller). */
  getActivityEventsAfterId(afterId: number, limit: number): ActivityEventRow[] {
    const effectiveLimit = Math.max(0, Math.min(limit, 1000));
    const rows = this.db
      .prepare(
        `${ACTIVITY_EVENT_SELECT}
         WHERE id > @afterId
         ORDER BY id ASC
         LIMIT @limit`,
      )
      .all({ afterId, limit: effectiveLimit }) as ActivityEventDbRow[];
    return rows.map(mapRow);
  }

  /**
   * Filtered, id-cursored page of activity events for the dedicated Events
   * page. Newest-first.
   *
   * Cursors on `id` rather than `ts` so startup/shutdown rows with null
   * timestamps remain reachable.
   */
  getActivityEventsPage(opts: {
    kinds?: string[];
    outcome?: string;
    requestId?: string;
    beforeId?: number;
    limit?: number;
  } = {}): ActivityEventRow[] {
    const effectiveLimit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: effectiveLimit };
    if (opts.kinds && opts.kinds.length > 0) {
      const placeholders = opts.kinds.map((_, i) => `@kind${i}`);
      clauses.push(`kind IN (${placeholders.join(', ')})`);
      opts.kinds.forEach((k, i) => {
        params[`kind${i}`] = k;
      });
    }
    if (opts.outcome) {
      clauses.push('outcome = @outcome');
      params['outcome'] = opts.outcome;
    }
    if (opts.requestId) {
      clauses.push('request_id = @requestId');
      params['requestId'] = opts.requestId;
    }
    if (opts.beforeId !== undefined) {
      clauses.push('id < @beforeId');
      params['beforeId'] = opts.beforeId;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `${ACTIVITY_EVENT_SELECT}
       ${where}
       ORDER BY id DESC
       LIMIT @limit`,
    ).all(params) as ActivityEventDbRow[];
    return rows.map(mapRow);
  }

  getActivityEventById(id: number): ActivityEventRow | null {
    const r = this.db.prepare(
      `${ACTIVITY_EVENT_SELECT}
       WHERE id = ?`,
    ).get(id) as ActivityEventDbRow | undefined;
    if (!r) return null;
    return mapRow(r);
  }

  getActivityCountsByKind(): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT kind, COUNT(*) as c FROM activity_events GROUP BY kind`,
    ).all() as Array<{ kind: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.kind] = r.c;
    return out;
  }

  getLastEventAtForService(serviceIndex: number): string | null {
    const row = this.db.prepare(
      `SELECT ts FROM activity_events WHERE service_index = ? AND ts IS NOT NULL ORDER BY id DESC LIMIT 1`,
    ).get(serviceIndex) as { ts: string | null } | undefined;
    return row?.ts ?? null;
  }

  getActivityCountsForService(serviceIndex: number): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT kind, COUNT(*) as c FROM activity_events WHERE service_index = ? GROUP BY kind`,
    ).all(serviceIndex) as Array<{ kind: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.kind] = r.c;
    return out;
  }
}
