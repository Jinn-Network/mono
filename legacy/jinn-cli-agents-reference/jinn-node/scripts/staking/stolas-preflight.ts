#!/usr/bin/env tsx
/**
 * stOLAS Preflight Check — verify distributor config and available staking slots.
 *
 * Usage: yarn stolas:preflight
 */

import 'dotenv/config';
import { stolasPreflightCheck } from '../../src/worker/stolas/StolasServiceBootstrap.js';

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('RPC_URL is not set in .env');
    process.exit(1);
  }

  const result = await stolasPreflightCheck(rpcUrl);
  if (result.ok) {
    console.log(`stOLAS available: ${result.slotsRemaining} slots remaining`);
  } else {
    console.log(`stOLAS unavailable: ${result.error}`);
    console.log('Falling back to standard setup (requires ~10,000 OLAS)');
    process.exit(1);
  }
}

main();
