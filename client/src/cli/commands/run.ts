import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { main } from '../../main.js';

async function run(ctx: CommandContext): Promise<void> {
  if (!ctx.env['JINN_PASSWORD']) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'JINN_PASSWORD is required to start the daemon.',
        exampleCli: 'JINN_PASSWORD=... jinn run',
        details: { field: 'JINN_PASSWORD', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  // Delegate to the existing main.ts entry; it owns signal handlers and
  // daemon lifecycle. Errors are already routed through emitEnvelope by
  // main.ts's catch handler (plan 01).
  await main();
}

const command: CommandModule = {
  name: 'run',
  summary: 'Start the daemon in the foreground; stops on SIGINT/SIGTERM',
  helpText: `Usage: JINN_PASSWORD=... jinn run [--json]

Long-running. Starts the creator, restorer, and delivery-watcher
loops and runs until the process receives SIGINT or SIGTERM. Before
starting, advances the fleet state machine if needed; exits 10 with
a funding_required envelope if funding is missing.

Examples:
  JINN_PASSWORD=secret jinn run
  JINN_PASSWORD=secret jinn run --json 2>/tmp/jinn.log
`,
  run,
};

export default command;
