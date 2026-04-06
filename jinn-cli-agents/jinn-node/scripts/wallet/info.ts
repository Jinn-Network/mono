#!/usr/bin/env tsx
/**
 * Wallet Info - Display addresses, balances, and staking status
 *
 * Usage: yarn wallet:info
 *
 * Uses OlasOperateWrapper for middleware daemon management.
 */

import 'dotenv/config';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';
import { ethers } from 'ethers';
import { createRpcProvider } from '../../src/config/index.js';

// OLAS token address on Base
const OLAS_TOKEN_BASE = '0x54330d28ca3357F294334BDC454a032e7f353416';

// ERC20 ABI for balanceOf
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function getBalances(
  provider: ethers.JsonRpcProvider,
  address: string
): Promise<{ eth: string; olas: string }> {
  try {
    const ethBalance = await provider.getBalance(address);
    const olasContract = new ethers.Contract(OLAS_TOKEN_BASE, ERC20_ABI, provider);
    const olasBalance = await olasContract.balanceOf(address);

    return {
      eth: ethers.formatEther(ethBalance),
      olas: ethers.formatEther(olasBalance)
    };
  } catch (error) {
    return { eth: '?', olas: '?' };
  }
}

async function main() {
  console.log('Fetching wallet information...\n');

  const password = process.env.OPERATE_PASSWORD;
  const rpcUrl = process.env.RPC_URL;

  // Create wrapper and start daemon
  const wrapper = await OlasOperateWrapper.create({
    rpcUrl: rpcUrl || undefined,
  });

  try {
    await wrapper.startServer();

    // Login if password provided
    if (password) {
      await wrapper.login(password);
    }

    // Get wallet info from middleware
    const walletResult = await wrapper.getWalletInfo();

    if (!walletResult.success || !walletResult.wallets) {
      console.error('Failed to fetch wallet info:', walletResult.error);
      process.exit(1);
    }

    const wallets = walletResult.wallets;

    if (wallets.length === 0) {
      console.log('No wallets found. Run setup first.');
      process.exit(0);
    }

    // Setup provider for balance queries
    let provider: ethers.JsonRpcProvider | null = null;
    if (rpcUrl) {
      provider = createRpcProvider(rpcUrl);
    }

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                        WALLET INFO                            ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    for (const wallet of wallets) {
      console.log('┌─ Master EOA ─────────────────────────────────────────────────┐');
      console.log(`│  Address: ${wallet.address}`);

      if (provider) {
        const eoaBalances = await getBalances(provider, wallet.address);
        console.log(`│  ETH:     ${eoaBalances.eth}`);
        console.log(`│  OLAS:    ${eoaBalances.olas}`);
      }
      console.log('└──────────────────────────────────────────────────────────────┘\n');

      if (wallet.safes) {
        for (const [chain, safeAddress] of Object.entries(wallet.safes)) {
          console.log(`┌─ ${chain.toUpperCase()} Safe ─────────────────────────────────────────────────┐`);
          console.log(`│  Address: ${safeAddress}`);

          if (provider && chain === 'base') {
            const safeBalances = await getBalances(provider, safeAddress);
            console.log(`│  ETH:     ${safeBalances.eth}`);
            console.log(`│  OLAS:    ${safeBalances.olas}`);
          }
          console.log('└──────────────────────────────────────────────────────────────┘\n');
        }
      }
    }

    // Try to get service info (v2 API)
    const servicesResult = await wrapper.getServices();
    if (servicesResult.success && servicesResult.services && servicesResult.services.length > 0) {
      console.log('┌─ Services ──────────────────────────────────────────────────┐');
      for (const service of servicesResult.services) {
        console.log(`│  Name:    ${service.name || 'Unnamed'}`);
        console.log(`│  ID:      ${service.service_config_id || service.hash || 'N/A'}`);
        if (service.chain_configs?.base?.chain_data?.multisig) {
          console.log(`│  Safe:    ${service.chain_configs.base.chain_data.multisig}`);
        }
        if (service.chain_configs?.base?.chain_data?.instances?.[0]) {
          console.log(`│  Agent:   ${service.chain_configs.base.chain_data.instances[0]}`);
        }
      }
      console.log('└──────────────────────────────────────────────────────────────┘\n');
    }

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('Use `yarn wallet:export-keys` to export recovery mnemonic');
    console.log('Use `yarn wallet:withdraw` to withdraw funds');
    console.log('═══════════════════════════════════════════════════════════════');

  } finally {
    await wrapper.stopServer();
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
