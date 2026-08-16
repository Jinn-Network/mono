import { describe, it, expect, vi } from 'vitest';
import { buildPredictionTools } from '../../../../src/harnesses/impls/claude-mcp-prediction/mcp-tools.js';
import type { PublicClient } from 'viem';

function makeDeps(overrides: {
  onSubmit?: (s: { probability: string; rationale: string }) => void;
  readContractImpl?: (args: { functionName: string }) => unknown;
} = {}) {
  const readContract = vi.fn(async (args: { functionName: string }) => {
    if (overrides.readContractImpl) return overrides.readContractImpl(args);
    if (args.functionName === 'latestRoundData') {
      // roundId, answer, startedAt, updatedAt, answeredInRound
      return [10n, 340_000_000_000n, 1_700_000_000n, 1_700_000_000n, 10n];
    }
    if (args.functionName === 'decimals') return 8;
    throw new Error(`unmocked ${args.functionName}`);
  });
  const publicClient = { readContract } as unknown as PublicClient;
  return {
    feed: '0x000000000000000000000000000000000000feed' as `0x${string}`,
    feedDescription: 'ETH / USD',
    venue: 'chainlink-base-sepolia' as const,
    publicClient,
    onSubmit: overrides.onSubmit ?? vi.fn(),
  };
}

async function parseToolResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe('buildPredictionTools', () => {
  it('returns exactly two tools with expected names', () => {
    const deps = makeDeps();
    const tools = buildPredictionTools(deps);
    expect(tools.map(t => t.name)).toEqual(['read_chainlink_price', 'submit_prediction']);
  });

  describe('read_chainlink_price', () => {
    it('returns scaled price + round metadata on success', async () => {
      const deps = makeDeps();
      const [readTool] = buildPredictionTools(deps);
      const result = await readTool!.handler({});
      const parsed = await parseToolResult(result);
      expect(parsed.price).toBe('3400');
      expect(parsed.roundId).toBe('10');
      expect(parsed.updatedAt).toBe(1_700_000_000 * 1000);
      expect(parsed.feed).toBe(deps.feed);
      expect(parsed.feedDescription).toBe('ETH / USD');
      expect(parsed.venue).toBe('chainlink-base-sepolia');
    });

    it('returns CHAINLINK_READ_FAILED on RPC error', async () => {
      const deps = makeDeps({
        readContractImpl: () => { throw new Error('rpc down'); },
      });
      const [readTool] = buildPredictionTools(deps);
      const result = await readTool!.handler({});
      const parsed = await parseToolResult(result);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('CHAINLINK_READ_FAILED');
      expect(parsed.message).toContain('rpc down');
    });
  });

  describe('submit_prediction', () => {
    it('records the submission + returns accepted=true', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildPredictionTools(deps);
      const result = await submitTool!.handler({ probability: 0.55, rationale: 'ETH above threshold' });
      const parsed = await parseToolResult(result);
      expect(parsed.accepted).toBe(true);
      expect(parsed.probability).toBe('0.5500');
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onSubmit).toHaveBeenCalledWith({ probability: '0.5500', rationale: 'ETH above threshold' });
    });

    it('rounds probability to 4 decimal places', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildPredictionTools(deps);
      await submitTool!.handler({ probability: 0.123456789, rationale: 'test' });
      expect(onSubmit).toHaveBeenCalledWith({ probability: '0.1235', rationale: 'test' });
    });

    it('accepts 0 and 1 as boundary values', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildPredictionTools(deps);
      const r0 = await parseToolResult(await submitTool!.handler({ probability: 0, rationale: 'no' }));
      const r1 = await parseToolResult(await submitTool!.handler({ probability: 1, rationale: 'yes' }));
      expect(r0.accepted).toBe(true);
      expect(r1.accepted).toBe(true);
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });

    it('rejects probability out of [0,1]', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildPredictionTools(deps);
      const high = await parseToolResult(await submitTool!.handler({ probability: 1.5, rationale: 'x' }));
      const low = await parseToolResult(await submitTool!.handler({ probability: -0.1, rationale: 'x' }));
      expect(high.error).toBe(true);
      expect(high.code).toBe('INVALID_ARGS');
      expect(low.error).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('rejects empty rationale', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildPredictionTools(deps);
      const r = await parseToolResult(await submitTool!.handler({ probability: 0.5, rationale: '' }));
      expect(r.error).toBe(true);
      expect(r.code).toBe('INVALID_ARGS');
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('rejects non-number probability', async () => {
      const onSubmit = vi.fn();
      const deps = makeDeps({ onSubmit });
      const [, submitTool] = buildPredictionTools(deps);
      const r = await parseToolResult(await submitTool!.handler({ probability: 'hello', rationale: 'x' }));
      expect(r.error).toBe(true);
      expect(r.code).toBe('INVALID_ARGS');
    });
  });
});
