/**
 * The poison ledger for native discovery consumption (#2473, umbrella #2461).
 *
 * ## The wedge this closes
 *
 * Two native-fleet paths could fail forever, every tick, without ever advancing:
 *
 *  - an announcement this consumer's own `decode` rejects. `pollSource` degrades the source
 *    and returns BEFORE `queue()`, so the durable high-water never moves past it. The
 *    in-code trade was stated plainly — "loud and stuck beats silent and lossy" — but stuck
 *    is forever: the same bytes are re-fetched and re-thrown at every poll and that source's
 *    queue never recovers;
 *  - a signed withdrawal whose retraction target is absent from this operator's
 *    authenticated card history. `drainNativeDiscoveryWithdrawals` threw, so the withdrawal
 *    was never acknowledged, `takePendingWithdrawals()` returned it again next tick, and the
 *    throw escaped the WHOLE tick — blocking every withdrawal queued behind it too.
 *
 * ## Why bounded retry rather than skip-on-first-failure
 *
 * Quarantining the first failure would be trivial and wrong. A decode reaches the local
 * trust catalog; a drain reads SQLite. Either can fail transiently, and silently consuming
 * append-only signed history on one hiccup is exactly the lossiness #2529 refused. So the
 * fail-closed behaviour is UNCHANGED below the threshold — the caller still throws what it
 * always threw — and only the Nth *consecutive* failure converts the item into a durable,
 * loudly-announced quarantine that the caller may then step past.
 *
 * A success clears the counter (`clearPoisonFailures`), so unrelated transients spread over
 * a long run cannot accumulate into a spurious quarantine. It does NOT un-quarantine: once
 * an item has been stepped past and its checkpoint advanced, reviving it would reintroduce
 * exactly the ordering hazard the advance was allowed to escape.
 *
 * ## Nothing here is silent
 *
 * A quarantine is durable (the row survives restarts and names sequence, entry digest,
 * announcement id and the failure detail), loud (one `console.warn`), and carries one
 * structured event under the named code `native_discovery_poison_quarantined` — the same
 * surface `loop_watchdog_stale` uses. The event fires once, at the transition, not on every
 * later failure.
 */
import type { SourceIdentity } from '@jinn-network/record-discovery-protocol';
import type { Store } from '../store/store.js';
import { emitStructured } from '../events/emitter.js';

/**
 * Which drain a poisoned item belongs to. Part of the ledger key, so the same announcement
 * id failing to decode and failing to retract are counted — and quarantined — separately.
 */
export type NativeDiscoveryPoisonScope = 'announcement' | 'withdrawal';

/**
 * Consecutive failures before an item is quarantined. Deliberately a constant rather than
 * config: #2473 moves the post-gate configuration surface to a separate issue, and a
 * threshold an operator can lower to 1 would re-open the lossiness this module exists to
 * avoid.
 */
export const NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD = 3;

/** The named event code an operator (or an alert) watches for. */
export const NATIVE_DISCOVERY_POISON_QUARANTINE_EVENT = 'native_discovery_poison_quarantined';

export const NATIVE_DISCOVERY_QUARANTINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS native_discovery_quarantine (
  scope              TEXT NOT NULL,
  source_agent       TEXT NOT NULL,
  source_name        TEXT NOT NULL,
  entry_digest       TEXT NOT NULL,
  announcement_id    TEXT NOT NULL,
  sequence           TEXT NOT NULL,
  failures           INTEGER NOT NULL,
  detail             TEXT NOT NULL,
  first_failed_at    TEXT NOT NULL,
  last_failed_at     TEXT NOT NULL,
  quarantined_at     TEXT,
  PRIMARY KEY (scope, source_agent, source_name, entry_digest, announcement_id)
);
`;

/**
 * The ledger key. It carries `entryDigest` as well as the announcement id, matching the
 * UNIQUE constraints `native_discovery_cards` and `native_discovery_withdrawals` already use,
 * and for the same reason: an announcement is identified by the signed ENTRY that carried it,
 * not by its id alone. Keying on the id alone would mean a source that re-announced a
 * corrected version of a quarantined id, in a new entry, had it silently skipped forever —
 * the quarantine would outlive the bytes that earned it.
 */
interface PoisonKey {
  readonly store: Store;
  readonly scope: NativeDiscoveryPoisonScope;
  readonly source: SourceIdentity;
  readonly entryDigest: string;
  readonly announcementId: string;
}

/**
 * Records one failed attempt at the named item and reports whether it is now quarantined.
 *
 * Idempotent per call, not per item: each call is one attempt. Callers invoke it exactly
 * once per poll/drain pass, so `failures` counts passes.
 */
export function recordPoisonFailure(input: PoisonKey & {
  readonly sequence: string;
  readonly detail: string;
  readonly now?: () => Date;
}): { readonly failures: number; readonly quarantined: boolean } {
  const at = (input.now ?? (() => new Date()))().toISOString();
  input.store.db.prepare(
    `INSERT INTO native_discovery_quarantine
       (scope, source_agent, source_name, entry_digest, announcement_id, sequence,
        failures, detail, first_failed_at, last_failed_at, quarantined_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)
     ON CONFLICT(scope, source_agent, source_name, entry_digest, announcement_id) DO UPDATE SET
       failures = native_discovery_quarantine.failures + 1,
       sequence = excluded.sequence,
       detail = excluded.detail,
       last_failed_at = excluded.last_failed_at`,
  ).run(
    input.scope,
    input.source.agent,
    input.source.name,
    input.entryDigest,
    input.announcementId,
    input.sequence,
    input.detail,
    at,
    at,
  );
  const row = input.store.db.prepare(
    `SELECT failures, quarantined_at FROM native_discovery_quarantine
      WHERE scope = ? AND source_agent = ? AND source_name = ?
        AND entry_digest = ? AND announcement_id = ?`,
  ).get(
    input.scope, input.source.agent, input.source.name, input.entryDigest, input.announcementId,
  ) as { failures: number; quarantined_at: string | null };

  if (row.quarantined_at !== null) return { failures: row.failures, quarantined: true };
  if (row.failures < NATIVE_DISCOVERY_POISON_QUARANTINE_THRESHOLD) {
    return { failures: row.failures, quarantined: false };
  }

  input.store.db.prepare(
    `UPDATE native_discovery_quarantine SET quarantined_at = ?
      WHERE scope = ? AND source_agent = ? AND source_name = ?
        AND entry_digest = ? AND announcement_id = ?`,
  ).run(at, input.scope, input.source.agent, input.source.name, input.entryDigest, input.announcementId);

  const where = `${input.source.agent}/${input.source.name} ${input.scope} `
    + `${input.announcementId} (sequence ${input.sequence}, entry ${input.entryDigest})`;
  const message = `[native-discovery] quarantining ${where} after ${row.failures} consecutive `
    + `failures — the pass will advance past it rather than retry it forever: ${input.detail}`;
  console.warn(message);
  emitStructured({
    kind: 'error',
    message,
    errorCode: NATIVE_DISCOVERY_POISON_QUARANTINE_EVENT,
    details: {
      scope: input.scope,
      sourceAgent: input.source.agent,
      sourceName: input.source.name,
      announcementId: input.announcementId,
      sequence: input.sequence,
      entryDigest: input.entryDigest,
      failures: row.failures,
      detail: input.detail,
    },
  });
  return { failures: row.failures, quarantined: true };
}

/** Has this item already been stepped past? Quarantine is terminal for the item. */
export function isPoisonQuarantined(input: PoisonKey): boolean {
  const row = input.store.db.prepare(
    `SELECT quarantined_at FROM native_discovery_quarantine
      WHERE scope = ? AND source_agent = ? AND source_name = ?
        AND entry_digest = ? AND announcement_id = ?`,
  ).get(
    input.scope, input.source.agent, input.source.name, input.entryDigest, input.announcementId,
  ) as { quarantined_at: string | null } | undefined;
  return row !== undefined && row.quarantined_at !== null;
}

/**
 * Drops the consecutive-failure count after a success. Leaves an existing quarantine in
 * place — see the module docstring for why reviving a stepped-past item is not offered.
 */
export function clearPoisonFailures(input: PoisonKey): void {
  input.store.db.prepare(
    `DELETE FROM native_discovery_quarantine
      WHERE scope = ? AND source_agent = ? AND source_name = ?
        AND entry_digest = ? AND announcement_id = ? AND quarantined_at IS NULL`,
  ).run(
    input.scope, input.source.agent, input.source.name, input.entryDigest, input.announcementId,
  );
}
