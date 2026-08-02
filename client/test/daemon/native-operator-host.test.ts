import { describe, expect, it, vi } from 'vitest';

import { createNativeOperatorHost } from '../../src/daemon/native-operator-host.js';

describe('native operator host lifecycle', () => {
  it('starts in the fail-closed ownership/recovery order and exposes sanitized health', async () => {
    const order: string[] = [];
    const host = createNativeOperatorHost({
      roleKeyIds: {
        'solver-delivery': 'did:key:solver-delivery',
        'solver-discovery': 'did:key:solver-discovery',
      },
      lease: { acquire: () => { order.push('lease'); }, owned: () => true, release: vi.fn() },
      bindings: { verify: async () => { order.push('bindings'); } },
      venue: {
        rollbackToFinalized: async () => { order.push('venue'); },
        health: async () => ({ canonicalBlock: 101n, finalizedBlock: 100n, caughtUp: true }),
        close: vi.fn(),
      },
      operations: {
        reconcileTransactions: async () => { order.push('transactions'); },
        reconcilePublications: async () => { order.push('publications'); },
        uncertainCount: () => 0,
      },
      discovery: {
        sync: async () => { order.push('sources'); return { lag: 0 }; },
      },
      recovery: {
        recoverBackends: async () => { order.push('backends'); },
      },
      readiness: {
        backend: async () => true,
        evidence: async () => true,
      },
      work: { start: async () => { order.push('work'); }, stop: vi.fn() },
    });

    await host.start();
    expect(order).toEqual([
      'lease', 'bindings', 'venue', 'transactions', 'publications', 'sources', 'backends', 'work',
    ]);
    expect(await host.health()).toEqual({
      mode: 'native-v1',
      roleKeyIds: {
        'solver-delivery': 'did:key:solver-delivery',
        'solver-discovery': 'did:key:solver-discovery',
      },
      sourceLag: 0,
      leaseOwned: true,
      venue: { canonicalBlock: '101', finalizedBlock: '100', caughtUp: true },
      backendReady: true,
      evidenceReady: true,
      uncertainOperations: 0,
      nativeFallbackCount: 0,
    });
    await host.close();
  });

  it('never starts work after a binding, source, evidence, or uncertain-operation refusal', async () => {
    const work = vi.fn();
    const host = createNativeOperatorHost({
      roleKeyIds: { 'solver-delivery': 'did:key:delivery' },
      lease: { acquire: vi.fn(), owned: () => true, release: vi.fn() },
      bindings: { verify: vi.fn(async () => undefined) },
      venue: {
        rollbackToFinalized: vi.fn(async () => undefined),
        health: vi.fn(async () => ({ canonicalBlock: 1n, finalizedBlock: 1n, caughtUp: true })),
        close: vi.fn(),
      },
      operations: {
        reconcileTransactions: vi.fn(async () => undefined),
        reconcilePublications: vi.fn(async () => undefined),
        uncertainCount: () => 1,
      },
      discovery: { sync: vi.fn(async () => ({ lag: 0 })) },
      recovery: { recoverBackends: vi.fn(async () => undefined) },
      readiness: { backend: vi.fn(async () => true), evidence: vi.fn(async () => true) },
      work: { start: work, stop: vi.fn() },
    });

    await expect(host.start()).rejects.toThrow(/uncertain operation/u);
    expect(work).not.toHaveBeenCalled();
    expect((await host.health()).nativeFallbackCount).toBe(0);
  });

  it('releases every acquired owner exactly once when startup fails after lease acquisition', async () => {
    const release = vi.fn(async () => undefined);
    const closeVenue = vi.fn(async () => undefined);
    const stopWork = vi.fn(async () => undefined);
    const host = createNativeOperatorHost({
      roleKeyIds: { 'solver-delivery': 'did:key:delivery' },
      lease: { acquire: vi.fn(), owned: () => true, release },
      bindings: { verify: vi.fn(async () => { throw new Error('binding revoked'); }) },
      venue: {
        rollbackToFinalized: vi.fn(),
        health: vi.fn(async () => ({ canonicalBlock: 1n, finalizedBlock: 1n, caughtUp: true })),
        close: closeVenue,
      },
      operations: {
        reconcileTransactions: vi.fn(), reconcilePublications: vi.fn(), uncertainCount: () => 0,
      },
      discovery: { sync: vi.fn() },
      recovery: { recoverBackends: vi.fn() },
      readiness: { backend: vi.fn(), evidence: vi.fn() },
      work: { start: vi.fn(), stop: stopWork },
    });

    await expect(host.start()).rejects.toThrow('binding revoked');
    expect(stopWork).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(closeVenue).toHaveBeenCalledOnce();
    await host.close();
    expect(release).toHaveBeenCalledOnce();
    expect(closeVenue).toHaveBeenCalledOnce();
  });
});
