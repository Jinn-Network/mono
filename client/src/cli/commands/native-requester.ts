/**
 * `jinn native-requester` is the intentional, feature-disabled product boundary for the
 * Phase B native requester vertical. Keeping the invocation visible lets automation depend on
 * a stable command shape without accidentally turning the fixture/product seam into a live
 * transaction path before native daemon composition is reviewed.
 */
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';

const OPTIONS = {
  ...COMMON_FLAGS,
  network: { type: 'string' as const },
  fixture: { type: 'string' as const },
  'run-id': { type: 'string' as const },
};

type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;

function invalid(ctx: CommandContext, message: string): never {
  return emitEnvelope({
    code: 'invalid_invocation',
    message,
    exampleCli: 'jinn native-requester request --network base-sepolia --fixture prediction-snapshot-v1 --run-id <run-id>',
  }, { writer: ctx.writer, exit: ctx.exit });
}

export function createNativeRequesterCommand(): CommandModule {
  return {
    name: 'native-requester',
    summary: 'Native requester vertical (feature-disabled)',
    helpText: `Usage:
  jinn native-requester request --network base-sepolia --fixture prediction-snapshot-v1 --run-id <run-id>

Status:
  This command is intentionally feature-disabled. It accepts the final native requester
  invocation shape but does not load configuration or keys, construct a transaction, or post.

Options:
  --network <name>    Must be base-sepolia
  --fixture <name>    Must be prediction-snapshot-v1
  --run-id <id>       Durable native requester run identifier

Examples:
  jinn native-requester request --network base-sepolia --fixture prediction-snapshot-v1 --run-id operator-run-20260802
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed: Parsed;
      try {
        parsed = parseArgs({ args: ctx.argv, options: OPTIONS, allowPositionals: true }) as Parsed;
      } catch (error) {
        invalid(ctx, error instanceof Error ? error.message : String(error));
      }
      if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'request') {
        invalid(ctx, 'native-requester requires the `request` subcommand');
      }
      if (parsed.values.network !== 'base-sepolia') {
        invalid(ctx, 'native-requester requires --network base-sepolia');
      }
      if (parsed.values.fixture !== 'prediction-snapshot-v1') {
        invalid(ctx, 'native-requester requires --fixture prediction-snapshot-v1');
      }
      if (typeof parsed.values['run-id'] !== 'string' || parsed.values['run-id'].length === 0) {
        invalid(ctx, 'native-requester requires a non-empty --run-id');
      }

      // This is deliberately before configuration, chain reads, role loading, or postTask.
      emitEnvelope({
        code: 'bootstrap_incomplete',
        message: 'The native requester is feature-disabled in this build.',
        hint: 'Native daemon composition and operational enablement are not yet available.',
        exampleCli: 'jinn native-requester request --network base-sepolia --fixture prediction-snapshot-v1 --run-id <run-id>',
        details: { feature: 'native-requester', state: 'feature-disabled' },
      }, { writer: ctx.writer, exit: ctx.exit });
    },
  };
}

export default createNativeRequesterCommand();
