/**
 * Shared gather for introspection verbs (local SQLite + fleet + RPC).
 *
 * When the HTTP API is reachable, merges a healthier `rpc` snapshot from GET /v1/status
 * into the local gather (short timeout). Per spec §10.1 / issue #2404, `/v1/status` is now
 * token-gated (§14.5) — the fetch sends the on-disk UI token via the same
 * `x-jinn-ui-token` header path `daemon-control-client.ts` uses. A 401 is a real,
 * actionable failure (the token is missing or stale) and is surfaced explicitly rather
 * than swallowed into the silent local-gather fallback; a connection failure (daemon not
 * running, wrong port, ECONNREFUSED, timeout) still falls back to the local gather —
 * that is the expected, non-exceptional "daemon is down" case this function exists for.
 */

import type { GatheredStatusRaw } from '../api/status-build.js';
import type { StatusV1Response } from '../api/status-build.js';
import { gatherGatheredStatusRaw, type StatusGatherConfig } from '../api/gather-status.js';
import { loadConfig, getConfigPathFromArgs } from '../config.js';
import { Store } from '../store/store.js';
import { resolveUiToken } from './daemon-control-client.js';

export class IntrospectionUnauthorizedError extends Error {
  constructor() {
    super(
      'GET /v1/status returned 401 unauthorized — the UI token at ~/.jinn-client/ui-token ' +
        'is missing, stale, or belongs to a different daemon instance. Restart the daemon ' +
        '(it regenerates the token) or point --config at the right instance.',
    );
    this.name = 'IntrospectionUnauthorizedError';
  }
}

async function tryMergeStatusFromHttp(
  config: ReturnType<typeof loadConfig>,
  local: GatheredStatusRaw,
): Promise<GatheredStatusRaw> {
  const url = `http://127.0.0.1:${config.apiPort}/v1/status`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 500);
  try {
    // resolveUiToken() reads the on-disk token file — deliberately INSIDE the
    // try: an unreadable file (e.g. the daemon runs as another user on the
    // same host, a realistic case) throws EACCES, which must fall through to
    // the same connection-error handling below rather than escape as an
    // unhandled rejection carrying a raw fs error (absolute path included).
    const token = resolveUiToken();
    const res = await fetch(url, {
      signal: ac.signal,
      headers: token ? { 'x-jinn-ui-token': token } : {},
    });
    if (res.status === 401) {
      throw new IntrospectionUnauthorizedError();
    }
    if (!res.ok) return local;
    const remote = (await res.json()) as StatusV1Response;
    const next: GatheredStatusRaw = {
      ...local,
      shutdownState: remote.daemon?.shutdownState ?? local.shutdownState,
      daemonStartedAt: remote.daemon?.startedAt ?? local.daemonStartedAt,
    };
    if (remote.rpc?.ok && !local.rpc.ok) {
      next.rpc = {
        ok: remote.rpc.ok,
        chainId: remote.rpc.chainId,
        blockNumber: remote.rpc.blockNumber,
        ...(remote.rpc.error ? { error: remote.rpc.error } : {}),
      };
    }
    return next;
  } catch (err) {
    if (err instanceof IntrospectionUnauthorizedError) throw err;
    /* connection error (daemon down, wrong port, timeout) — local gather is authoritative */
  } finally {
    clearTimeout(t);
  }
  return local;
}

export async function gatherIntrospectionRaw(opts?: {
  argv?: string[];
}): Promise<GatheredStatusRaw> {
  const fromVerbFlags = getConfigPathFromArgs(opts?.argv ?? []);
  const fromProcess =
    typeof process !== 'undefined' ? getConfigPathFromArgs(process.argv.slice(2)) : undefined;
  const configPath = fromVerbFlags ?? fromProcess;
  const config = loadConfig(configPath);
  const store = new Store(config.dbPath);
  const status: StatusGatherConfig = {
    earningDir: config.earningDir,
    rpcUrl: config.rpcUrl,
    network: config.network,
    pollIntervalMs: config.pollIntervalMs,
    masterEthDailyEstimateWei: config.masterEthDailyEstimateWei,
    rewardClaimIntervalMs: config.rewardClaimIntervalMs,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    config,
    configPath,
  };
  const local = await gatherGatheredStatusRaw(store, status);
  return tryMergeStatusFromHttp(config, local);
}
