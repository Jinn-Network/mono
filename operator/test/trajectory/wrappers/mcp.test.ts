import { describe, it, expect } from 'vitest';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { tracedMcpCall } from '../../../src/trajectory/wrappers/mcp.js';

describe('tracedMcpCall', () => {
  it('emits a jinn.mcp_call span with server + tool attrs', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    const res = await tracedMcpCall({
      collector: c,
      server: 'hyperliquid',
      tool: 'place_order',
      args: { symbol: 'BTC', size: 0.01 },
      invoke: async () => ({ ok: true, orderId: 'oid' }),
    });
    expect(res).toEqual({ ok: true, orderId: 'oid' });
    const s = c.snapshot().spans[0];
    expect(s.attributes['jinn.span.kind']).toBe('jinn.mcp_call');
    expect(s.attributes['mcp.server.name']).toBe('hyperliquid');
    expect(s.attributes['mcp.tool.name']).toBe('place_order');
    expect(s.attributes['mcp.tool.args.symbol']).toBe('BTC');
    expect(s.attributes['mcp.tool.args.size']).toBe(0.01);
  });

  it('redacts secret arg values', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    await tracedMcpCall({
      collector: c,
      server: 'x',
      tool: 't',
      args: { apiKey: 'xyz', symbol: 'BTC' },
      invoke: async () => ({}),
    });
    const s = c.snapshot().spans[0];
    expect(s.attributes['mcp.tool.args.apiKey']).toBe('<redacted:mcp.tool.args.apiKey>');
    expect(s.attributes['mcp.tool.args.symbol']).toBe('BTC');
    expect(c.snapshot().redactionManifest.totalRedactions).toBe(1);
  });

  it('records ERROR on throw and rethrows', async () => {
    const c = new TrajectoryCollector({ taskCid: 'bafy', runId: 'r' });
    await expect(
      tracedMcpCall({
        collector: c,
        server: 'x',
        tool: 't',
        args: {},
        invoke: async () => {
          throw new Error('mcp-down');
        },
      }),
    ).rejects.toThrow('mcp-down');
    expect(c.snapshot().spans[0].status.code).toBe('ERROR');
  });
});
