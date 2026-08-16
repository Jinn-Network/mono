#!/usr/bin/env node
/**
 * Operator withdraw: send JINN (ERC-20) and/or native ETH from the fleet master EOA to --to.
 *
 * Uses the same HD mnemonic keystore as earning bootstrap (~/.jinn-client/earning/master_keystore.json).
 * Password: JINN_PASSWORD (env-only, same as yarn jinn run) or --password-fd N.
 *
 * Implementation: {@link ../src/withdraw/run-withdraw-plan.ts}
 */

import { config as dotenvConfig } from 'dotenv';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from '../src/config.js';
import {
  parseWithdrawArgv,
  validateWithdrawArgs,
} from '../src/withdraw/args.js';
import {
  computeSweepWouldSend,
  runWithdrawPlan,
  withdrawNeedsInteractiveConfirm,
} from '../src/withdraw/run-withdraw-plan.js';
import { resolveCliPassword } from '../src/cli/password.js';
import { decryptMnemonic } from '../src/earning/wallet.js';
import { FleetStateStore } from '../src/earning/store.js';
import { createJinnPublicClient } from '../src/earning/viem-clients.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

function printHelp(): void {
  console.log(`
Operator withdraw — master EOA and optional agent ETH sweep

  JINN_PASSWORD is required unless --password-fd is used (same keystore password as yarn jinn run).

Options:
  --to <address>           Recipient (required for transfers / sweep)

  JINN / ERC-20 (18 decimals by default; decimals() on-chain for drain/balance):
  --jinn-amount <decimal>    Token amount (human, e.g. 12.5)
  --amount <decimal>         Same as --jinn-amount (JINN / configured ERC-20)
  --jinn-wei <wei>           Token amount in wei (integer string)
  --drain-jinn               Send full token balance from master

  Native ETH:
  --eth-amount <decimal>     ETH amount (e.g. 0.1)
  --eth-wei <wei>            ETH in wei
  --drain-eth                Send maximum ETH after gas reserve (--master-gas-reserve-wei)

  --sweep-agents             Send spare ETH from derived agent EOAs (fleet state) to --to
  --min-sweep-wei <wei>      Minimum balance above gas to sweep per agent (default: 1e15)

  --master-gas-reserve-wei   Wei to keep on master when using --drain-eth (default: 2.5e15)

  --password-fd N            Read password from file descriptor N (trimmed)

  --dry-run                  Print planned actions; no transactions
  --yes                      Skip interactive confirmation
  --config <path>            Same as yarn jinn run

  -h, --help                 Show this help

Environment:
  JINN_TOKEN                 Optional ERC-20 contract address (0x...) for JINN/staking token transfers
`);
}

async function confirmOrThrow(message: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new Error('Non-interactive terminal: repeat with --yes to confirm, or use --dry-run.');
  }
  const ok = await new Promise<boolean>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} [y/N] `, ans => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes');
    });
  });
  if (!ok) {
    throw new Error('Aborted by operator.');
  }
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseWithdrawArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[withdraw] ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  try {
    validateWithdrawArgs(parsed);
  } catch (e) {
    console.error(`[withdraw] ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }

  const pw = resolveCliPassword(process.argv.slice(2));
  if (!pw.ok) {
    console.error(`[withdraw] Fatal: ${pw.message}`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(getConfigPathFromArgs(process.argv.slice(2)));
  const networkChain = config.network === 'testnet' ? 'base-sepolia' : 'base';
  const publicClient = createJinnPublicClient(config.rpcUrl, networkChain);
  const store = new FleetStateStore(config.earningDir);
  const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), pw.password);
  const fleet = await store.tryLoadExisting();
  const to = parsed.to as string;
  const sweepWouldSend = await computeSweepWouldSend(
    publicClient,
    mnemonic,
    fleet,
    to,
    parsed.minSweepWei,
  );

  if (withdrawNeedsInteractiveConfirm(parsed, { sweepWouldSend })) {
    await confirmOrThrow(
      'This operation may move large balances or drain wallets. Proceed?',
      parsed.yes,
    );
  }

  try {
    await runWithdrawPlan({ password: pw.password, config, parsed });
  } catch (e) {
    console.error('[withdraw]', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

main();
