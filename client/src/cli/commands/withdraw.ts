import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';

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
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        to: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
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

  const to = parsed.values.to as string | undefined;
  if (!to) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--to is required (destination address)',
        exampleCli: 'jinn withdraw --to 0xDEST --dry-run',
        details: { field: '--to', expected: 'Ethereum address' },
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

  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  if (dryRun) {
    emitDryRun(ctx, {
      verb: 'withdraw',
      description: `Would sweep ${sweep.length} wallet(s) to ${to}`,
      plan: sweep.map(s => ({ ...s, to })),
    });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  ctx.writer.write(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'withdraw',
      to,
      swept: sweep.length,
      note: 'withdraw execution pending in a follow-up commit',
    }) + '\n',
  );
}

const command: CommandModule = {
  name: 'withdraw',
  summary: 'Sweep all fleet wallets to an external destination address',
  helpText: `Usage: jinn withdraw --to <address> [--dry-run | --yes]

NOT idempotent. Each invocation emits a fresh sweep transaction.
Requires --yes to run on a non-TTY. --dry-run prints the sweep plan
as JSON and exits 0 without emitting any transaction.

Examples:
  jinn withdraw --to 0xDEST --dry-run
  jinn withdraw --to 0xDEST --yes
`,
  run,
};

export default command;
