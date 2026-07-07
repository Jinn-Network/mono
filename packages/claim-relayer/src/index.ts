#!/usr/bin/env node
import { createPublicClient, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia, baseSepolia } from 'viem/chains';
import { loadConfig } from './config.js';
import { ClaimRelayerStore } from './db.js';
import { createStatusServer } from './http.js';
import { errorToLogMessage } from './redact.js';
import { ClaimRelayer } from './relayer.js';
import { buildFallbackTransport, describeFallbackChain } from './transport.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const account = privateKeyToAccount(config.privateKey);
  const store = new ClaimRelayerStore(config.dbPath);

  const l1Transport = buildFallbackTransport(config.l1RpcUrls);
  const l2Transport = buildFallbackTransport(config.l2RpcUrls);

  // Boot-log the resolved fallback chains so operators see provider counts
  // + primary host (the same convention the daemon uses; see AC7 of #592).
  console.error(`[claim-relayer] L1 transport: ${describeFallbackChain(config.l1RpcUrls)}`);
  console.error(`[claim-relayer] L2 transport: ${describeFallbackChain(config.l2RpcUrls)}`);

  const l1Public = createPublicClient({
    chain: sepolia,
    transport: l1Transport,
  });
  const l2Public = createPublicClient({
    chain: baseSepolia,
    transport: l2Transport,
  });
  const l1Wallet = createWalletClient({
    account,
    chain: sepolia,
    transport: l1Transport,
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
  console.error(errorToLogMessage(error));
  process.exitCode = 1;
});
