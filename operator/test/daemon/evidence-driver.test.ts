import { describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { EvidenceDriverLoop, decidePublication } from '../../src/daemon/evidence-driver.js';

const DIGEST = `sha256:${'f'.repeat(64)}` as const;

describe('evidence publication policy', () => {
  it('publishes a record sealed for delivery', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'delivery', containsCapabilityGrantMaterial: false, containsSecretForward: false },
        new Set(),
      ),
    ).toEqual({ publish: true });
  });

  it('refuses a record that is not sealed for delivery or announcement', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'none', containsCapabilityGrantMaterial: false, containsSecretForward: false },
        new Set(),
      ),
    ).toEqual({ publish: false, reason: 'not-sealed-for-delivery' });
  });

  it('never publishes capability-grant material', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'delivery', containsCapabilityGrantMaterial: true, containsSecretForward: false },
        new Set(),
      ),
    ).toEqual({ publish: false, reason: 'capability-grant-material' });
  });

  it('never publishes a secret forward', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'announcement', containsCapabilityGrantMaterial: false, containsSecretForward: true },
        new Set(),
      ),
    ).toEqual({ publish: false, reason: 'secret-forward' });
  });

  it('is idempotent by digest', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'delivery', containsCapabilityGrantMaterial: false, containsSecretForward: false },
        new Set([DIGEST]),
      ),
    ).toEqual({ publish: false, reason: 'already-published' });
  });
});

describe('evidence driver loop', () => {
  it('syncs and reports indexed and failed counts', async () => {
    const sync = vi.fn(async () => ({ status: 'synchronized' as const, indexed: 2, failed: 0 }));
    const driver = new EvidenceDriverLoop({
      evidence: {
        runtime: {
          sync,
          listIndexingFailures: async () => ({ items: [] }),
          getStatus: async () => ({ pendingAnnouncements: 0 }),
        },
        ports: {},
        close: async () => {},
      } as never,
      intervalMs: 5,
      store: new Store(':memory:'),
    });
    expect(await driver.tick()).toEqual({ indexed: 2, failed: 0, pending: 0 });
    expect(sync).toHaveBeenCalledOnce();
  });

  it('warns once per failed reference and exposes it for the status rollup', async () => {
    const warn = vi.fn();
    const driver = new EvidenceDriverLoop({
      evidence: {
        runtime: {
          sync: async () => ({ status: 'synchronized' as const, indexed: 0, failed: 1 }),
          listIndexingFailures: async () => ({
            items: [
              {
                reference: 'urn:jinn:evidence:record:abc',
                category: 'protocol-nonconformance',
                sourceCode: 'E_CONFORMANCE',
                message: 'record does not conform',
                observedAt: '2026-07-30T09:00:00.000Z',
              },
            ],
          }),
          getStatus: async () => ({ pendingAnnouncements: 3 }),
        },
        ports: {},
        close: async () => {},
      } as never,
      intervalMs: 5,
      store: new Store(':memory:'),
      logger: { info: vi.fn(), warn },
    });
    await driver.tick();
    await driver.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await driver.failures()).toEqual([
      {
        reference: 'urn:jinn:evidence:record:abc',
        category: 'protocol-nonconformance',
        message: 'record does not conform',
      },
    ]);
  });
});
