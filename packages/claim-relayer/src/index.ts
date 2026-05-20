#!/usr/bin/env node
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia, baseSepolia } from 'viem/chains';
import { loadConfig } from './config.js';
import { ClaimRelayerStore } from './db.js';
import { createStatusServer } from './http.js';
import { ClaimRelayer } from './relayer.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const account = privateKeyToAccount(config.privateKey);
  const store = new ClaimRelayerStore(config.dbPath);

  const l1Public = createPublicClient({
    chain: sepolia,
    transport: http(config.l1RpcUrl),
  });
  const l2Public = createPublicClient({
    chain: baseSepolia,
    transport: http(config.l2RpcUrl),
  });
  const l1Wallet = createWalletClient({
    account,
    chain: sepolia,
    transport: http(config.l1RpcUrl),
  });

  const relayer = new ClaimRelayer(config, store, { l1Public, l2Public, l1Wallet });

  await relayer.start();
  const server = createStatusServer({ config, store, relayer });
  server.listen(config.port, '0.0.0.0');

  const shutdown = () => {
    relayer.stop();
    server.close();
    store.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
