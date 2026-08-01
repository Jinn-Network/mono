import { describe, it, expect, vi } from 'vitest';
import type { PostingOwnerToken } from '@jinn-network/marketplace-binding';
import { admitVerdictIntent, verdictIdempotencyKey } from '../../src/evaluator/intents.js';

const intent = {
  idempotencyKey: '',
  taskId: 7n,
  attemptIndex: 1,
  evaluationTaskDigest: `sha256:${'a'.repeat(64)}` as const,
  wiringEntryId: 'wiring-1',
};

const postingIntent = {
  creatorSafe: '0x0000000000000000000000000000000000000001' as const,
  taskCidDigest: intent.evaluationTaskDigest,
  submissionDigest: `sha256:${'b'.repeat(64)}` as const,
  idempotencyKey: 'evaluation-submission-key',
  createdAt: '2026-07-30T00:00:00.000Z',
};

describe('verdict intent admission', () => {
  it('derives a stable idempotency key from the logical operation identity, not a tx hash', () => {
    const key = verdictIdempotencyKey({
      chainId: 84532,
      taskId: 7n,
      attemptIndex: 1,
      evaluationTaskDigest: intent.evaluationTaskDigest,
    });
    expect(key).toBe(
      verdictIdempotencyKey({
        chainId: 84532,
        taskId: 7n,
        attemptIndex: 1,
        evaluationTaskDigest: intent.evaluationTaskDigest,
      }),
    );
    expect(key).not.toBe(
      verdictIdempotencyKey({
        chainId: 84532,
        taskId: 7n,
        attemptIndex: 2,
        evaluationTaskDigest: intent.evaluationTaskDigest,
      }),
    );
  });

  it('writes the ledger row before the intent is claimable for broadcast', async () => {
    const order: string[] = [];
    const ledger = { admitIntent: vi.fn(async () => { order.push('ledger'); }) };
    const intents = {
      claim: vi.fn(async () => {
        order.push('intent');
        return {
          kind: 'owner' as const,
          intent: postingIntent,
          ownerToken: 'token' as PostingOwnerToken,
        };
      }),
    };
    await admitVerdictIntent(
      { ledger, intents, postingIntent } as never,
      { ...intent, idempotencyKey: 'k' },
    );
    expect(order).toEqual(['ledger', 'intent']);
  });

  it('does not re-admit an intent whose key is already claimed', async () => {
    const ledger = { admitIntent: vi.fn(async () => {}) };
    const intents = {
      claim: vi.fn(async () => ({ kind: 'pending-other' as const, intent: postingIntent })),
    };
    const result = await admitVerdictIntent(
      { ledger, intents, postingIntent } as never,
      { ...intent, idempotencyKey: 'k' },
    );
    expect(result.admitted).toBe(false);
  });
});
