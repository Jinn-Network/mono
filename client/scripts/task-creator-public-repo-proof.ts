#!/usr/bin/env tsx
/**
 * Guarded operator entry point for G0b mint admission only.
 *
 * The default is a read-only mint preflight. `--execute` invokes the existing
 * mint command only with caller-owned operator configuration and only after
 * `JINN_TASK_CREATOR_MINT_EXECUTE=1` is supplied. It never reads, prints, or
 * embeds private keys or registry credentials.
 *
 * Usage:
 *   yarn task-creator:mint-preflight:jinn-mono
 *   JINN_TASK_CREATOR_MINT_EXECUTE=1 yarn task-creator:mint-preflight:jinn-mono --execute
 */

import { parseArgs } from 'node:util';
import {
  executeMintAdmission,
  parseLivePublicRepoProofConfig,
  publicRepoProofMintCommand,
  type PublicRepoProofId,
} from '../src/task-creator/proofs/live-proof.js';

function fixtureFromArgv(): { fixture: PublicRepoProofId; execute: boolean } {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      fixture: { type: 'string' },
      execute: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const fixture = parsed.values.fixture;
  if (fixture !== 'jinn-mono' && fixture !== 'unjs-destr') {
    throw new Error('set --fixture to jinn-mono or unjs-destr');
  }
  return { fixture, execute: parsed.values.execute === true };
}

async function main(): Promise<void> {
  const { fixture, execute } = fixtureFromArgv();
  const config = await parseLivePublicRepoProofConfig(fixture);
  const command = publicRepoProofMintCommand(config);
  const summary = {
    fixture: config.fixture.id,
    repo: config.fixture.repo,
    instanceId: config.fixture.instanceId,
    baseCommit: config.fixture.baseCommit,
    fixCommit: config.fixture.fixCommit,
    evidenceKind: config.fixture.evidenceKind,
    operators: {
      minter: config.minterOperator,
      solver: config.solverOperator,
      evaluator: config.evaluatorOperator,
    },
    ...(config.differentialAdmission ? {
      differentialAdmission: {
        receiptCid: config.differentialAdmission.receiptCid,
        receiptHash: config.differentialAdmission.receiptHash,
      },
    } : {}),
    command: [command.bin, ...command.args],
  };
  if (!execute) {
    console.log('[task-creator-mint-preflight] passed; no image, artifact, task, delivery, or verdict was created.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log('[task-creator-mint-preflight] executing configured mint admission only; it is not a network/factory lifecycle proof.');
  await executeMintAdmission(config);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[task-creator-mint-preflight] FAIL: ${message}`);
  process.exitCode = 1;
});
