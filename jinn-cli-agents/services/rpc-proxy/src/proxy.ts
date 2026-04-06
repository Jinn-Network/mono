import type { Context } from 'hono';
import type { UpstreamPool } from './upstream.js';

export function createProxyHandler(pool: UpstreamPool) {
  return async (c: Context) => {
    let body: string;
    try {
      body = await c.req.text();
    } catch {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
        400,
      );
    }

    const trimmed = body.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null },
        400,
      );
    }

    try {
      const upstream = await pool.tryRequest(body);
      const responseBody = await upstream.arrayBuffer();

      return new Response(responseBody, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err: any) {
      console.error('[rpc-proxy] All upstreams failed:', err.message);
      return c.json(
        { jsonrpc: '2.0', error: { code: -32603, message: 'All RPC upstreams unavailable' }, id: null },
        502,
      );
    }
  };
}
