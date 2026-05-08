import type { Tracer } from '@opentelemetry/api';
import { SpanKind } from '@opentelemetry/api';

export type LlmProxyProvider = 'anthropic' | 'openai';

export interface LlmProxyExchange {
  provider: LlmProxyProvider;
  sessionId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestBody: string;
  responseBody: string;
}

function parseJsonBody(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function exchangeToSpanAttributes(exchange: LlmProxyExchange): Record<string, unknown> {
  const request = parseJsonBody(exchange.requestBody);
  const response = parseJsonBody(exchange.responseBody);
  const model =
    typeof request?.['model'] === 'string'
      ? request['model']
      : typeof response?.['model'] === 'string'
        ? response['model']
        : undefined;

  return {
    'jinn.session.id': exchange.sessionId,
    'jinn.capture.path': 'C',
    'jinn.span.kind': 'jinn.llm_call',
    'llm.proxy.provider': exchange.provider,
    'http.request.method': exchange.method,
    'url.path': exchange.path,
    'http.response.status_code': exchange.status,
    'duration.ms': exchange.durationMs,
    'gen_ai.system': exchange.provider,
    ...(model ? { 'gen_ai.request.model': model } : {}),
    'llm.request.body': exchange.requestBody,
    'llm.response.body': exchange.responseBody,
  };
}

export function emitLlmProxyExchange(tracer: Tracer, exchange: LlmProxyExchange): void {
  const span = tracer.startSpan('llm-proxy.request', { kind: SpanKind.CLIENT });
  const attrs = exchangeToSpanAttributes(exchange);
  for (const [key, value] of Object.entries(attrs)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      span.setAttribute(key, value);
    }
  }
  if (exchange.status >= 400) {
    span.setStatus({ code: 2, message: `HTTP ${exchange.status}` });
  }
  span.end();
}
