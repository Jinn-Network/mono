#!/usr/bin/env tsx
/**
 * Guarded bridge to an operator-owned public-repository network/factory
 * runner. Unlike mint admission, the runner receives the bound RPC, registry,
 * credential-helper reference, and three distinct operator identities through
 * a temporary secret-free JSON file. It must create/post and record delivery
 * and verdict receipts before reporting a proof. For Jinn, preflight also
 * requires the generated, receipt-bound differential admission evidence.
 */

import { parseArgs } from 'node:util';
import {
  executeNetworkFactoryProof,
  networkProofConfigDocument,
  parseLivePublicRepoProofConfig,
  type PublicRepoProofId,
} from '../src/task-creator/proofs/live-proof.js';

function parseInvocation(): { fixture: PublicRepoProofId; execute: boolean } {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      fixture: { type: 'string' },
      execute: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (parsed.values.fixture !== 'jinn-mono' && parsed.values.fixture !== 'unjs-destr') {
    throw new Error('set --fixture to jinn-mono or unjs-destr');
  }
  return { fixture: parsed.values.fixture, execute: parsed.values.execute === true };
}

async function main(): Promise<void> {
  const { fixture, execute } = parseInvocation();
  const config = await parseLivePublicRepoProofConfig(fixture);
  if (!execute) {
    console.log('[task-creator-network-proof] preflight passed; no network/factory process was started.');
    console.log(JSON.stringify(networkProofConfigDocument(config), null, 2));
    return;
  }
  await executeNetworkFactoryProof(config);
}

main().catch((error: unknown) => {
  console.error(`[task-creator-network-proof] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
