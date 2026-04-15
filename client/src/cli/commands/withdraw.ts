import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { resolveCliPassword } from '../password.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
import {
  parseWithdrawArgv,
  validateWithdrawArgs,
} from '../../withdraw/args.js';
import {
  computeSweepWouldSend,
  runWithdrawPlan,
  withdrawNeedsInteractiveConfirm,
} from '../../withdraw/run-withdraw-plan.js';
import { decryptMnemonic } from '../../earning/wallet.js';
import { FleetStateStore } from '../../earning/store.js';
import { JsonRpcProvider } from 'ethers';

interface SweepEntry {
  from: string;
  role: string;
  asset: 'native' | 'bond' | 'reward';
  amountWei: string;
}

function displayServiceIndex(chainIndex: number): number {
  return Math.max(0, chainIndex - 1);
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseWithdrawArgv(ctx.argv);
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn withdraw --to 0xDEST --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  if (parsed.help) {
    ctx.writer.write(
      `See \`jinn withdraw --help\` in the command module helpText, or \`npx jinn withdraw --human\` for the readable terminal form.\n`,
    );
    return;
  }

  try {
    validateWithdrawArgs(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details =
      message.includes('--to') && message.includes('required')
        ? { field: '--to' as const, expected: 'Ethereum address' }
        : { field: 'flags' as const, expected: message };
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message,
        exampleCli: 'jinn withdraw --to 0xDEST --drain-eth --yes',
        details,
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const sweep: SweepEntry[] = [];
  const masterAddr = raw.fleet?.master_address ?? raw.master.address;
  if (masterAddr) {
    sweep.push({
      from: masterAddr,
      role: 'master',
      asset: 'native',
      amountWei: raw.master.balanceWei ?? '0',
    });
  }
  for (const svc of raw.fleet?.services ?? []) {
    const di = displayServiceIndex(svc.index);
    if (svc.agent_address) {
      sweep.push({
        from: svc.agent_address,
        role: `service.${di}.agent`,
        asset: 'native',
        amountWei: '0',
      });
    }
    if (svc.safe_address) {
      sweep.push({
        from: svc.safe_address,
        role: `service.${di}.multisig`,
        asset: 'native',
        amountWei: '0',
      });
    }
  }

  const dryRun = parsed.dryRun;
  const yes = parsed.yes;

  if (dryRun) {
    emitDryRun(ctx, {
      verb: 'withdraw',
      description: `Would run withdraw plan (${sweep.length} wallet hint rows) to ${parsed.to}`,
      plan: sweep.map(s => ({ ...s, to: parsed.to })),
    });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  const pw = resolveCliPassword(ctx.argv, ctx.env);
  if (!pw.ok) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: pw.message,
        exampleCli: 'jinn withdraw --to 0xDEST --yes',
        details: { field: 'keystore password' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const configPath =
    getConfigPathFromArgs(ctx.argv ?? []) ?? getConfigPathFromArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  const provider = new JsonRpcProvider(config.rpcUrl);
  const store = new FleetStateStore(config.earningDir);
  let sweepWouldSend = false;
  try {
    const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), pw.password);
    const fleet = await store.tryLoadExisting();
    const to = parsed.to as string;
    sweepWouldSend = await computeSweepWouldSend(
      provider,
      mnemonic,
      fleet,
      to,
      parsed.minSweepWei,
    );
  } catch {
    // best-effort; withdraw will surface decrypt errors
  }

  if (withdrawNeedsInteractiveConfirm(parsed, { sweepWouldSend }) && !parsed.yes) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message:
          'Large or drain-style withdraw requires explicit --yes (non-interactive CLI has no confirmation prompt).',
        exampleCli: 'jinn withdraw --to 0xDEST --drain-eth --yes',
        details: { field: 'confirmation' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  try {
    await runWithdrawPlan({
      password: pw.password,
      config,
      parsed,
      log: () => {},
      warn: (s: string) => {
        process.stderr.write(s + '\n');
      },
    });
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'withdraw',
        to: parsed.to,
        dryRun: false,
        status: 'complete',
      },
      (v) => {
        const value = v as { to: string };
        return `Withdraw plan complete.\nDestination: ${value.to}`;
      },
      {
        json: parsed.json,
        human: parsed.human,
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
  } catch (e) {
    emitEnvelope(
      {
        code: 'fatal',
        message: e instanceof Error ? e.message : String(e),
        details: { cause: e instanceof Error ? e.message : String(e) },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
  }
}

const command: CommandModule = {
  name: 'withdraw',
  summary: 'Sweep master / agents per withdraw flags',
  helpText: `Usage: jinn withdraw --to <address> [amount flags] [--dry-run | --yes] [--human]

Supports the same amount flags as the standalone withdraw helper:
  --jinn-amount / --amount / --jinn-wei / --drain-jinn
  --eth-amount / --eth-wei / --drain-eth
  --sweep-agents / --min-sweep-wei / --master-gas-reserve-wei
  --password-fd N

Large or drain operations require --yes (no TTY prompt).

Examples:
  npx jinn withdraw --to 0xDEST --dry-run
  npx jinn withdraw --to 0xDEST --eth-amount 0.01 --yes
`,
  run,
};

export default command;
