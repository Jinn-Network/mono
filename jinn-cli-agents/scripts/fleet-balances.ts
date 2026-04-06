#!/usr/bin/env tsx
/**
 * Fleet Balance Overview
 *
 * Dynamically discovers Master EOA, Master Safe, and all service Safes + Agent EOAs
 * from the .operate directory via ServiceConfigReader, then fetches ETH and OLAS
 * balances for every address.
 *
 * Usage:
 *   tsx scripts/fleet-balances.ts
 *   # or from jinn-node/:
 *   RPC_URL=https://rpc.jinn.network RPC_PROXY_TOKEN=<token> yarn fleet:balances
 */

// Suppress noisy pino logs unless DEBUG is set (must be before any imports)
if (!process.env.DEBUG && !process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'error';

import 'dotenv/config';
import { ethers } from 'ethers';
import {
  getMasterEOA,
  getMasterSafe,
  getMasterWallet,
  getMiddlewarePath,
} from '../jinn-node/src/env/operate-profile.js';
import { listServiceConfigs } from '../jinn-node/src/worker/ServiceConfigReader.js';
import { createRpcProvider } from '../jinn-node/src/config/index.js';

const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

interface AddressEntry {
  label: string;
  address: string;
  eth: bigint;
  olas: bigint;
}

async function fetchBalances(
  provider: ethers.JsonRpcProvider,
  olasContract: ethers.Contract,
  address: string,
): Promise<{ eth: bigint; olas: bigint }> {
  const [eth, olas] = await Promise.all([
    provider.getBalance(address),
    olasContract.balanceOf(address),
  ]);
  return { eth, olas };
}

function fmt(wei: bigint, decimals = 4): string {
  const full = ethers.formatEther(wei);
  const dot = full.indexOf('.');
  if (dot === -1) return full;
  return full.slice(0, dot + decimals + 1);
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('RPC_URL is required. Set it in .env or as an environment variable.');
    process.exit(1);
  }

  const provider = createRpcProvider(rpcUrl);
  const olasContract = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);

  const entries: AddressEntry[] = [];

  // --- Master addresses ---
  const masterEOA = getMasterEOA();
  const masterSafe = getMasterSafe('base');

  if (masterEOA) {
    const bal = await fetchBalances(provider, olasContract, masterEOA);
    entries.push({ label: 'Master EOA', address: masterEOA, ...bal });
  }

  if (masterSafe) {
    const bal = await fetchBalances(provider, olasContract, masterSafe);
    entries.push({ label: 'Master Safe (Base)', address: masterSafe, ...bal });
  }

  // --- Service addresses ---
  const middlewarePath = getMiddlewarePath();
  if (middlewarePath) {
    const services = await listServiceConfigs(middlewarePath);

    // Deduplicate addresses we've already queried
    const seen = new Set<string>(
      entries.map(e => e.address.toLowerCase()),
    );

    for (const svc of services) {
      const serviceLabel = svc.serviceId
        ? `Service #${svc.serviceId}`
        : svc.serviceConfigId;

      if (svc.serviceSafeAddress && !seen.has(svc.serviceSafeAddress.toLowerCase())) {
        seen.add(svc.serviceSafeAddress.toLowerCase());
        const bal = await fetchBalances(provider, olasContract, svc.serviceSafeAddress);
        entries.push({
          label: `${serviceLabel} Safe`,
          address: svc.serviceSafeAddress,
          ...bal,
        });
      }

      if (svc.agentEoaAddress && !seen.has(svc.agentEoaAddress.toLowerCase())) {
        seen.add(svc.agentEoaAddress.toLowerCase());
        const bal = await fetchBalances(provider, olasContract, svc.agentEoaAddress);
        entries.push({
          label: `${serviceLabel} Agent`,
          address: svc.agentEoaAddress,
          ...bal,
        });
      }
    }
  } else {
    console.log('(no middleware path found — skipping service discovery)\n');
  }

  // --- Output ---
  const labelWidth = Math.max(...entries.map(e => e.label.length), 10) + 2;
  const ethWidth = 22;
  const olasWidth = 22;
  const totalWidth = labelWidth + ethWidth + olasWidth + 44;

  let totalEth = 0n;
  let totalOlas = 0n;

  console.log('\nFleet Balance Overview');
  console.log('='.repeat(totalWidth));
  console.log(
    `${pad('Label', labelWidth)}${'ETH'.padStart(ethWidth)}${'OLAS'.padStart(olasWidth)}  Address`,
  );
  console.log('-'.repeat(totalWidth));

  for (const e of entries) {
    totalEth += e.eth;
    totalOlas += e.olas;

    const ethStr = fmt(e.eth).padStart(ethWidth);
    const olasStr = fmt(e.olas).padStart(olasWidth);
    console.log(`${pad(e.label, labelWidth)}${ethStr}${olasStr}  ${e.address}`);
  }

  console.log('-'.repeat(totalWidth));
  console.log(
    `${pad('TOTAL', labelWidth)}${fmt(totalEth).padStart(ethWidth)}${fmt(totalOlas).padStart(olasWidth)}`,
  );
  console.log('='.repeat(totalWidth));

  // Alerts
  const lowGas = entries.filter(
    e => e.label.includes('Safe') && e.eth < ethers.parseEther('0.002'),
  );
  if (lowGas.length > 0) {
    console.log('\nAlerts:');
    for (const e of lowGas) {
      console.log(`  LOW GAS: ${e.label} has only ${fmt(e.eth)} ETH (< 0.002)`);
    }
  }

  const strandedOlas = entries.filter(
    e => e.label.includes('Agent') && e.olas > 0n,
  );
  if (strandedOlas.length > 0) {
    console.log(strandedOlas.length > 0 && lowGas.length === 0 ? '\nAlerts:' : '');
    for (const e of strandedOlas) {
      console.log(`  STRANDED OLAS: ${e.label} holds ${fmt(e.olas)} OLAS`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
