/**
 * Path C LLM API proxy.
 *
 * The proxy is intentionally boring: it forwards request bytes to an upstream
 * Anthropic/OpenAI-compatible endpoint, returns upstream response bytes
 * unchanged, and records one exchange for the capture pipeline.
 */

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Tracer } from '@opentelemetry/api';
import {
  emitLlmProxyExchange,
  type LlmProxyExchange,
  type LlmProxyProvider,
} from './llm-proxy-spans.js';

export interface LlmProxyConfig {
  provider: LlmProxyProvider;
  upstreamBaseUrl: string;
  /**
   * Optional tracer. When supplied, each forwarded request emits a
   * `llm-proxy.request` span with GenAI-ish attributes.
   */
  tracer?: Tracer;
  /** Test/daemon hook for observing normalized exchanges. */
  onExchange?: (exchange: LlmProxyExchange) => void;
}

export interface LlmProxyServer {
  port: number;
  close(): Promise<void>;
  server: HttpServer;
}

function proxyHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'connection' ||
      lower === 'keep-alive' ||
      lower === 'transfer-encoding'
    ) {
      continue;
    }
    out.set(key, value);
  }
  return out;
}

function responseHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'connection') continue;
    out.set(key, value);
  }
  return out;
}

function upstreamUrl(baseUrl: string, path: string, query: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}${query}`;
}

export function createLlmProxyApp(config: LlmProxyConfig): Hono {
  const app = new Hono();

  app.all('*', async (c) => {
    const requestUrl = new URL(c.req.url);
    const requestBody = c.req.method === 'GET' || c.req.method === 'HEAD'
      ? ''
      : await c.req.text();
    const sessionId = c.req.header('x-jinn-session-id') ?? randomUUID();
    const startedAt = Date.now();

    const upstream = await fetch(
      upstreamUrl(config.upstreamBaseUrl, requestUrl.pathname, requestUrl.search),
      {
        method: c.req.method,
        headers: proxyHeaders(c.req.raw.headers),
        body: requestBody === '' ? undefined : requestBody,
      },
    );
    const responseBytes = await upstream.arrayBuffer();
    const responseBody = Buffer.from(responseBytes).toString('utf-8');

    const exchange: LlmProxyExchange = {
      provider: config.provider,
      sessionId,
      method: c.req.method,
      path: requestUrl.pathname,
      status: upstream.status,
      durationMs: Date.now() - startedAt,
      requestBody,
      responseBody,
    };
    config.onExchange?.(exchange);
    if (config.tracer) emitLlmProxyExchange(config.tracer, exchange);

    return new Response(responseBytes, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers),
    });
  });

  return app;
}

export async function startLlmProxyServer(
  config: LlmProxyConfig & { port: number; bindHost?: string },
): Promise<LlmProxyServer> {
  const app = createLlmProxyApp(config);
  return new Promise((resolve, reject) => {
    const server = serve({
      fetch: app.fetch,
      port: config.port,
      hostname: config.bindHost ?? '127.0.0.1',
    }, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : config.port;
      resolve({
        port: actualPort,
        server: server as HttpServer,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}
