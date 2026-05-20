import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Address } from 'viem';
import type { ClaimRelayerConfig } from './config.js';
import { redactConfig } from './config.js';
import type { ClaimRelayerStore } from './db.js';
import type { ClaimRelayer } from './relayer.js';
import { redactSecrets } from './redact.js';

export interface StatusPayload {
  ok: boolean;
  ready: boolean;
  uptimeSeconds: number;
  config: Record<string, unknown>;
  stats: ReturnType<ClaimRelayer['getStatus']>;
  checkpoint: string;
  tickets: {
    byStatus: Record<string, number>;
    recent: Array<Record<string, unknown>>;
  };
}

export function buildStatusPayload(args: {
  config: ClaimRelayerConfig;
  store: ClaimRelayerStore;
  relayer: ClaimRelayer;
  startedAtMs: number;
}): StatusPayload {
  const stats = args.relayer.getStatus();
  const redactedStats = {
    ...stats,
    lastError: stats.lastError ? redactSecrets(stats.lastError) : null,
  };
  return {
    ok: true,
    ready: redactedStats.ready,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - args.startedAtMs) / 1000)),
    config: redactConfig(args.config),
    stats: redactedStats,
    checkpoint: args.store.getCheckpoint(args.config.startBlock).toString(),
    tickets: {
      byStatus: args.store.countByStatus(),
      recent: args.store.listTickets(20),
    },
  };
}

export function createStatusServer(args: {
  config: ClaimRelayerConfig;
  store: ClaimRelayerStore;
  relayer: ClaimRelayer;
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
  const body = JSON.stringify(payload, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    return value as Address | unknown;
  });
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}
