#!/usr/bin/env tsx
/**
 * Assert maxDeliveryRate for all deployed mechs in .operate/services.
 *
 * Usage:
 *   RPC_URL=<url> yarn tsx scripts/mech/assert-delivery-rates.ts
 *   RPC_URL=<url> yarn tsx scripts/mech/assert-delivery-rates.ts --expected 99
 *   RPC_URL=<url> yarn tsx scripts/mech/assert-delivery-rates.ts --expected=99
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listServiceConfigs, type ServiceInfo } from '../../src/worker/ServiceConfigReader.js';
import { createRpcProvider } from '../../src/config/index.js';

const MECH_ABI = ['function maxDeliveryRate() view returns (uint256)'] as const;

function parseExpected(args: string[]): bigint {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--expected' && args[i + 1]) {
      return BigInt(args[i + 1]);
    }
    if (arg.startsWith('--expected=')) {
      return BigInt(arg.slice('--expected='.length));
    }
  }
  return 99n;
}

async function readRate(provider: ethers.JsonRpcProvider, service: ServiceInfo): Promise<bigint> {
  if (!service.mechContractAddress) {
    throw new Error(`Service ${service.serviceConfigId} has no mech contract address`);
  }
  const mech = new ethers.Contract(service.mechContractAddress, MECH_ABI, provider);
  return (await mech.maxDeliveryRate()) as bigint;
}

async function main(): Promise<void> {
  const expected = parseExpected(process.argv.slice(2));
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('RPC_URL environment variable not set');
    process.exit(1);
  }

  const currentFile = fileURLToPath(import.meta.url);
  const scriptsDir = dirname(currentFile);
  const middlewarePath = process.env.OLAS_MIDDLEWARE_PATH
    ? resolve(process.env.OLAS_MIDDLEWARE_PATH)
    : resolve(scriptsDir, '..', '..');

  console.log(`Middleware path: ${middlewarePath}`);
  console.log(`Expected maxDeliveryRate: ${expected.toString()} wei`);

  const services = await listServiceConfigs(middlewarePath);
  const servicesWithMech = services.filter(s => s.mechContractAddress);

  if (servicesWithMech.length === 0) {
    console.error('No deployed mechs found in .operate/services');
    process.exit(1);
  }

  const provider = createRpcProvider(rpcUrl);
  let mismatches = 0;
  let errors = 0;

  for (const service of servicesWithMech) {
    const label = `${service.serviceConfigId} (#${service.serviceId ?? 'N/A'})`;
    try {
      const actual = await readRate(provider, service);
      const mechAddress = service.mechContractAddress!;
      const match = actual === expected;
      console.log(
        `${match ? 'PASS' : 'FAIL'} ${label} mech=${mechAddress} maxDeliveryRate=${actual.toString()}`,
      );
      if (!match) mismatches++;
    } catch (error: any) {
      console.error(
        `ERROR ${label} mech=${service.mechContractAddress} message=${error?.message ?? String(error)}`,
      );
      errors++;
    }
  }

  if (mismatches > 0 || errors > 0) {
    console.error(
      `Delivery rate assertion failed: mismatches=${mismatches}, errors=${errors}, expected=${expected.toString()}`,
    );
    process.exit(1);
  }

  console.log(`All ${servicesWithMech.length} deployed mechs have maxDeliveryRate=${expected.toString()}`);
}

main().catch((error: any) => {
  console.error(`Fatal error: ${error?.message ?? String(error)}`);
  process.exit(1);
});
