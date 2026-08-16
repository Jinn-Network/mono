import { describe, it, expect, vi } from 'vitest';
import { buildApyPredictionTools } from '../../../../src/harnesses/impls/claude-mcp-prediction-apy/mcp-tools.js';
import { liquidityRateRayToApyBps } from '../../../../src/venues/aave-v3/client.js';
import type { PublicClient } from 'viem';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as `0x${string}`;

/** 15-tuple matching Aave Pool.getReserveData outputs (see AAVE_POOL_ABI). */
function reserveDataTuple(liquidityRate: bigint, lastUpdate: bigint) {
  return [
    0n,
    0n,
    liquidityRate,
    0n,
    0n,
    0n,
    lastUpdate,
    0,
    ZERO_ADDR,
    ZERO_ADDR,
    ZERO_ADDR,
    ZERO_ADDR,
    0n,
    0n,
    0n,
  ] as const;
}

function makeDeps(overrides: {
  onSubmit?: (s: { predictedBps: string; rationale: string }) => void;
  readContractImpl?: (args: { functionName: string }) => unknown;
  getBlockImpl?: () => Promise<{ number: bigint; timestamp: bigint }>;
  chainId?: number;
} = {}) {
  const readContract = vi.fn(async (args: { functionName: string }) => {
    if (overrides.readContractImpl) return overrides.readContractImpl(args);
    if (args.functionName === 'getReserveData') {
      return reserveDataTuple(0n, 1_700_000_000n);
    }
    throw new Error(`unmocked ${args.functionName}`);
  });
  const getBlock = vi.fn(async () =>
    overrides.getBlockImpl?.() ?? Promise.resolve({ number: 12_345n, timestamp: 1_700_000_000n }),
  );
  const getChainId = vi.fn(async () => overrides.chainId ?? 84532);
  const publicClient = { readContract, getBlock, getChainId } as unknown as PublicClient;
  return {
    pool: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    reserve: '0x2222222222222222222222222222222222222222' as `0x${string}`,
    reserveSymbol: 'USDC',
    venue: 'aave-v3-base-sepolia' as const,
    publicClient,
    onSubmit: overrides.onSubmit ?? vi.fn(),
  };
}

async function parseToolResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe('buildApyPredictionTools', () => {
  it('returns exactly two tools with expected names', () => {
    const deps = makeDeps();
    const tools = buildApyPredictionTools(deps);
    expect(tools.map((t) => t.name)).toEqual(['read_aave_reserve', 'submit_apy_prediction']);
  });

  describe('read_aave_reserve', () => {
    it('returns apyBps from currentLiquidityRate + metadata on success', async () => {
      const ray = 1234567890123456789012345678n;
      const deps = makeDeps({
        readContractImpl: ({ functionName }) => {
          if (functionName !== 'getReserveData') throw new Error('unexpected');
          return reserveDataTuple(ray, 99n);
        },
      });
      const [readTool] = buildApyPredictionTools(deps);
      const result = await readTool!.handler({});
      const parsed = await parseToolResult(result);
      expect(parsed.apyBps).toBe(liquidityRateRayToApyBps(ray));
      expect(parsed.liquidityRateRay).toBe(String(ray));
      expect(parsed.lastUpdateTimestamp).toBe(99);
      expect(parsed.pool).toBe(deps.pool);
      expect(parsed.reserve).toBe(deps.reserve);
      expect(parsed.reserveSymbol).toBe('USDC');
      expect(parsed.venue).toBe('aave-v3-base-sepolia');
      expect(parsed.chainId).toBe(84532);
      expect(parsed.blockNumber).toBe('12345');
    });

    it('returns AAVE_READ_FAILED on RPC error', async () => {
      const deps = makeDeps({
        readContractImpl: () => {
          throw new Error('rpc down');
        },
      });
      const [readTool] = buildApyPredictionTools(deps);
      const result = await readTool!.handler({});
      const parsed = await parseToolResult(result);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('AAVE_READ_FAILED');
      expect(parsed.message).toContain('rpc down');
    });
  });

  describe('submit_apy_prediction', () => {
    it('records the submission + returns accepted=true', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildApyPredictionTools(deps);
      const result = await submitTool!.handler({ predictedBps: 350, rationale: 'Spot APY ~350 bps' });
      const parsed = await parseToolResult(result);
      expect(parsed.accepted).toBe(true);
      expect(parsed.predictedBps).toBe('350');
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onSubmit).toHaveBeenCalledWith({ predictedBps: '350', rationale: 'Spot APY ~350 bps' });
    });

    it('accepts 0 as boundary value', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildApyPredictionTools(deps);
      const r = await parseToolResult(await submitTool!.handler({ predictedBps: 0, rationale: 'zero' }));
      expect(r.accepted).toBe(true);
      expect(onSubmit).toHaveBeenCalledWith({ predictedBps: '0', rationale: 'zero' });
    });

    it('rejects non-integer predictedBps', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildApyPredictionTools(deps);
      const r = await parseToolResult(await submitTool!.handler({ predictedBps: 350.5, rationale: 'x' }));
      expect(r.error).toBe(true);
      expect(r.code).toBe('INVALID_ARGS');
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('rejects negative predictedBps', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildApyPredictionTools(deps);
      const r = await parseToolResult(await submitTool!.handler({ predictedBps: -1, rationale: 'x' }));
      expect(r.error).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('rejects predictedBps above 1_000_000', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildApyPredictionTools(deps);
      const r = await parseToolResult(await submitTool!.handler({ predictedBps: 1_000_001, rationale: 'x' }));
      expect(r.error).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('rejects empty rationale', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildApyPredictionTools(deps);
      const r = await parseToolResult(await submitTool!.handler({ predictedBps: 100, rationale: '' }));
      expect(r.error).toBe(true);
      expect(r.code).toBe('INVALID_ARGS');
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
