import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';

async function run(ctx: CommandContext): Promise<void> {
  if (!ctx.env['JINN_PASSWORD']) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'A password is required to start the daemon.',
        hint: 'Set the password environment variable required by the client, then re-run.',
        exampleCli: 'jinn run',
        details: { field: 'keystore password', expected: 'non-empty string via environment' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  // Dynamic import so loading the CLI (e.g. `jinn --help`) does not execute
  // `main.ts` top-level side effects or auto-entry.
  const { main } = await import('../../main.js');
  await main();
}

const command: CommandModule = {
  name: 'run',
  summary: 'Start the daemon in the foreground; stops on SIGINT/SIGTERM',
  helpText: `Usage: jinn run [--json]

Long-running. Starts the creator, restorer, and delivery-watcher
loops and runs until the process receives SIGINT or SIGTERM. Before
starting, advances the fleet state machine if needed; exits 10 with
a funding_required envelope if funding is missing.

Requires the password environment variable required by the client
(never as a flag).

Examples:
  jinn run
  jinn run --json 2>/tmp/jinn.log
`,
  run,
};

export default command;
