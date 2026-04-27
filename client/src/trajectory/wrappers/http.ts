/**
 * Traced HTTP client wrapper.
 *
 * Emits one span per call. spanKind controls attribute profile:
 *   - jinn.llm_call → gen_ai.* attributes from OTel GenAI semconv
 *   - jinn.venue_io → net.peer.name + http.* attributes
 *
 * Collector scrubs secret headers automatically (Authorization, etc.).
 * On throw: span records ERROR status with message; error is re-raised.
 */

import type { TrajectoryCollector } from '../collector.js';

export interface HttpRequestLike {
  url: string;
  method: string;
  headers?: Record<string, string>;
}

export interface HttpResponseLike {
  status: number;
  body?: unknown;
}

export interface GenAiAttrs {
  system: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TracedHttpCallParams {
  collector: TrajectoryCollector;
  spanKind: 'jinn.llm_call' | 'jinn.venue_io';
  req: HttpRequestLike;
  invoke: () => Promise<HttpResponseLike>;
  genAi?: GenAiAttrs;
  parentSpanId?: string;
  /** Human-readable span name. Defaults to `${method} ${url.host}`. */
  name?: string;
}

function nowNanos(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function tracedHttpCall(
  p: TracedHttpCallParams,
): Promise<HttpResponseLike> {
  const start = nowNanos();
  const name = p.name ?? `${p.req.method} ${hostOf(p.req.url)}`;
  const baseAttrs: Record<string, unknown> = {
    'jinn.span.kind': p.spanKind,
    'net.peer.name': hostOf(p.req.url),
    'http.request.method': p.req.method,
    'url.full': p.req.url,
  };
  if (p.req.headers) {
    for (const [k, v] of Object.entries(p.req.headers)) {
      baseAttrs[`http.request.header.${k.toLowerCase()}`] = v;
    }
  }
  if (p.spanKind === 'jinn.llm_call' && p.genAi) {
    baseAttrs['gen_ai.system'] = p.genAi.system;
    baseAttrs['gen_ai.request.model'] = p.genAi.model;
    baseAttrs['gen_ai.usage.input_tokens'] = p.genAi.inputTokens;
    baseAttrs['gen_ai.usage.output_tokens'] = p.genAi.outputTokens;
  }

  try {
    const res = await p.invoke();
    const end = nowNanos();
    p.collector.addSpan({
      name,
      kind: 'CLIENT',
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes: {
        ...baseAttrs,
        'http.response.status_code': res.status,
      },
      events: [],
      status: { code: res.status >= 400 ? 'ERROR' : 'OK' },
      parentSpanId: p.parentSpanId,
    });
    return res;
  } catch (err) {
    const end = nowNanos();
    p.collector.addSpan({
      name,
      kind: 'CLIENT',
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes: {
        ...baseAttrs,
        // Provide a stub status so jinn.venue_io profile requirement is met.
        'http.response.status_code': 0,
      },
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
