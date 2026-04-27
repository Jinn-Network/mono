/**
 * Traced MCP tool-call wrapper.
 *
 * Every MCP tool invocation emits one jinn.mcp_call span. Top-level args
 * are surfaced as mcp.tool.args.<name> attributes (collector scrubs secret
 * names). Nested arg redaction is Plan F tightening.
 */

import type { TrajectoryCollector } from '../collector.js';

export interface TracedMcpCallParams<T> {
  collector: TrajectoryCollector;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  invoke: () => Promise<T>;
  parentSpanId?: string;
}

function nowNanos(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

export async function tracedMcpCall<T>(p: TracedMcpCallParams<T>): Promise<T> {
  const start = nowNanos();
  const argAttrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.args)) {
    argAttrs[`mcp.tool.args.${k}`] = v;
  }
  const baseAttrs: Record<string, unknown> = {
    'jinn.span.kind': 'jinn.mcp_call',
    'mcp.server.name': p.server,
    'mcp.tool.name': p.tool,
    ...argAttrs,
  };

  try {
    const res = await p.invoke();
    p.collector.addSpan({
      name: `mcp.${p.server}.${p.tool}`,
      kind: 'CLIENT',
      startTimeUnixNano: start,
      endTimeUnixNano: nowNanos(),
      attributes: baseAttrs,
      events: [],
      status: { code: 'OK' },
      parentSpanId: p.parentSpanId,
    });
    return res;
  } catch (err) {
    const end = nowNanos();
    p.collector.addSpan({
      name: `mcp.${p.server}.${p.tool}`,
      kind: 'CLIENT',
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes: baseAttrs,
      events: [
        {
          timeUnixNano: end,
          name: 'exception',
          attributes: { 'exception.message': (err as Error).message },
        },
      ],
      status: { code: 'ERROR', message: (err as Error).message },
      parentSpanId: p.parentSpanId,
    });
    throw err;
  }
}
