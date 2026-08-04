import { parseArgs } from 'node:util';
import { COMMON_FLAGS, type CommandContext, type CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { createCliSignerContext } from '../execution-context.js';
import { claimRewardsIntent } from '../../intents/claim-rewards.js';
import { isRecoverableTransactionError } from '../../tx-retry.js';
import { TransientError } from '../../types/errors.js';
import { Store } from '../../store/store.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
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

  const built = await createCliSignerContext({ argv: ctx.argv, env: ctx.env });
  if (!built.ok) {
    emitEnvelope(built.envelope, { writer: ctx.writer, exit: ctx.exit });
    return;
  }

  const { config, networkChain, chainConfig, fleetStore, masterWallet, publicClient } = built.ctx;

  // Store is injected into the intent module, not opened by it — the CLI
  // owns this handle's open/close lifecycle for its own one-shot invocation
  // (the HTTP route front-end instead reuses the daemon's already-open,
  // longer-lived Store; see api/admin-endpoint.ts).
  const jinnStore = new Store(config.dbPath);
  try {
    try {
      const result = await claimRewardsIntent({
        publicClient,
        masterWallet,
        fleetStore,
        chain: networkChain,
        distributorAddress: chainConfig.distributorAddress,
        strict: true,
        jinnStore,
      });
      emitResult(
        result,
        (v) => {
          const value = v as { attempted: number; submitted: number; failedRecoverable: number; failedPermanent: number };
          return [
            'Reward claim tick complete.',
            `Attempted services: ${value.attempted}`,
            `Submitted claims: ${value.submitted}`,
            `Recoverable failures: ${value.failedRecoverable}`,
            `Permanent failures: ${value.failedPermanent}`,
          ].join('\n');
        },
        {
          json: Boolean(parsed.values.json),
          human: Boolean(parsed.values.human),
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
    } catch (e) {
      if (e instanceof TransientError || isRecoverableTransactionError(e)) {
        emitEnvelope(
          {
            code: 'transient_error',
            message: e instanceof Error ? e.message : String(e),
            hint: 'Retry when the RPC endpoint is healthy.',
            exampleCli: 'jinn claim-rewards --yes',
            details: { cause: e instanceof Error ? e.message : String(e) },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      emitEnvelope(
        {
          code: 'fatal',
          message: e instanceof Error ? e.message : String(e),
          details: { cause: e instanceof Error ? e.message : String(e) },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
    }
  } finally {
    jinnStore.close();
  }
}

const command: CommandModule = {
  name: 'claim-rewards',
  summary: 'Pull pending protocol rewards to the fleet multisigs',
  helpText: `Usage: jinn claim-rewards [--dry-run] [--yes] [--human]

Idempotent: zero-delta is success, not error. Second consecutive call
may show submitted:0 and exits 0.

Examples:
  jinn claim-rewards --dry-run
  jinn claim-rewards --yes
`,
  run,
};

export default command;
