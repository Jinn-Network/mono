/**
 * Applying a requester's signed withdrawal to local state — one drain, two callers
 * (one-swap M3, umbrella #2461).
 *
 * Extracted verbatim from `native-solver-production.ts`'s tick. A withdrawal is only actionable
 * against an announcement THIS operator previously accepted and stored, so the retraction target
 * is resolved out of the authenticated local card history rather than trusted from the wire; a
 * withdrawal naming an unknown announcement is a hard refusal, not a no-op.
 *
 * Only pre-claim states (`discovered`, `eligible`) are withdrawn. An engagement that already
 * broadcast a claim is chain-committed; a requester cannot retract it by publishing a record, and
 * the engagement's own settlement path owns its terminal state.
 */
import type { NativeDiscoveryConsumer } from './native-discovery.js';
import type { Store } from '../store/store.js';
import { clearPoisonFailures, recordPoisonFailure } from './native-discovery-quarantine.js';

export async function drainNativeDiscoveryWithdrawals(input: {
  readonly store: Store;
  readonly discovery: Pick<NativeDiscoveryConsumer, 'takePendingWithdrawals' | 'acknowledgeWithdrawal'>;
  readonly now?: () => Date;
}): Promise<number> {
  const now = input.now ?? (() => new Date());
  let applied = 0;
  for (const withdrawal of input.discovery.takePendingWithdrawals()) {
    const target = input.store.db.prepare(
      `SELECT id, card_json FROM native_discovery_cards
        WHERE source_agent = ? AND source_name = ? AND announcement_id = ?
        ORDER BY id DESC LIMIT 1`,
    ).get(withdrawal.source.agent, withdrawal.source.name, withdrawal.retracts) as {
      id: number; card_json: string;
    } | undefined;
    if (target === undefined) {
      // ## A withdrawal naming an unknown announcement no longer wedges the tick (#2473)
      //
      // The refusal is unchanged in kind — this operator will not act on a retraction it
      // cannot resolve against its own authenticated history — but it used to be unchanged
      // FOREVER: the withdrawal was never acknowledged, `takePendingWithdrawals()` returned
      // it again at the next tick, and the throw escaped the whole tick, blocking every
      // withdrawal queued behind it as well. Bounded retry, then quarantine: the first
      // failures still throw (an absent target can be a transient read), and the Nth
      // records the item durably, announces it under the named event code, acknowledges it
      // so it leaves the pending queue, and lets the rest of the drain proceed.
      const poisoned = recordPoisonFailure({
        store: input.store,
        scope: 'withdrawal',
        source: withdrawal.source,
        sequence: withdrawal.sequence,
        entryDigest: withdrawal.entryDigest,
        announcementId: withdrawal.announcementId,
        detail: `withdrawal retracts ${withdrawal.retracts}, which is absent from `
          + 'this operator\'s authenticated card history',
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (!poisoned.quarantined) {
        throw new Error('requester withdrawal target is absent from authenticated history');
      }
      input.discovery.acknowledgeWithdrawal(withdrawal);
      continue;
    }
    clearPoisonFailures({
      store: input.store,
      scope: 'withdrawal',
      source: withdrawal.source,
      entryDigest: withdrawal.entryDigest,
      announcementId: withdrawal.announcementId,
    });
    const card = JSON.parse(target.card_json) as {
      record?: { digest?: string };
      facts?: Record<string, unknown>;
    };
    const taskDigest = card.facts?.['taskDigest'];
    const submissionDigest = card.record?.digest;
    if (typeof taskDigest === 'string' && typeof submissionDigest === 'string') {
      input.store.db.prepare(
        `UPDATE native_engagements SET state = 'withdrawn', updated_at = ?
          WHERE task_digest = ? AND submission_digest = ?
            AND state IN ('discovered', 'eligible')`,
      ).run(now().toISOString(), taskDigest, submissionDigest);
    }
    input.store.db.prepare(
      `UPDATE native_discovery_cards SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`,
    ).run(now().toISOString(), target.id);
    input.discovery.acknowledgeWithdrawal(withdrawal);
    applied += 1;
  }
  return applied;
}
