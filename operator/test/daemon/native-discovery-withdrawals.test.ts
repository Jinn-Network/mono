/**
 * Applying a requester's signed withdrawal (one-swap M3, umbrella #2461).
 *
 * Extracted from `native-solver-production.ts`'s tick so the fleet WorkLoop runs the same drain,
 * and covered directly for the first time. The three properties that matter: the retraction target
 * comes from this operator's own authenticated card history (never from the wire), a withdrawal
 * naming an unknown announcement is a hard refusal, and only pre-claim engagements are withdrawn.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { drainNativeDiscoveryWithdrawals } from '../../src/daemon/native-discovery-withdrawals.js';

const SOURCE = { agent: 'did:key:zRequester', name: 'requester' };
const TASK_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SUBMISSION_DIGEST = `sha256:${'b'.repeat(64)}` as const;

let root: string;
let store: Store;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jinn-native-withdrawals-'));
  store = new Store(join(root, 'jinn.db'));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function seedCard(announcementId: string): number {
  store.db.prepare(
    `INSERT INTO native_discovery_cards
       (source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (?, ?, '0000000000000001', ?, ?, ?, ?)`,
  ).run(
    SOURCE.agent, SOURCE.name, `sha256:${'e'.repeat(64)}`, announcementId,
    JSON.stringify({ record: { digest: SUBMISSION_DIGEST }, facts: { taskDigest: TASK_DIGEST } }),
    '2026-08-06T00:00:00.000Z',
  );
  return Number((store.db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
}

function seedEngagement(state: string): void {
  store.db.prepare(
    `INSERT INTO native_engagements
       (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
        submission_uri, submission_digest, state, policy_json, capability_json,
        created_at, updated_at)
     VALUES (?, '84532', '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98', '7', 'solver',
             'urn:jinn:operator:a', ?, 'urn:uuid:33333333-3333-4333-8333-333333333333', ?, ?,
             '{}', '{}', ?, ?)`,
  ).run(
    `sha256:${'1'.repeat(64)}`, TASK_DIGEST, SUBMISSION_DIGEST, state,
    '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
  );
}

function withdrawal(retracts: string) {
  return {
    id: 1,
    source: SOURCE,
    sequence: '0000000000000002',
    entryDigest: `sha256:${'f'.repeat(64)}` as const,
    announcementId: 'withdrawal-1',
    retracts,
    reason: 'reorged' as const,
  };
}

describe('drainNativeDiscoveryWithdrawals', () => {
  it('withdraws a pre-claim engagement and acknowledges both the card and the withdrawal', async () => {
    const cardId = seedCard('announcement-1');
    seedEngagement('discovered');
    const acknowledgeWithdrawal = vi.fn();

    const applied = await drainNativeDiscoveryWithdrawals({
      store,
      discovery: {
        takePendingWithdrawals: () => [withdrawal('announcement-1')],
        acknowledgeWithdrawal,
      },
    });

    expect(applied).toBe(1);
    expect(store.db.prepare(`SELECT state FROM native_engagements`).get()).toEqual({ state: 'withdrawn' });
    expect(store.db.prepare(
      `SELECT acknowledged_at IS NOT NULL AS acked FROM native_discovery_cards WHERE id = ?`,
    ).get(cardId)).toEqual({ acked: 1 });
    expect(acknowledgeWithdrawal).toHaveBeenCalledOnce();
  });

  it('leaves a chain-committed engagement alone — a requester cannot retract a broadcast claim', async () => {
    seedCard('announcement-1');
    seedEngagement('claim-finalized');

    await drainNativeDiscoveryWithdrawals({
      store,
      discovery: {
        takePendingWithdrawals: () => [withdrawal('announcement-1')],
        acknowledgeWithdrawal: vi.fn(),
      },
    });

    expect(store.db.prepare(`SELECT state FROM native_engagements`).get())
      .toEqual({ state: 'claim-finalized' });
  });

  it('refuses a withdrawal naming an announcement absent from authenticated local history', async () => {
    const acknowledgeWithdrawal = vi.fn();
    await expect(drainNativeDiscoveryWithdrawals({
      store,
      discovery: {
        takePendingWithdrawals: () => [withdrawal('announcement-never-seen')],
        acknowledgeWithdrawal,
      },
    })).rejects.toThrow('requester withdrawal target is absent from authenticated history');
    expect(acknowledgeWithdrawal).not.toHaveBeenCalled();
  });
});
