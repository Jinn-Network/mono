/**
 * Minimal status server for the enrichment worker (#779), mirroring
 * claim-relayer's /health + /ready + /status surface.
 *
 *  - /health: always 200 (process liveness).
 *  - /ready:  200 once the worker has connected to the DB and the schema
 *             resolves; 503 before (the Railway healthcheck gates on this).
 *  - /status: JSON — uptime, redacted config, batch stats (last error included).
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { EnrichmentWorkerConfig } from './config.js';
import { redactConfig } from './config.js';
import type { EnrichmentRunner } from './runner.js';

export interface StatusPayload {
  ok: boolean;
  ready: boolean;
  uptimeSeconds: number;
  config: Record<string, unknown>;
  stats: ReturnType<EnrichmentRunner['getStatus']>;
}

export function buildStatusPayload(args: {
  config: EnrichmentWorkerConfig;
  runner: EnrichmentRunner;
  startedAtMs: number;
}): StatusPayload {
  const stats = args.runner.getStatus();
  return {
    ok: true,
    ready: stats.ready,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - args.startedAtMs) / 1000)),
    config: redactConfig(args.config),
    stats,
  };
}

export function createStatusServer(args: {
  config: EnrichmentWorkerConfig;
  runner: EnrichmentRunner;
  startedAtMs?: number;
}): http.Server {
  const startedAtMs = args.startedAtMs ?? Date.now();
  return http.createServer((req, res) => {
    routeRequest(req, res, () => buildStatusPayload({ ...args, startedAtMs }));
  });
}

function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  status: () => StatusPayload,
): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'GET') {
    writeJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  if (url.pathname === '/health') {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/ready') {
    const payload = status();
    writeJson(res, payload.ready ? 200 : 503, { ok: payload.ready, ready: payload.ready });
    return;
  }

  if (url.pathname === '/status') {
    writeJson(res, 200, status());
    return;
  }

  writeJson(res, 404, { ok: false, error: 'not found' });
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}
