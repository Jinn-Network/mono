import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugInManifest } from '@jinn-network/client/dist/restorer/plug-ins/manifest.js';
import { fetchMarket, fetchRecentVolume } from '../src/polymarket-stub.js';
import { handle } from '../src/server.js';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('polymarket stub', () => {
  it('returns deterministic prices for the same market id', async () => {
    const a = await fetchMarket('mk-trump-2028');
    const b = await fetchMarket('mk-trump-2028');
    expect(a.yesPrice).toBe(b.yesPrice);
  });

  it('returns yesPrice in [0, 1)', async () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      const m = await fetchMarket(id);
      expect(m.yesPrice).toBeGreaterThanOrEqual(0);
      expect(m.yesPrice).toBeLessThan(1);
    }
  });

  it('volume is non-negative', async () => {
    const v = await fetchRecentVolume('mk-1');
    expect(v.volume24h).toBeGreaterThanOrEqual(0);
  });
});

describe('@jinn-examples/polymarket-mcp manifest + server', () => {
  it('manifest validates and declares the polymarket namespace', async () => {
    const m = await loadPlugInManifest(PKG_ROOT);
    expect(m.name).toBe('@jinn-examples/polymarket-mcp');
    const slot = m.slots[0];
    if (slot.type !== 'mcp-tool') throw new Error('wrong slot type');
    expect(slot.namespace).toBe('polymarket');
    expect(slot.command).toBe('node');
  });

  it('tools/list lists both polymarket tools', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const result = res.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('polymarket_market_state');
    expect(names).toContain('polymarket_recent_volume');
  });

  it('tools/call routes to the stub', async () => {
    const res = await handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'polymarket_market_state',
        arguments: { marketId: 'mk-1' },
      },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as { content: Array<{ text: string }> };
    const market = JSON.parse(result.content[0].text) as { marketId: string };
    expect(market.marketId).toBe('mk-1');
  });
});
