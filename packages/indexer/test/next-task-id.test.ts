/**
 * Tests for src/api/next-task-id.ts — cached on-chain lookup of the active
 * JinnRouter's TaskCoordinator `nextTaskId()` view. Mirrors the chain-head.ts
 * cache pattern; this is the upstream half of the /health/task-coverage check
 * for issue #567 / #1304.
 *
 * We mock viem's `createPublicClient` so the test stays hermetic: no
 * RPC traffic is generated, and we can assert cache TTL, error caching,
 * and reset semantics deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

// ── viem mock — must be hoisted via vi.mock ──────────────────────────────────
const readContractMock = vi.fn();
const createPublicClientMock = vi.fn(() => ({
  readContract: readContractMock,
}));

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: createPublicClientMock,
  };
});

const TRACKED_ENVS = ['PONDER_RPC_URL_84532'];
const ORIGINAL_ENV: Record<string, string | undefined> = {};
const ACTIVE_ROUTER = '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247';
const ACTIVE_COORDINATOR = '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98';

async function loadNextTaskIdModule(): Promise<{
  getNextTaskId: () => Promise<bigint | null>;
  _resetNextTaskIdCache: () => void;
}> {
  const mod = await import('../src/api/next-task-id.js');
  mod._resetNextTaskIdCache();
  return mod;
}

describe('getNextTaskId', () => {
  beforeEach(() => {
    for (const key of TRACKED_ENVS) {
      ORIGINAL_ENV[key] = process.env[key];
      delete process.env[key];
    }
    vi.resetModules();
    readContractMock.mockReset();
    createPublicClientMock.mockClear();
  });

  afterEach(() => {
    for (const key of TRACKED_ENVS) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reads the active router taskCoordinator first, then reads nextTaskId from that coordinator', async () => {
    readContractMock.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === 'taskCoordinator') return Promise.resolve(ACTIVE_COORDINATOR);
      if (functionName === 'nextTaskId') return Promise.resolve(46n);
      return Promise.reject(new Error(`unexpected function ${functionName}`));
    });

    const { getNextTaskId } = await loadNextTaskIdModule();
    const value = await getNextTaskId();
    expect(value).toBe(46n);
    expect(readContractMock).toHaveBeenCalledTimes(2);

    const routerCall = (readContractMock as Mock).mock.calls[0]?.[0] as {
      address: string;
      functionName: string;
    };
    const coordinatorCall = (readContractMock as Mock).mock.calls[1]?.[0] as {
      address: string;
      functionName: string;
    };
    expect(routerCall).toMatchObject({
      address: ACTIVE_ROUTER,
      functionName: 'taskCoordinator',
    });
    expect(coordinatorCall).toMatchObject({
      address: ACTIVE_COORDINATOR,
      functionName: 'nextTaskId',
    });
  });

  it('caches successful results for the TTL window (no RPC re-fetch)', async () => {
    readContractMock.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === 'taskCoordinator') return Promise.resolve(ACTIVE_COORDINATOR);
      if (functionName === 'nextTaskId') return Promise.resolve(42n);
      return Promise.reject(new Error(`unexpected function ${functionName}`));
    });

    const { getNextTaskId } = await loadNextTaskIdModule();
    const a = await getNextTaskId();
    const b = await getNextTaskId();
    const c = await getNextTaskId();

    expect(a).toBe(42n);
    expect(b).toBe(42n);
    expect(c).toBe(42n);
    expect(readContractMock).toHaveBeenCalledTimes(2);
  });

  it('returns null and caches null on RPC error (no retry-storm)', async () => {
    readContractMock.mockRejectedValue(new Error('rpc down'));

    const { getNextTaskId } = await loadNextTaskIdModule();
    const a = await getNextTaskId();
    const b = await getNextTaskId();

    expect(a).toBeNull();
    expect(b).toBeNull();
    // Critically: only ONE RPC call within the TTL window even after error.
    expect(readContractMock).toHaveBeenCalledTimes(1);
  });

  it('_resetNextTaskIdCache forces a fresh RPC fetch on the next call', async () => {
    readContractMock
      .mockResolvedValueOnce(ACTIVE_COORDINATOR)
      .mockResolvedValueOnce(10n)
      .mockResolvedValueOnce(ACTIVE_COORDINATOR)
      .mockResolvedValueOnce(99n);

    const { getNextTaskId, _resetNextTaskIdCache } = await loadNextTaskIdModule();
    const a = await getNextTaskId();
    expect(a).toBe(10n);

    _resetNextTaskIdCache();

    const b = await getNextTaskId();
    expect(b).toBe(99n);

    expect(readContractMock).toHaveBeenCalledTimes(4);
  });

  it('after _resetNextTaskIdCache, a fresh error result is also cached as null', async () => {
    readContractMock.mockRejectedValueOnce(new Error('boom'));
    const { getNextTaskId, _resetNextTaskIdCache } = await loadNextTaskIdModule();
    const a = await getNextTaskId();
    expect(a).toBeNull();

    _resetNextTaskIdCache();

    readContractMock.mockResolvedValueOnce(ACTIVE_COORDINATOR).mockResolvedValueOnce(7n);
    const b = await getNextTaskId();
    expect(b).toBe(7n);
  });

  it('uses the same capped comma-separated RPC fallback shape as Ponder config', async () => {
    process.env.PONDER_RPC_URL_84532 = [
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
      'https://e.example',
    ].join(',');

    await loadNextTaskIdModule();
    const options = ((createPublicClientMock as unknown as Mock).mock.calls[0]?.[0] ??
      {}) as { transport: (opts: unknown) => any };
    const instantiated = options.transport({ chain: { id: 84532 } });
    expect(instantiated.config.type).toBe('fallback');
    expect(instantiated.value.transports).toHaveLength(4);
  });

  it('calls readContract with taskCoordinator then nextTaskId function names (sanity)', async () => {
    readContractMock
      .mockResolvedValueOnce(ACTIVE_COORDINATOR)
      .mockResolvedValueOnce(1n);
    const { getNextTaskId } = await loadNextTaskIdModule();
    await getNextTaskId();
    const routerCallArgs = (readContractMock as Mock).mock.calls[0]?.[0] as {
      functionName: string;
    };
    const coordinatorCallArgs = (readContractMock as Mock).mock.calls[1]?.[0] as {
      functionName: string;
    };
    expect(routerCallArgs.functionName).toBe('taskCoordinator');
    expect(coordinatorCallArgs.functionName).toBe('nextTaskId');
  });
});
