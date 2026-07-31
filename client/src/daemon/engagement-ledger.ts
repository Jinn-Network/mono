import type { ExecutionWiringEntry } from '@jinn-network/marketplace-pipeline';
import type { Store } from '../store/store.js';

/**
 * `request_id` (C1 in the close-out addendum's "engagement ledger gains requestId correlation"
 * deliverable): today-generation `SettlementAttempt`s carry only `requestId` (never `taskId`;
 * see `packages/marketplace/binding/src/settlement.ts`), so `settlement-grade.ts`'s
 * `checkDispatchBinding` needs a `requestId -> row` correlation to do anything but report
 * `"missing"` for every today-generation settlement. Present on `CREATE TABLE` for fresh
 * databases; `store.ts`'s `ensureEngagementLedgerRequestIdColumn` ALTERs it in additively for a
 * database created before this column existed (same `PRAGMA table_info` guard every other
 * migration in that file uses).
 *
 * `dispatch_context_digest` / `dispatch_context_bytes` (finding E35, ruled): the engagement
 * ledger is where "which wiring entry served a claim" already lives (spec §4), and the
 * dispatch-context document is authored by this same work-loop side of the two-party engagement
 * at the moment it claims -- so it is sealed here, once, at claim time (I-JSON, JCS, sha256; TEP
 * §9.1; `docs/superpowers/specs/2026-07-30-stack-design-principles.md` §5 "Sealed once,
 * forever"). `dispatch_context_bytes` is the exact sealed bytes, base64-encoded for TEXT storage;
 * `dispatch_context_digest` is `documentDigest(bytes)`. `work-loop.ts`'s wrapped `claimTask`
 * seals and passes both to `recordClaimed`; `composition-root.ts`'s dispatch-context resolver and
 * `settlement-grade.ts`'s `checkDispatchBinding` both read the digest back rather than
 * recomputing or fabricating one. Present on `CREATE TABLE` for fresh databases; `store.ts`'s
 * `ensureEngagementLedgerDispatchContextColumns` ALTERs them in additively for a database created
 * before these columns existed (same `PRAGMA table_info` guard as `request_id`'s migration).
 */
export const ENGAGEMENT_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS engagement_ledger (
  idempotency_key         TEXT PRIMARY KEY,
  chain_id                INTEGER NOT NULL,
  task_coordinator        TEXT NOT NULL,
  task_id                 TEXT NOT NULL,
  work_kind               TEXT NOT NULL,
  wiring_json             TEXT NOT NULL,
  attempt_index           INTEGER,
  attempt_uri             TEXT,
  claim_tx_hash           TEXT,
  request_id              TEXT,
  dispatch_context_digest TEXT,
  dispatch_context_bytes  TEXT,
  outcome                 TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engagement_ledger_outcome ON engagement_ledger (outcome);
CREATE INDEX IF NOT EXISTS idx_engagement_ledger_task ON engagement_ledger (chain_id, task_coordinator, task_id);
`;

export type EngagementOutcome =
  | 'intended' | 'claimed' | 'delivered' | 'settled' | 'abandoned' | 'race-lost';

export interface EngagementRow {
  readonly idempotencyKey: string;
  readonly chainId: number;
  readonly taskCoordinator: string;
  readonly taskId: string;
  readonly workKind: string;
  readonly wiringJson: string;
  readonly attemptIndex: number | null;
  readonly attemptUri: string | null;
  readonly claimTxHash: string | null;
  /** Today-generation marketplace requestId this row's claim landed under. `null` for
   * revised-generation attempts (which carry no requestId) and for rows not yet claimed. */
  readonly requestId: string | null;
  /** Sealed dispatch-context digest (finding E35), `sha256:...`. `null` until claimed, or for a
   * row claimed before this column existed. */
  readonly dispatchContextDigest: `sha256:${string}` | null;
  /** Sealed dispatch-context bytes (finding E35), base64-encoded. `null` alongside the digest. */
  readonly dispatchContextBytes: string | null;
  readonly outcome: EngagementOutcome;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawRow {
  idempotency_key: string; chain_id: number; task_coordinator: string; task_id: string;
  work_kind: string; wiring_json: string; attempt_index: number | null; attempt_uri: string | null;
  claim_tx_hash: string | null; request_id: string | null;
  dispatch_context_digest: string | null; dispatch_context_bytes: string | null;
  outcome: EngagementOutcome;
  created_at: string; updated_at: string;
}

function toRow(raw: RawRow): EngagementRow {
  return {
    idempotencyKey: raw.idempotency_key,
    chainId: raw.chain_id,
    taskCoordinator: raw.task_coordinator,
    taskId: raw.task_id,
    workKind: raw.work_kind,
    wiringJson: raw.wiring_json,
    attemptIndex: raw.attempt_index,
    attemptUri: raw.attempt_uri,
    claimTxHash: raw.claim_tx_hash,
    requestId: raw.request_id,
    dispatchContextDigest: raw.dispatch_context_digest as `sha256:${string}` | null,
    dispatchContextBytes: raw.dispatch_context_bytes,
    outcome: raw.outcome,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export class EngagementLedger {
  constructor(private readonly store: Store) {}

  admitClaimIntent(input: {
    idempotencyKey: string;
    chainId: number;
    taskCoordinator: string;
    taskId: bigint;
    workKind: string;
    wiring: ExecutionWiringEntry;
  }): boolean {
    const now = new Date().toISOString();
    const admit = this.store.db.transaction(() =>
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO engagement_ledger
             (idempotency_key, chain_id, task_coordinator, task_id, work_kind, wiring_json,
              attempt_index, attempt_uri, claim_tx_hash, outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'intended', ?, ?)`,
        )
        .run(
          input.idempotencyKey,
          input.chainId,
          input.taskCoordinator,
          input.taskId.toString(),
          input.workKind,
          JSON.stringify(input.wiring),
          now,
          now,
        ).changes,
    );
    return admit() === 1;
  }

  recordClaimed(
    idempotencyKey: string,
    claim: {
      attemptIndex: number;
      attemptUri: string;
      claimTxHash: string;
      /** Today-generation marketplace requestId, when the claim minted one (claim.ts's
       * `ClaimAttemptResult` -- absent for revised-generation attempts). */
      requestId?: string;
      /**
       * The dispatch-context document (TEP §9.3), sealed exactly once by the caller at claim
       * time (finding E35, ruled) -- I-JSON, JCS, sha256; never re-sealed here. Absent only for
       * callers that have not yet been updated to seal (kept optional so existing fixtures/tests
       * that do not exercise dispatch-binding stay valid).
       */
      dispatchContext?: { readonly digest: `sha256:${string}`; readonly bytes: Uint8Array };
    },
  ): void {
    this.store.db
      .prepare(
        `UPDATE engagement_ledger
            SET attempt_index = ?, attempt_uri = ?, claim_tx_hash = ?, request_id = ?,
                dispatch_context_digest = ?, dispatch_context_bytes = ?,
                outcome = 'claimed', updated_at = ?
          WHERE idempotency_key = ?`,
      )
      .run(
        claim.attemptIndex,
        claim.attemptUri,
        claim.claimTxHash,
        claim.requestId ?? null,
        claim.dispatchContext?.digest ?? null,
        claim.dispatchContext === undefined
          ? null
          : Buffer.from(claim.dispatchContext.bytes).toString('base64'),
        new Date().toISOString(),
        idempotencyKey,
      );
  }

  recordOutcome(idempotencyKey: string, outcome: EngagementOutcome): void {
    this.store.db
      .prepare(`UPDATE engagement_ledger SET outcome = ?, updated_at = ? WHERE idempotency_key = ?`)
      .run(outcome, new Date().toISOString(), idempotencyKey);
  }

  get(idempotencyKey: string): EngagementRow | undefined {
    const raw = this.store.db
      .prepare(`SELECT * FROM engagement_ledger WHERE idempotency_key = ?`)
      .get(idempotencyKey) as RawRow | undefined;
    return raw === undefined ? undefined : toRow(raw);
  }

  /**
   * The today-generation correlation `settlement-grade.ts`'s `checkDispatchBinding` needs
   * (`EngagementLedgerReader.getByRequestId`, cutover stage 1 close-out C1/E24 gap 2). `Hex` is
   * typed as the bare template-literal shape (not imported from `viem`) so this module carries no
   * viem dependency of its own; it is structurally identical to `viem`'s `Hex`.
   */
  getByRequestId(requestId: `0x${string}`): EngagementRow | undefined {
    const raw = this.store.db
      .prepare(`SELECT * FROM engagement_ledger WHERE request_id = ?`)
      .get(requestId) as RawRow | undefined;
    return raw === undefined ? undefined : toRow(raw);
  }

  listUnreconciled(): EngagementRow[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM engagement_ledger
          WHERE outcome IN ('intended', 'claimed', 'delivered')
          ORDER BY created_at ASC`,
      )
      .all() as RawRow[];
    return rows.map(toRow);
  }
}

export async function reconcileEngagements(input: {
  ledger: EngagementLedger;
  readAttemptFacts: (row: EngagementRow) => Promise<
    | { kind: 'no-claim' }
    | { kind: 'claimed'; attemptIndex: number; attemptUri: string; claimTxHash: string }
    | { kind: 'settled' }
    | { kind: 'lost' }
  >;
  logger?: { warn(message: string): void };
}): Promise<{ reconciled: number; stranded: EngagementRow[] }> {
  const stranded: EngagementRow[] = [];
  let reconciled = 0;
  for (const row of input.ledger.listUnreconciled()) {
    const facts = await input.readAttemptFacts(row);
    if (facts.kind === 'no-claim') {
      input.ledger.recordOutcome(row.idempotencyKey, 'abandoned');
      reconciled += 1;
      continue;
    }
    if (facts.kind === 'settled') {
      input.ledger.recordOutcome(row.idempotencyKey, 'settled');
      reconciled += 1;
      continue;
    }
    if (facts.kind === 'lost') {
      input.ledger.recordOutcome(row.idempotencyKey, 'race-lost');
      reconciled += 1;
      continue;
    }
    if (row.outcome === 'intended') {
      input.ledger.recordClaimed(row.idempotencyKey, facts);
      reconciled += 1;
      continue;
    }
    // Claimed on chain, not settled, and this process did not resume it: the §4 unreleased
    // attempt. It occupies its maxClaims slot until the revised generation's deadline reap.
    stranded.push(row);
    input.logger?.warn(
      `[engagement] unreleased attempt for task ${row.taskId} (attempt ${row.attemptIndex ?? '?'}) `
        + `on ${row.taskCoordinator}: claimed on chain, not settled by this daemon`,
    );
  }
  return { reconciled, stranded };
}
