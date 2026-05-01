/**
 * Minimal MCP-style stdio JSON-RPC memory backend exposing
 * `embed`, `query`, and `prune` tools over an in-memory vector store.
 *
 * This example avoids depending on `@modelcontextprotocol/sdk` to keep the
 * package self-contained. The wire shape matches the SDK's stdio transport;
 * upgrade when you need richer MCP capabilities.
 *
 * Spec: spec/2026-04-30-plug-in-surface.md §4.7.5.
 */
import { InMemoryStore } from './in-memory-store.js';

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
    name: 'embed',
    description:
      'Embed text into the vector store under a stable id with optional metadata.',
    inputSchema: {
      type: 'object',
      required: ['id', 'text'],
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        metadata: { type: 'object' },
      },
    },
  },
  {
    name: 'query',
    description: 'Top-k nearest-neighbour search over embedded entries.',
    inputSchema: {
      type: 'object',
      required: ['query', 'k'],
      properties: {
        query: { type: 'string' },
        k: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'prune',
    description: 'Remove entries older than maxAgeMs. Returns the count pruned.',
    inputSchema: {
      type: 'object',
      required: ['maxAgeMs'],
      properties: {
        maxAgeMs: { type: 'integer', minimum: 0 },
      },
    },
  },
];

export function buildHandler(store: InMemoryStore = new InMemoryStore()) {
  return async function handle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    try {
      if (req.method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'vector-store-memory', version: '0.1.0' },
          },
        };
      }
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
        if (name === 'embed') {
          const e = store.embed(
            String(args.id),
            String(args.text),
            (args.metadata as Record<string, unknown>) ?? {},
          );
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ id: e.id, dim: e.vector.length }),
                },
              ],
            },
          };
        }
        if (name === 'query') {
          const r = store.query(String(args.query), Number(args.k));
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(r) }],
            },
          };
        }
        if (name === 'prune') {
          const n = store.prune(Number(args.maxAgeMs));
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ pruned: n }) }],
            },
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `unknown tool: ${name}` },
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
  };
}

export function startStdioServer(): void {
  const handle = buildHandler();
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

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /server\.(t|j)s$/.test(process.argv[1]);
if (isMain) startStdioServer();
