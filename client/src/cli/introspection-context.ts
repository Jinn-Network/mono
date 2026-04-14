/**
 * Shared gather for introspection verbs (local SQLite + fleet + RPC).
 *
 * Plan 03: HTTP fallback to the daemon API is deferred.
 */

import type { GatheredStatusRaw } from '../api/status-build.js';
import { gatherGatheredStatusRaw, type StatusGatherConfig } from '../api/gather-status.js';
import { loadConfig, getConfigPathFromArgs } from '../config.js';
import { Store } from '../store/store.js';

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
  return gatherGatheredStatusRaw(store, status);
}
