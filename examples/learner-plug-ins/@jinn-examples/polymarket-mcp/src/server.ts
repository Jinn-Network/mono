/**
 * Minimal MCP-style stdio JSON-RPC server exposing two Polymarket tools.
 *
 * This example intentionally avoids depending on `@modelcontextprotocol/sdk`
 * to keep the package self-contained and offline-buildable. Real builders
 * upgrade to the SDK for full capabilities (resources, prompts, sampling)
 * — the wire shape here is compatible with the SDK's stdio transport.
 *
 * Spec: spec/2026-04-30-plug-in-surface.md §4.7.3.
 */
import { fetchMarket, fetchRecentVolume } from './polymarket-stub.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = [
  {
    name: 'polymarket_market_state',
    description: 'Fetch current state of a Polymarket binary market.',
    inputSchema: {
      type: 'object',
      required: ['marketId'],
      properties: { marketId: { type: 'string' } },
    },
  },
  {
    name: 'polymarket_recent_volume',
    description: 'Fetch 24h trading volume for a Polymarket market.',
    inputSchema: {
      type: 'object',
      required: ['marketId'],
      properties: { marketId: { type: 'string' } },
    },
  },
];

export async function handle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  try {
    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (req.method === 'tools/call') {
      const params = (req.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const name = params.name ?? '';
      const args = params.arguments ?? {};
      if (name === 'polymarket_market_state') {
        const m = await fetchMarket(String(args.marketId));
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(m) }] },
        };
      }
      if (name === 'polymarket_recent_volume') {
        const v = await fetchRecentVolume(String(args.marketId));
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(v) }] },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      };
    }
    if (req.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'polymarket-stub', version: '0.1.0' },
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method not found: ${req.method}` },
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: (err as Error).message },
    };
  }
}

export function startStdioServer(): void {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        continue;
      }
      void handle(req).then((res) => {
        process.stdout.write(`${JSON.stringify(res)}\n`);
      });
    }
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

// CLI entry: when invoked as `node dist/server.js`, start the stdio loop.
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /server\.(t|j)s$/.test(process.argv[1]);
if (isMain) startStdioServer();
