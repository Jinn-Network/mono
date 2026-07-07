/**
 * Tests for src/api/next-task-id.ts — cached on-chain lookup of the
 * JinnRouter's `nextTaskId()` view. Mirrors the chain-head.ts cache
 * pattern; this is the upstream half of the /health/task-coverage check
 * for issue #567.
 *
 * We mock viem's `createPublicClient` so the test stays hermetic: no
 * RPC traffic is generated, and we can assert cache TTL, error caching,
 * and reset semantics deterministically.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ── viem mock — must be hoisted via vi.mock ──────────────────────────────────
const readContractMock = vi.fn();

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: readContractMock,
    })),
  };
});

// Import AFTER the mock declaration so the module sees the mocked viem.
const { getNextTaskId, _resetNextTaskIdCache } = await import(
  '../src/api/next-task-id.js'
);

describe('getNextTaskId', () => {
  beforeEach(() => {
    readContractMock.mockReset();
    _resetNextTaskIdCache();
  });

  it('returns the on-chain nextTaskId on first call', async () => {
    readContractMock.mockResolvedValue(42n);
    const value = await getNextTaskId();
    expect(value).toBe(42n);
    expect(readContractMock).toHaveBeenCalledTimes(1);
  });

  it('caches successful results for the TTL window (no RPC re-fetch)', async () => {
    readContractMock.mockResolvedValue(42n);

    const a = await getNextTaskId();
    const b = await getNextTaskId();
    const c = await getNextTaskId();

    expect(a).toBe(42n);
    expect(b).toBe(42n);
    expect(c).toBe(42n);
    expect(readContractMock).toHaveBeenCalledTimes(1);
  });

  it('returns null and caches null on RPC error (no retry-storm)', async () => {
    readContractMock.mockRejectedValue(new Error('rpc down'));

    const a = await getNextTaskId();
    const b = await getNextTaskId();

    expect(a).toBeNull();
    expect(b).toBeNull();
    // Critically: only ONE RPC call within the TTL window even after error.
    expect(readContractMock).toHaveBeenCalledTimes(1);
  });

  it('_resetNextTaskIdCache forces a fresh RPC fetch on the next call', async () => {
    readContractMock.mockResolvedValueOnce(10n).mockResolvedValueOnce(99n);

    const a = await getNextTaskId();
    expect(a).toBe(10n);

    _resetNextTaskIdCache();

    const b = await getNextTaskId();
    expect(b).toBe(99n);

    expect(readContractMock).toHaveBeenCalledTimes(2);
  });

  it('after _resetNextTaskIdCache, a fresh error result is also cached as null', async () => {
    readContractMock.mockRejectedValueOnce(new Error('boom'));
    const a = await getNextTaskId();
    expect(a).toBeNull();

    _resetNextTaskIdCache();

    readContractMock.mockResolvedValueOnce(7n);
    const b = await getNextTaskId();
    expect(b).toBe(7n);
  });

  it('calls readContract with the nextTaskId function name (sanity)', async () => {
    readContractMock.mockResolvedValue(1n);
    await getNextTaskId();
    const callArgs = (readContractMock as Mock).mock.calls[0]?.[0] as {
      functionName: string;
    };
    expect(callArgs.functionName).toBe('nextTaskId');
  });
});
