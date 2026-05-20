import path from 'node:path';
import { homedir } from 'node:os';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadArtifactAddresses, type ArtifactAddresses } from './artifacts.js';

export interface ClaimRelayerConfig {
  privateKey: Hex;
  signerAddress: Address;
  l1RpcUrl: string;
  l2RpcUrl: string;
  startBlock: bigint;
  dbPath: string;
  port: number;
  pollIntervalMs: number;
  batchBlocks: bigint;
  artifacts: ArtifactAddresses;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

function parsePrivateKey(value: string): Hex {
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('JINN_CLAIM_RELAYER_PRIVATE_KEY must be a 32-byte hex private key');
  }
  return normalized as Hex;
}

function parseInteger(value: string, name: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(value);
}

function parseNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large`);
  return parsed;
}

function optionalAddress(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!isAddress(value)) throw new Error(`${name} must be an EVM address`);
  return getAddress(value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClaimRelayerConfig {
  const privateKey = parsePrivateKey(requiredEnv(env, 'JINN_CLAIM_RELAYER_PRIVATE_KEY'));
  const account = privateKeyToAccount(privateKey);
  const artifacts = loadArtifactAddresses({
    l1ArtifactPath: env.JINN_CLAIM_RELAYER_L1_ARTIFACT,
    l2ArtifactPath: env.JINN_CLAIM_RELAYER_L2_ARTIFACT,
    distributorAddress: optionalAddress(env.JINN_CLAIM_RELAYER_DISTRIBUTOR_ADDRESS, 'JINN_CLAIM_RELAYER_DISTRIBUTOR_ADDRESS'),
    messengerAddress: optionalAddress(env.JINN_CLAIM_RELAYER_MOCK_MESSENGER_ADDRESS, 'JINN_CLAIM_RELAYER_MOCK_MESSENGER_ADDRESS'),
    claimEmitterAddress: optionalAddress(env.JINN_CLAIM_RELAYER_TASK_CLAIM_EMITTER_ADDRESS, 'JINN_CLAIM_RELAYER_TASK_CLAIM_EMITTER_ADDRESS'),
  });

  return {
    privateKey,
    signerAddress: account.address,
    l1RpcUrl: requiredEnv(env, 'JINN_CLAIM_RELAYER_L1_RPC_URL'),
    l2RpcUrl: requiredEnv(env, 'JINN_CLAIM_RELAYER_L2_RPC_URL'),
    startBlock: parseInteger(requiredEnv(env, 'JINN_CLAIM_RELAYER_START_BLOCK'), 'JINN_CLAIM_RELAYER_START_BLOCK'),
    dbPath: path.resolve(env.JINN_CLAIM_RELAYER_DB_PATH ?? path.join(homedir(), '.jinn', 'claim-relayer.sqlite')),
    port: parseNumber(env.JINN_CLAIM_RELAYER_PORT, 8737, 'JINN_CLAIM_RELAYER_PORT'),
    pollIntervalMs: parseNumber(env.JINN_CLAIM_RELAYER_POLL_INTERVAL_MS, 60_000, 'JINN_CLAIM_RELAYER_POLL_INTERVAL_MS'),
    batchBlocks: parseInteger(env.JINN_CLAIM_RELAYER_BATCH_BLOCKS ?? '5000', 'JINN_CLAIM_RELAYER_BATCH_BLOCKS'),
    artifacts,
  };
}

export function redactConfig(config: ClaimRelayerConfig): Record<string, unknown> {
  return {
    signerAddress: config.signerAddress,
    l1RpcUrl: '[redacted]',
    l2RpcUrl: '[redacted]',
    hasPrivateKey: true,
    startBlock: config.startBlock.toString(),
    dbPath: config.dbPath,
    port: config.port,
    pollIntervalMs: config.pollIntervalMs,
    batchBlocks: config.batchBlocks.toString(),
    artifacts: {
      l1ArtifactPath: config.artifacts.l1ArtifactPath,
      l2ArtifactPath: config.artifacts.l2ArtifactPath,
      distributor: config.artifacts.distributor,
      messenger: config.artifacts.messenger,
      claimEmitter: config.artifacts.claimEmitter,
    },
  };
}
