import { describe, expect, it, vi } from 'vitest';

import { createNativeOperatorHost } from '../../src/daemon/native-operator-host.js';

describe('native operator host lifecycle', () => {
  it('starts in the fail-closed ownership/recovery order and exposes sanitized health', async () => {
    const order: string[] = [];
    const host = createNativeOperatorHost({
      role: 'solver',
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
        backendRequired: true,
        evidenceRequired: true,
        backend: async () => true,
        evidence: async () => true,
        publicSource: async () => true,
        executableDigest: `sha256:${'ab'.repeat(32)}`,
      },
      work: { start: async () => { order.push('work'); }, stop: vi.fn() },
    });

    await host.start();
    expect(order).toEqual([
      'lease', 'bindings', 'venue', 'transactions', 'publications', 'sources', 'backends', 'work',
    ]);
    expect(await host.health()).toEqual({
      mode: 'native-v1',
      role: 'solver',
      roleKeyIds: {
        'solver-delivery': 'did:key:solver-delivery',
        'solver-discovery': 'did:key:solver-discovery',
      },
      sourceLag: 0,
      sourceLagBySource: {},
      leaseOwned: true,
      venue: { canonicalBlock: '101', finalizedBlock: '100', caughtUp: true },
      backendReady: true,
      backendRequired: true,
      executableDigest: `sha256:${'ab'.repeat(32)}`,
      evidenceReady: true,
      evidenceRequired: true,
      publicSourceReady: true,
      uncertainOperations: 0,
      nativeFallbackCount: 0,
    });
    await host.close();
  });

  it('never starts work after a binding, source, evidence, or uncertain-operation refusal', async () => {
    const work = vi.fn();
    const host = createNativeOperatorHost({
      role: 'solver',
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
      readiness: {
        backendRequired: true, evidenceRequired: true,
        backend: vi.fn(async () => true), evidence: vi.fn(async () => true), publicSource: vi.fn(async () => true),
      },
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
      role: 'solver',
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
      readiness: {
        backendRequired: true, evidenceRequired: true,
        backend: vi.fn(), evidence: vi.fn(), publicSource: vi.fn(),
      },
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

  it('renews the scoped worker lease while running and stops renewal during close', async () => {
    vi.useFakeTimers();
    try {
      const renew = vi.fn(async () => undefined);
      const host = createNativeOperatorHost({
        role: 'solver',
        roleKeyIds: { 'solver-delivery': 'did:key:delivery' },
        leaseRenewIntervalMs: 10_000,
        lease: { acquire: vi.fn(), owned: () => true, renew, release: vi.fn() },
        bindings: { verify: vi.fn(async () => undefined) },
        venue: {
          rollbackToFinalized: vi.fn(async () => undefined),
          health: vi.fn(async () => ({ canonicalBlock: 1n, finalizedBlock: 1n, caughtUp: true })),
          close: vi.fn(),
        },
        operations: {
          reconcileTransactions: vi.fn(async () => undefined),
          reconcilePublications: vi.fn(async () => undefined),
          uncertainCount: () => 0,
        },
        discovery: { sync: vi.fn(async () => ({ lag: 0 })) },
        recovery: { recoverBackends: vi.fn(async () => undefined) },
        readiness: {
          backendRequired: true, evidenceRequired: true,
          backend: vi.fn(async () => true), evidence: vi.fn(async () => true), publicSource: vi.fn(async () => true),
        },
        work: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
      });

      await host.start();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(renew).toHaveBeenCalledTimes(2);
      await host.close();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(renew).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails health after a background work-loop failure instead of reporting a healthy idle worker', async () => {
    const failure = new Error('settlement reconciliation failed');
    const host = createNativeOperatorHost({
      role: 'solver',
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
        uncertainCount: () => 0,
      },
      discovery: { sync: vi.fn(async () => ({ lag: 0 })) },
      recovery: { recoverBackends: vi.fn(async () => undefined) },
      readiness: {
        backendRequired: true, evidenceRequired: true,
        backend: vi.fn(async () => true), evidence: vi.fn(async () => true), publicSource: vi.fn(async () => true),
      },
      work: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        failure: () => failure,
      },
    });

    await host.start();
    await expect(host.health()).rejects.toThrow(/background work loop failed.*settlement reconciliation failed/u);
    await host.close();
  });
});
