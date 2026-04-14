import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
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
        exampleCli: 'jinn claim-rewards --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  if (dryRun) {
    emitDryRun(ctx, {
      verb: 'claim-rewards',
      description: 'Would call the reward distributor for every staked service',
      plan: [{ action: 'distributor.claim', perServiceTx: true }],
    });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  ctx.writer.write(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'claim-rewards',
      claimedWei: '0',
      note: 'distributor integration pending in a follow-up commit',
    }) + '\n',
  );
}

const command: CommandModule = {
  name: 'claim-rewards',
  summary: 'Pull pending protocol rewards to the fleet multisigs',
  helpText: `Usage: jinn claim-rewards [--dry-run] [--yes]

Idempotent: zero-delta is success, not error. Second consecutive call
returns claimedWei:"0" and exits 0.

Examples:
  jinn claim-rewards --dry-run
  jinn claim-rewards --yes
`,
  run,
};

export default command;
