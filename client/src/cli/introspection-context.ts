/**
 * Shared gather for introspection verbs (local SQLite + fleet + RPC).
 *
 * When the HTTP API is reachable, merges a healthier `rpc` snapshot from GET /v1/status
 * into the local gather (short timeout; failures are ignored).
 */

import type { GatheredStatusRaw } from '../api/status-build.js';
import type { StatusV1Response } from '../api/status-build.js';
import { gatherGatheredStatusRaw, type StatusGatherConfig } from '../api/gather-status.js';
import { loadConfig, getConfigPathFromArgs } from '../config.js';
import { Store } from '../store/store.js';

async function tryMergeStatusFromHttp(
  config: ReturnType<typeof loadConfig>,
  local: GatheredStatusRaw,
): Promise<GatheredStatusRaw> {
  const url = `http://127.0.0.1:${config.apiPort}/v1/status`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 500);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return local;
    const remote = (await res.json()) as StatusV1Response;
    if (remote.rpc?.ok && !local.rpc.ok) {
      return {
        ...local,
        rpc: {
          ok: remote.rpc.ok,
          chainId: remote.rpc.chainId,
          blockNumber: remote.rpc.blockNumber,
          ...(remote.rpc.error ? { error: remote.rpc.error } : {}),
        },
      };
    }
  } catch {
    /* ignore — local gather is authoritative */
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
  };
  const local = await gatherGatheredStatusRaw(store, status);
  return tryMergeStatusFromHttp(config, local);
}
