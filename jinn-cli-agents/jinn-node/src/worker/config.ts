/**
 * Worker Configuration (Legacy bridge)
 *
 * This module provides a WorkerConfig interface for backwards compatibility.
 * New code should import { config, secrets } from '../config/index.js' directly.
 *
 * @deprecated Use config.chain.*, config.worker.*, config.dev.*, secrets.* directly.
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import { configLogger } from '../logging/index.js';
import { config as nodeConfig, secrets } from '../config/index.js';
import { getServicePrivateKey } from '../env/operate-profile.js';

/**
 * Legacy WorkerConfig type
 * @deprecated Use config.* and secrets.* from '../config/index.js' directly.
 */
export interface WorkerConfig {
  WORKER_PRIVATE_KEY?: string;
  CHAIN_ID: number;
  RPC_URL: string;
  JINN_WALLET_STORAGE_PATH?: string;
  TEST_RPC_URL?: string;
  DISABLE_STS_CHECKS?: boolean;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  ENABLE_TRANSACTION_EXECUTOR: boolean;
  WORKER_ID?: string;
  WORKER_TX_CONFIRMATIONS: number;
}

/**
 * Legacy config object
 * @deprecated Use config.chain.*, config.worker.*, config.dev.*, secrets.* directly.
 */
export const workerConfig: WorkerConfig = {
  get WORKER_PRIVATE_KEY() { return getServicePrivateKey() || undefined; },
  get CHAIN_ID() { return nodeConfig.chain.chainId; },
  get RPC_URL() { return secrets.rpcUrl || ''; },
  get JINN_WALLET_STORAGE_PATH() { return process.env.JINN_WALLET_STORAGE_PATH; },
  get TEST_RPC_URL() { return secrets.testRpcUrl; },
  get DISABLE_STS_CHECKS() { return nodeConfig.dev.disableStsChecks; },
  get SUPABASE_URL() { return secrets.supabaseUrl; },
  get SUPABASE_SERVICE_ROLE_KEY() { return secrets.supabaseServiceRoleKey; },
  get ENABLE_TRANSACTION_EXECUTOR() { return nodeConfig.dev.enableTransactionExecutor; },
  get WORKER_ID() { return nodeConfig.dev.workerId; },
  get WORKER_TX_CONFIRMATIONS() { return nodeConfig.worker.txConfirmations; },
};

/**
 * Legacy helper: Get optional string from environment
 */
export function getOptionalString(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}

/**
 * Legacy helper: Get required string from environment
 */
export function getRequiredString(key: string): string {
  const value = process.env[key];
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

/**
 * Legacy helper: Get optional number from environment
 */
export function getOptionalNumber(key: string, defaultValue?: number): number | undefined {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const num = Number(value);
  return isNaN(num) ? defaultValue : num;
}
