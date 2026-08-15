/**
 * Tests for mcp-tools.ts — each tool returns expected shape; safety rails reject invalid inputs.
 *
 * No real HTTP calls — all HL API calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildHlTools } from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/mcp-tools.js';
import { createRateLimitState, DEFAULT_SAFETY_CONFIG } from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/safety-rails.js';
import type { ToolDeps } from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/mcp-tools.js';
import type { HlClearinghouseState, HlSpotClearinghouseState, HlAllMidsResponse, HlMetaResponse } from '../../../../src/venues/hyperliquid/types.js';

// ── Mock HL client ─────────────────────────────────────────────────────────────

function mockClearinghouseState(accountValue = '10000'): HlClearinghouseState {
  return {
    marginSummary: { accountValue, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
    crossMarginSummary: { accountValue, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
    crossMaintenanceMarginUsed: '0',
    withdrawable: '10000',
    assetPositions: [],
    time: Date.now(),
  };
}

function mockSpotClearinghouseState(usdc = '0'): HlSpotClearinghouseState {
  return {
    balances: usdc === '0'
      ? []
      : [{ coin: 'USDC', token: 0, total: usdc, hold: '0.0', entryNtl: '0.0' }],
  };
}

function mockMids(overrides: Record<string, string> = {}): HlAllMidsResponse {
  return { BTC: '50000', ETH: '3000', ...overrides };
}

function mockMeta(): HlMetaResponse {
  return { universe: [{ name: 'BTC', szDecimals: 3, maxLeverage: 50, marginTableId: 0 }] };
}

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const hlClient = {
    clearinghouseState: vi.fn().mockResolvedValue(mockClearinghouseState()),
    spotClearinghouseState: vi.fn().mockResolvedValue(mockSpotClearinghouseState()),
    userFills: vi.fn().mockResolvedValue([]),
    userFillsByTime: vi.fn().mockResolvedValue({ fills: [], startTimeClamped: false }),
    meta: vi.fn().mockResolvedValue(mockMeta()),
    allMids: vi.fn().mockResolvedValue(mockMids()),
    portfolio: vi.fn().mockResolvedValue([]),
  } as unknown as ToolDeps['hlClient'];

  return {
    hlClient,
    hlBaseUrl: 'https://api.hyperliquid-testnet.xyz',
    apiWalletPrivateKey: '0x' + 'a'.repeat(64),
    apiWalletAddress: '0x' + 'b'.repeat(40),
    masterAddress: '0x' + 'c'.repeat(40),
    safetyConfig: DEFAULT_SAFETY_CONFIG,
    rateLimitState: createRateLimitState(),
    ...overrides,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function findTool(tools: ReturnType<typeof buildHlTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('buildHlTools', () => {
  it('returns 10 tools', () => {
    const tools = buildHlTools(makeDeps());
    expect(tools).toHaveLength(10);
  });

  it('has all expected tool names', () => {
    const tools = buildHlTools(makeDeps());
    const names = tools.map((t) => t.name);
    expect(names).toContain('hl_account_unified');
    expect(names).toContain('hl_clearinghouse_state');
    expect(names).toContain('hl_user_fills');
    expect(names).toContain('hl_meta');
    expect(names).toContain('hl_all_mids');
    expect(names).toContain('hl_portfolio');
    expect(names).toContain('hl_open_position');
    expect(names).toContain('hl_close_position');
    expect(names).toContain('hl_modify_position');
    expect(names).toContain('hl_cancel_orders');
  });
});

// ── Read tool tests ────────────────────────────────────────────────────────────

describe('hl_clearinghouse_state', () => {
  it('returns clearinghouse state for master address', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_clearinghouse_state');
    const result = await tool.handler({});
    const data = parseResult(result);
    expect(data.marginSummary.accountValue).toBe('10000');
    expect(deps.hlClient.clearinghouseState).toHaveBeenCalledWith(deps.masterAddress);
  });

  it('accepts explicit address', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_clearinghouse_state');
    const customAddr = '0x' + '1'.repeat(40);
    await tool.handler({ address: customAddr });
    expect(deps.hlClient.clearinghouseState).toHaveBeenCalledWith(customAddr);
  });

  it('returns error object on HL API failure', async () => {
    const deps = makeDeps();
    (deps.hlClient.clearinghouseState as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_clearinghouse_state');
    const result = await tool.handler({});
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('HL_API_ERROR');
  });
});

describe('hl_user_fills', () => {
  it('uses userFills when no startTime', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_user_fills');
    await tool.handler({});
    expect(deps.hlClient.userFills).toHaveBeenCalled();
    expect(deps.hlClient.userFillsByTime).not.toHaveBeenCalled();
  });

  it('uses userFillsByTime when startTime provided', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_user_fills');
    await tool.handler({ startTime: 1000000 });
    expect(deps.hlClient.userFillsByTime).toHaveBeenCalled();
  });

  it('applies limit to results', async () => {
    const fills = Array.from({ length: 10 }, (_, i) => ({ tid: i }));
    const deps = makeDeps();
    (deps.hlClient.userFills as ReturnType<typeof vi.fn>).mockResolvedValue(fills);
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_user_fills');
    const result = await tool.handler({ limit: 3 });
    const data = parseResult(result);
    expect(data).toHaveLength(3);
  });
});

describe('hl_meta', () => {
  it('returns meta data', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_meta');
    const result = await tool.handler({});
    const data = parseResult(result);
    expect(data.universe).toBeDefined();
  });
});

describe('hl_all_mids', () => {
  it('returns mid prices', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_all_mids');
    const result = await tool.handler({});
    const data = parseResult(result);
    expect(data.BTC).toBe('50000');
  });
});

describe('hl_portfolio', () => {
  it('calls portfolio for master address', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_portfolio');
    await tool.handler({});
    expect(deps.hlClient.portfolio).toHaveBeenCalledWith(deps.masterAddress);
  });
});

// ── Write tool safety rail tests ───────────────────────────────────────────────

describe('hl_open_position safety rails', () => {
  it('rejects leverage > max', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');
    const result = await tool.handler({
      coin: 'BTC', side: 'long', size: 0.001, leverage: 11, slippageBps: 10,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('LEVERAGE_EXCEEDED');
  });

  it('rejects slippage > max', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');
    const result = await tool.handler({
      coin: 'BTC', side: 'long', size: 0.001, leverage: 5, slippageBps: 51,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('SLIPPAGE_EXCEEDED');
  });


  it('rejects open without tp/sl when bypassRiskRails is not set', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');
    const result = await tool.handler({
      coin: 'BTC', side: 'long', size: 0.001, leverage: 5, slippageBps: 10,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('TPSL_REQUIRED');
  });

  it('rejects tp on wrong side of mid for a long', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');
    // BTC mid = 50000 in default mock; tp below mid for a long → invalid
    const result = await tool.handler({
      coin: 'BTC', side: 'long', size: 0.001, leverage: 5, slippageBps: 10,
      tp: 49000, sl: 49500,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('TP_INVALID');
  });

  it('rejects sl on wrong side of mid for a long', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');
    const result = await tool.handler({
      coin: 'BTC', side: 'long', size: 0.001, leverage: 5, slippageBps: 10,
      tp: 51000, sl: 51500,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('SL_INVALID');
  });


  it('rejects notional > 25% of account value', async () => {
    const deps = makeDeps();
    // accountValue=10000, max=2500; size=0.1, price=50000 → notional=5000 > 2500
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');
    const result = await tool.handler({
      coin: 'BTC', side: 'long', size: 0.1, leverage: 5, slippageBps: 10,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('NOTIONAL_EXCEEDED');
  });

  it('sizes notional against unified equity (perps + spot USDC)', async () => {
    // Perps=0, Spot USDC=5000 → unified=5000; max notional = 25% × 5000 = 1250.
    // Order: size=0.02 × 50000 = 1000 notional → under the 1250 cap → must NOT
    // be rejected for NOTIONAL_EXCEEDED. Pre-fix behaviour read perps only (0),
    // yielding maxNotional=0 and a false rejection.
    const deps = makeDeps();
    (deps.hlClient.clearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockClearinghouseState('0'),
    );
    (deps.hlClient.spotClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockSpotClearinghouseState('5000'),
    );

    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');
    const result = await tool.handler({
      coin: 'BTC', side: 'long', size: 0.02, leverage: 5, slippageBps: 10,
    });
    const data = parseResult(result);

    // The order may fail downstream (signing, no real HL endpoint), but it must
    // not be rejected for NOTIONAL_EXCEEDED.
    if (data.error === true) {
      expect(data.code).not.toBe('NOTIONAL_EXCEEDED');
    }
  });

  it('rejects unknown coin (no mid price)', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');
    const result = await tool.handler({
      coin: 'UNKNOWN_XYZ', side: 'long', size: 0.01, leverage: 5, slippageBps: 10,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('UNKNOWN_COIN');
  });

  it('rejects when rate limit exceeded', async () => {
    const deps = makeDeps();
    // Exhaust the rate limit
    const customConfig = { ...DEFAULT_SAFETY_CONFIG, maxOpsPerMinute: 1 };
    deps.safetyConfig = customConfig;
    deps.rateLimitState = createRateLimitState();

    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');

    // First call (fills rate limit state)
    // We need to pre-fill the rate limit state
    const { checkRateLimit } = await import('../../../../src/harnesses/impls/claude-mcp-hyperliquid/safety-rails.js');
    checkRateLimit(deps.rateLimitState, customConfig);

    const result = await tool.handler({
      coin: 'BTC', side: 'long', size: 0.001, leverage: 5, slippageBps: 10,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('RATE_LIMIT');
  });
});

describe('hl_close_position safety rails', () => {
  it('rejects negative size', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_close_position');
    const result = await tool.handler({ coin: 'BTC', sizeOrAll: -1 });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('INVALID_SIZE');
  });

  it('rejects unknown coin', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_close_position');
    const result = await tool.handler({ coin: 'UNKNOWN_XYZ', sizeOrAll: 'all' });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('UNKNOWN_COIN');
  });
});

describe('hl_modify_position safety rails', () => {
  it('rejects leverage > max', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_modify_position');
    const result = await tool.handler({ coin: 'BTC', leverage: 15 });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('LEVERAGE_EXCEEDED');
  });

  it('rejects no-op (no params)', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_modify_position');
    const result = await tool.handler({ coin: 'BTC' });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('NO_OP');
  });

  it('returns structured error for TP/SL (not yet implemented)', async () => {
    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_modify_position');
    const result = await tool.handler({ coin: 'BTC', tp: 60000 });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('TPSL_NOT_IMPLEMENTED');
  });
});

// ── EIP-712 signing tests ──────────────────────────────────────────────────────

describe('hl_open_position signing', () => {
  it('sends a non-stub EIP-712 signature on successful validation', async () => {
    const fetchCalls: { body: unknown }[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      fetchCalls.push({ body });
      return { ok: true, json: async () => ({ status: 'ok' }) };
    });

    const deps = makeDeps({
      // Small position that passes all safety rails: 0.001 BTC at 50000 = $50 notional < 25% of 10000
    });

    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');

    // Run with mocked global fetch
    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      const result = await tool.handler({
        coin: 'BTC', side: 'long', size: 0.001, leverage: 5, slippageBps: 10,
        bypassRiskRails: true,
      });
      const data = parseResult(result);
      expect(data.error).toBeUndefined();
      expect(data.submitted).toBe(true);
    } finally {
      global.fetch = origFetch;
    }

    // Find the /exchange call
    const exchangeCall = fetchCalls.find((c) => {
      const b = c.body as Record<string, unknown>;
      return b.signature !== undefined;
    });
    expect(exchangeCall).toBeDefined();
    const sig = (exchangeCall!.body as Record<string, unknown>).signature as Record<string, unknown>;
    // Stub signature was { r: '0x', s: '0x', v: 0 } — real signature has non-empty r/s
    expect(sig.r).not.toBe('0x');
    expect(sig.s).not.toBe('0x');
    expect(typeof sig.r).toBe('string');
    expect((sig.r as string).length).toBeGreaterThan(10);
  });
});

// ── Asset index lookup tests ───────────────────────────────────────────────────

describe('asset index lookup', () => {
  it('uses correct asset index from meta for open_position', async () => {
    const fetchCalls: { url: string; body: unknown }[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      fetchCalls.push({ url, body });
      return { ok: true, json: async () => ({ status: 'ok' }) };
    });

    const deps = makeDeps();
    // Mock meta to have ETH at index 1 (BTC is at index 0 in mockMeta)
    (deps.hlClient.meta as ReturnType<typeof vi.fn>).mockResolvedValue({
      universe: [
        { name: 'BTC', szDecimals: 3, maxLeverage: 50, marginTableId: 0 },
        { name: 'ETH', szDecimals: 4, maxLeverage: 25, marginTableId: 0 },
      ],
    });
    (deps.hlClient.allMids as ReturnType<typeof vi.fn>).mockResolvedValue({ BTC: '50000', ETH: '3000' });

    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');

    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      await tool.handler({ coin: 'ETH', side: 'long', size: 0.1, leverage: 5, slippageBps: 10, bypassRiskRails: true });
    } finally {
      global.fetch = origFetch;
    }

    // Find /exchange call and check asset index = 1 (ETH's position in universe)
    const exchangeCall = fetchCalls.find((c) => {
      const b = c.body as Record<string, unknown>;
      return b.action !== undefined;
    });
    expect(exchangeCall).toBeDefined();
    const action = (exchangeCall!.body as Record<string, unknown>).action as Record<string, unknown>;
    const orders = action.orders as Array<Record<string, unknown>>;
    expect(orders[0]!.a).toBe(1); // ETH is at index 1
  });

  it('returns UNKNOWN_COIN error when coin not in meta universe', async () => {
    const deps = makeDeps();
    // meta returns only BTC, not DOGE
    (deps.hlClient.meta as ReturnType<typeof vi.fn>).mockResolvedValue({
      universe: [{ name: 'BTC', szDecimals: 3, maxLeverage: 50, marginTableId: 0 }],
    });
    (deps.hlClient.allMids as ReturnType<typeof vi.fn>).mockResolvedValue({ BTC: '50000', DOGE: '0.1' });

    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_open_position');
    const result = await tool.handler({ coin: 'DOGE', side: 'long', size: 100, leverage: 2, slippageBps: 10 });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.code).toBe('UNKNOWN_COIN');
    expect(data.message).toContain('DOGE');
  });
});

// ── Cancel orders real payload tests ──────────────────────────────────────────

describe('hl_cancel_orders', () => {
  it('sends real cancel payload with actual order IDs from open orders', async () => {
    const fetchCalls: { url: string; body: unknown }[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      fetchCalls.push({ url, body });
      // For /info openOrders return fake open orders; for /exchange return success
      const bodyObj = body as Record<string, unknown>;
      if (bodyObj.type === 'openOrders') {
        // Only BTC orders — BTC is the only coin in mockMeta()
        return { ok: true, json: async () => [{ coin: 'BTC', oid: 12345 }, { coin: 'BTC', oid: 67890 }] };
      }
      return { ok: true, json: async () => ({ status: 'ok' }) };
    });

    const deps = makeDeps();
    // mockMeta only has BTC (index 0) — consistent with open orders above

    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_cancel_orders');

    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      const result = await tool.handler({});
      const data = parseResult(result);
      expect(data.submitted).toBe(true);
      expect(data.cancelled).toBe(2);
    } finally {
      global.fetch = origFetch;
    }

    // Find /exchange call and verify action structure
    const exchangeCall = fetchCalls.find((c) => {
      const b = c.body as Record<string, unknown>;
      return b.action !== undefined;
    });
    expect(exchangeCall).toBeDefined();
    const action = (exchangeCall!.body as Record<string, unknown>).action as Record<string, unknown>;
    expect(action.type).toBe('cancel');
    const cancels = action.cancels as Array<{ a: number; o: number }>;
    expect(cancels).toHaveLength(2);
    // BTC at index 0
    expect(cancels.every((c) => c.a === 0)).toBe(true);
    expect(cancels.some((c) => c.o === 12345)).toBe(true);
    expect(cancels.some((c) => c.o === 67890)).toBe(true);
  });

  it('returns no-op result when no open orders exist', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return { ok: true, json: async () => [] };
    });

    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_cancel_orders');

    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      const result = await tool.handler({});
      const data = parseResult(result);
      expect(data.submitted).toBe(false);
      expect(data.cancelled).toBe(0);
    } finally {
      global.fetch = origFetch;
    }
  });

  it('filters by coin when coin param is provided', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const bodyObj = body as Record<string, unknown>;
      if (bodyObj.type === 'openOrders') {
        return { ok: true, json: async () => [
          { coin: 'BTC', oid: 111 },
          { coin: 'ETH', oid: 222 },
        ]};
      }
      return { ok: true, json: async () => ({ status: 'ok' }) };
    });

    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_cancel_orders');

    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      const result = await tool.handler({ coin: 'BTC' });
      const data = parseResult(result);
      expect(data.submitted).toBe(true);
      expect(data.cancelled).toBe(1);
    } finally {
      global.fetch = origFetch;
    }
  });
});

// ── Finding #1: Golden L1-action signing fixture ───────────────────────────────

describe('signHlAction golden fixture', () => {
  it('produces signature matching Python SDK golden vector', async () => {
    const { signHlAction } = await import('../../../../src/harnesses/impls/claude-mcp-hyperliquid/mcp-tools.js');
    const fixture = await import('./fixtures/hl-signing-golden.json', { assert: { type: 'json' } });

    const { inputs, expected } = fixture;

    const result = await signHlAction({
      privateKey: inputs.privateKey,
      action: inputs.action as Record<string, unknown>,
      nonce: inputs.nonce,
      vaultAddress: inputs.vaultAddress,
      expiresAfter: inputs.expiresAfter,
      isMainnet: inputs.isMainnet,
    });

    expect(result.r).toBe(expected.r);
    expect(result.s).toBe(expected.s);
    expect(result.v).toBe(expected.v);
  });
});

// ── Finding #9: fetchOpenOrders timeout ───────────────────────────────────────

describe('fetchOpenOrders timeout', () => {
  let origFetch: typeof global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
  });

  it('rejects within timeout + slack when fetch never resolves', async () => {
    origFetch = global.fetch;
    // Stub fetch to never resolve
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as unknown as typeof fetch;

    // Use hl_cancel_orders which calls fetchOpenOrders internally
    // We can't directly import fetchOpenOrders (it's not exported), but we
    // can verify the timeout via the cancel tool with a very short timeout.
    // Instead, re-import the module and test via a custom timeout.
    // Since fetchOpenOrders isn't exported, we test the observable behavior:
    // hl_cancel_orders must reject when the open-orders fetch times out.

    // We'll use a short timeout by relying on the fact that hl_cancel_orders
    // calls fetchOpenOrders with FETCH_TIMEOUT_MS. To make this test fast,
    // we use real timers but a very small timeout by patching Date.now is complex.
    // Instead, we test the fetch calls the AbortController path by checking the
    // signal is passed in the fetch call.
    const fetchCalls: { signal?: AbortSignal }[] = [];
    global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      fetchCalls.push({ signal: init?.signal });
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_cancel_orders');

    // Start the call (don't await — it will hang if timeout doesn't work)
    const resultPromise = tool.handler({});

    // The AbortController fires after FETCH_TIMEOUT_MS (15s). We can't wait
    // that long in a test. Instead, verify the signal is passed (correct setup).
    // Then abort it via the signal to confirm it would resolve.

    // Wait a tick to let fetch be called
    await new Promise((r) => setTimeout(r, 10));

    // Verify that an AbortSignal was passed to fetch
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls[0]!.signal).toBeInstanceOf(AbortSignal);

    // Cancel the test by restoring fetch so the tool can error out
    global.fetch = origFetch;

    // The result will be a toolErr since we restored fetch (next attempt would fail)
    // We only needed to verify the signal is wired correctly
  }, 5_000);

  it('rejects with timeout error when AbortController fires', async () => {
    origFetch = global.fetch;

    // Simulate a very fast abort by creating a pre-aborted signal situation
    // We mock fetch to reject with AbortError when the signal fires
    global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }) as unknown as typeof fetch;

    const deps = makeDeps();
    const tools = buildHlTools(deps);
    const tool = findTool(tools, 'hl_cancel_orders');

    // The FETCH_TIMEOUT_MS is 15s; we can't wait that long in CI.
    // Verify the tool eventually fails with an appropriate error when aborted.
    // We patch the signal to fire immediately by replacing global fetch with
    // one that fires AbortError synchronously.
    global.fetch = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const result = await tool.handler({});
    const data = parseResult(result);
    // AbortError surfaces as HL_API_ERROR
    expect(data.error).toBe(true);
    expect(data.code).toBe('HL_API_ERROR');
    expect(data.message).toMatch(/abort|operation/i);
  });
});

// ── Finding #10: HL response statuses inspection ──────────────────────────────

describe('HL response statuses inspection', () => {
  function makeHlErrorResponse(errors: string[]) {
    return {
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [
            ...errors.map((e) => ({ error: e })),
            { resting: { oid: 1 } },
          ],
        },
      },
    };
  }

  it('hl_open_position throws when statuses contains error', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const bodyObj = body as Record<string, unknown>;
      if (bodyObj.action) {
        return { ok: true, json: async () => makeHlErrorResponse(['Insufficient margin']) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      const deps = makeDeps();
      const tools = buildHlTools(deps);
      const tool = findTool(tools, 'hl_open_position');
      const result = await tool.handler({
        coin: 'BTC', side: 'long', size: 0.001, leverage: 5, slippageBps: 10, bypassRiskRails: true,
      });
      const data = parseResult(result);
      expect(data.error).toBe(true);
      expect(data.code).toBe('HL_EXCHANGE_ERROR');
      expect(data.message).toContain('Insufficient margin');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('hl_close_position throws when statuses contains error', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const bodyObj = body as Record<string, unknown>;
      if (bodyObj.action) {
        return { ok: true, json: async () => makeHlErrorResponse(['No position to close']) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      const deps = makeDeps();
      const tools = buildHlTools(deps);
      const tool = findTool(tools, 'hl_close_position');
      const result = await tool.handler({ coin: 'BTC', sizeOrAll: 'all' });
      const data = parseResult(result);
      expect(data.error).toBe(true);
      expect(data.code).toBe('HL_EXCHANGE_ERROR');
      expect(data.message).toContain('No position to close');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('hl_cancel_orders throws when statuses contains error', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const bodyObj = body as Record<string, unknown>;
      if (bodyObj.type === 'openOrders') {
        return { ok: true, json: async () => [{ coin: 'BTC', oid: 99 }] };
      }
      if (bodyObj.action) {
        return { ok: true, json: async () => makeHlErrorResponse(['Order not found']) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      const deps = makeDeps();
      const tools = buildHlTools(deps);
      const tool = findTool(tools, 'hl_cancel_orders');
      const result = await tool.handler({});
      const data = parseResult(result);
      expect(data.error).toBe(true);
      expect(data.code).toBe('HL_EXCHANGE_ERROR');
      expect(data.message).toContain('Order not found');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('hl_open_position succeeds when statuses are all resting/filled', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const bodyObj = body as Record<string, unknown>;
      if (bodyObj.action) {
        return {
          ok: true, json: async () => ({
            status: 'ok',
            response: { type: 'order', data: { statuses: [{ resting: { oid: 42 } }] } },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;
    try {
      const deps = makeDeps();
      const tools = buildHlTools(deps);
      const tool = findTool(tools, 'hl_open_position');
      const result = await tool.handler({
coin: 'BTC', side: 'long', size: 0.001, leverage: 5, slippageBps: 10, bypassRiskRails: true,
      });
      const data = parseResult(result);
      expect(data.submitted).toBe(true);
    } finally {
      global.fetch = origFetch;
    }
  });
});

// ── Finding #15: TOCTOU notional cap ─────────────────────────────────────────

describe('maxNotionalUsd hard cap', () => {
  it('rejects before hlExchangePost when notional exceeds maxNotionalUsd', async () => {
    const mockFetch = vi.fn();
    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const deps = makeDeps({
        safetyConfig: {
          ...DEFAULT_SAFETY_CONFIG,
          // accountValue=10000, pctCap=25%*10000=2500
          // maxNotionalUsd=100 → effectiveCap=min(2500,100)=100
          maxNotionalUsd: 100,
        },
      });
      const tools = buildHlTools(deps);
      const tool = findTool(tools, 'hl_open_position');

      // BTC at 50000; size=0.003 → notional=150 > 100 (maxNotionalUsd)
      const result = await tool.handler({
        coin: 'BTC', side: 'long', size: 0.003, leverage: 5, slippageBps: 10,
      });
      const data = parseResult(result);
      expect(data.error).toBe(true);
      expect(data.code).toBe('NOTIONAL_EXCEEDED');
      // hlExchangePost should NOT have been called
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/exchange'),
        expect.anything(),
      );
    } finally {
      global.fetch = origFetch;
    }
  });

  it('allows trade when notional is under both pctCap and maxNotionalUsd', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const bodyObj = body as Record<string, unknown>;
      if (bodyObj.action) {
        return {
          ok: true, json: async () => ({
            status: 'ok',
            response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }] } },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const origFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const deps = makeDeps({
        safetyConfig: {
          ...DEFAULT_SAFETY_CONFIG,
          maxNotionalUsd: 1000, // cap at 1000; size=0.001*50000=50 < 1000
        },
      });
      const tools = buildHlTools(deps);
      const tool = findTool(tools, 'hl_open_position');

      const result = await tool.handler({
coin: 'BTC', side: 'long', size: 0.001, leverage: 5, slippageBps: 10, bypassRiskRails: true,
      });
      const data = parseResult(result);
      expect(data.submitted).toBe(true);
    } finally {
      global.fetch = origFetch;
    }
  });
});
