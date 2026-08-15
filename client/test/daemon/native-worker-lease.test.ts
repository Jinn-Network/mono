import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { NativeOperatorStateRepository } from '../../src/daemon/native-operator-state.js';

describe('native worker lease', () => {
  it('allows one live owner, renews it, and permits takeover only after expiry', () => {
    let now = new Date('2026-08-02T00:00:00.000Z');
    const store = new Store(':memory:');
    const repo = new NativeOperatorStateRepository(store, { now: () => now });
    const scope = {
      role: 'solver',
      chainId: 84532,
      coordinator: '0x8a34793e10595c89b7e41cc7ff0f76850f44ad98',
      operatorAgent: 'urn:jinn:operator:solver-a',
    } as const;
    expect(repo.acquireLease({ ...scope, ownerId: 'worker-a', ttlMs: 1_000 })).toMatchObject({ ownerId: 'worker-a' });
    expect(() => repo.acquireLease({ ...scope, ownerId: 'worker-b', ttlMs: 1_000 }))
      .toThrow(/already held/u);
    now = new Date('2026-08-02T00:00:00.500Z');
    expect(repo.renewLease({ ...scope, ownerId: 'worker-a', ttlMs: 1_000 }).expiresAt)
      .toBe('2026-08-02T00:00:01.500Z');
    now = new Date('2026-08-02T00:00:01.499Z');
    expect(() => repo.acquireLease({ ...scope, ownerId: 'worker-b', ttlMs: 1_000 }))
      .toThrow(/already held/u);
    now = new Date('2026-08-02T00:00:01.500Z');
    expect(repo.acquireLease({ ...scope, ownerId: 'worker-b', ttlMs: 1_000 })).toMatchObject({ ownerId: 'worker-b' });
    expect(() => repo.renewLease({ ...scope, ownerId: 'worker-a', ttlMs: 1_000 }))
      .toThrow(/not owned/u);
  });
});
