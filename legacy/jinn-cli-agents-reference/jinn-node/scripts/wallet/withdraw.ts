#!/usr/bin/env tsx
/**
 * Withdraw - Withdraw funds from wallet/safes to an external address
 *
 * Usage:
 *   yarn wallet:withdraw --to <address>                    # Withdraw all to address
 *   yarn wallet:withdraw --to <address> --asset ETH        # Withdraw only ETH
 *   yarn wallet:withdraw --to <address> --asset OLAS       # Withdraw only OLAS
 *   yarn wallet:withdraw --to <address> --dry-run          # Preview without executing
 *
 * Uses OlasOperateWrapper for middleware daemon management.
 */

import 'dotenv/config';
import { parseArgs } from 'util';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';
import { ethers } from 'ethers';
import { createRpcProvider } from '../../src/config/index.js';

// OLAS token address on Base
const OLAS_TOKEN_BASE = '0x54330d28ca3357F294334BDC454a032e7f353416';
// Native token (ETH) represented as zero address
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

// ERC20 ABI for balanceOf
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function getBalance(
  provider: ethers.JsonRpcProvider,
  address: string,
  token: 'ETH' | 'OLAS'
): Promise<bigint> {
  if (token === 'ETH') {
    return provider.getBalance(address);
  } else {
    const contract = new ethers.Contract(OLAS_TOKEN_BASE, ERC20_ABI, provider);
    return contract.balanceOf(address);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      to: { type: 'string', short: 't' },
      asset: { type: 'string', short: 'a' },
      chain: { type: 'string', short: 'c', default: 'base' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' }
    },
    allowPositionals: false
  });

  if (values.help) {
    console.log(`
Withdraw funds from wallet/safes to an external address.

Usage:
  yarn wallet:withdraw --to <address>                # Withdraw all to address
  yarn wallet:withdraw --to <address> --asset ETH    # Withdraw only ETH
  yarn wallet:withdraw --to <address> --asset OLAS   # Withdraw only OLAS
  yarn wallet:withdraw --to <address> --dry-run      # Preview without executing

Options:
  --to, -t       Destination address (required)
  --asset, -a    Asset to withdraw: ETH, OLAS, or all (default: all)
  --chain, -c    Chain to withdraw from (default: base)
  --dry-run      Preview withdrawal without executing
  --help, -h     Show this help message
`);
    process.exit(0);
  }

  if (!values.to) {
    console.error('Error: --to <address> is required');
    console.error('Usage: yarn wallet:withdraw --to <address>');
    process.exit(1);
  }

  // Validate address
  if (!ethers.isAddress(values.to)) {
    console.error('Error: Invalid destination address');
    process.exit(1);
  }

  const password = process.env.OPERATE_PASSWORD;
  if (!password) {
    console.error('Error: OPERATE_PASSWORD environment variable is required');
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('Error: RPC_URL environment variable is required');
    process.exit(1);
  }

  const chain = values.chain || 'base';
  const assetFilter = values.asset?.toUpperCase();
  const dryRun = values['dry-run'];

  console.log(`\nWithdrawal ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`  To:    ${values.to}`);
  console.log(`  Chain: ${chain}`);
  console.log(`  Asset: ${assetFilter || 'ALL'}`);
  console.log('');

  // Create wrapper and start daemon
  const wrapper = await OlasOperateWrapper.create({ rpcUrl });

  try {
    await wrapper.startServer();
    await wrapper.login(password);

    // Get wallet info to find safe addresses
    const walletResult = await wrapper.getWalletInfo();
    if (!walletResult.success || !walletResult.wallets) {
      console.error('Failed to get wallet info:', walletResult.error);
      process.exit(1);
    }

    const wallets = walletResult.wallets;
    if (wallets.length === 0) {
      console.error('No wallets found');
      process.exit(1);
    }

    const provider = createRpcProvider(rpcUrl);

    // Build withdraw_assets payload
    const withdrawAssets: Record<string, Record<string, string>> = {};
    withdrawAssets[chain] = {};

    // Find safe address for this chain
    const wallet = wallets[0];
    const safeAddress = wallet.safes?.[chain];

    if (!safeAddress) {
      console.error(`No safe found for chain: ${chain}`);
      process.exit(1);
    }

    console.log(`Safe address: ${safeAddress}\n`);

    // Get balances
    if (!assetFilter || assetFilter === 'ETH' || assetFilter === 'ALL') {
      const ethBalance = await getBalance(provider, safeAddress, 'ETH');
      if (ethBalance > 0n) {
        // Leave some for gas (0.001 ETH)
        const withdrawAmount = ethBalance - ethers.parseEther('0.001');
        if (withdrawAmount > 0n) {
          withdrawAssets[chain][NATIVE_TOKEN] = withdrawAmount.toString();
          console.log(`  ETH available: ${ethers.formatEther(ethBalance)}`);
          console.log(`  ETH to withdraw: ${ethers.formatEther(withdrawAmount)} (keeping 0.001 for gas)`);
        }
      } else {
        console.log('  ETH available: 0');
      }
    }

    if (!assetFilter || assetFilter === 'OLAS' || assetFilter === 'ALL') {
      const olasBalance = await getBalance(provider, safeAddress, 'OLAS');
      if (olasBalance > 0n) {
        withdrawAssets[chain][OLAS_TOKEN_BASE] = olasBalance.toString();
        console.log(`  OLAS available: ${ethers.formatEther(olasBalance)}`);
        console.log(`  OLAS to withdraw: ${ethers.formatEther(olasBalance)}`);
      } else {
        console.log('  OLAS available: 0');
      }
    }

    // Check if anything to withdraw
    if (Object.keys(withdrawAssets[chain]).length === 0) {
      console.log('\n✓ No funds available to withdraw');
      process.exit(0);
    }

    if (dryRun) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('DRY RUN - No transactions executed');
      console.log('Remove --dry-run to execute withdrawal');
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(0);
    }

    console.log('\nExecuting withdrawal...');

    // Call withdraw API
    const withdrawResult = await wrapper.withdrawFunds(values.to, withdrawAssets);

    if (!withdrawResult.success) {
      console.error('\n❌ Withdrawal failed:', withdrawResult.error);
      process.exit(1);
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('✅ Withdrawal successful!');
    console.log('═══════════════════════════════════════════════════════════════\n');

    if (withdrawResult.transferTxs) {
      console.log('Transaction hashes:');
      for (const [chainName, tokens] of Object.entries(withdrawResult.transferTxs)) {
        for (const [tokenAddr, txHashes] of Object.entries(tokens)) {
          const tokenName = tokenAddr === NATIVE_TOKEN ? 'ETH' : 'OLAS';
          for (const tx of txHashes) {
            console.log(`  ${tokenName}: ${tx}`);
          }
        }
      }
    }

  } finally {
    await wrapper.stopServer();
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
