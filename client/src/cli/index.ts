/**
 * jinn CLI dispatcher.
 *
 * Contract: spec/2026-04-14-client-surface.md §2 (verbs), §6 (error envelope),
 * §7 (behavioral rules).
 *
 * Adding a verb: create `commands/<name>.ts` exporting a default CommandModule,
 * then import and push into COMMANDS below.
 */

import type { CommandContext, CommandModule } from './command.js';
import { emitEnvelope } from '../errors/envelope.js';
import { renderTopLevelHelp, renderCommandHelp } from './help.js';

import versionCommand from './commands/version.js';

const COMMANDS: CommandModule[] = [
  versionCommand,
];

export interface RunCliOptions {
  writer?: { write: (s: string) => boolean };
  exit?: (code: number) => void;
  stdoutIsTty?: boolean;
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<void> {
  const writer = opts.writer ?? process.stdout;
  const exit = opts.exit ?? ((c: number) => { process.exit(c); });
  const stdoutIsTty = opts.stdoutIsTty ?? Boolean(process.stdout.isTTY);

  // No args → top-level help, exit 0.
  if (argv.length === 0) {
    writer.write(renderTopLevelHelp(COMMANDS) + '\n');
    return;
  }

  const [verb, ...rest] = argv;

  // --help at the top level
  if (verb === '--help' || verb === '-h') {
    writer.write(renderTopLevelHelp(COMMANDS) + '\n');
    return;
  }

  const command = COMMANDS.find((c) => c.name === verb);
  if (!command) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown verb: ${verb}`,
        hint: 'Run `jinn --help` for the list of verbs.',
        exampleCli: 'jinn --help',
        details: {
          field: 'subcommand',
          expected: COMMANDS.map((c) => c.name).join('|'),
        },
      },
      { writer, exit },
    );
    return;
  }

  // Per-verb --help short-circuit (before any command-specific parsing)
  if (rest.includes('--help') || rest.includes('-h')) {
    writer.write(renderCommandHelp(command) + '\n');
    return;
  }

  const ctx: CommandContext = {
    argv: rest,
    stdoutIsTty,
    writer,
    exit,
    env: process.env,
  };

  try {
    await command.run(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details: Record<string, unknown> = { cause: message, verb };
    const debug =
      process.env['JINN_DEBUG'] === '1' ||
      process.env['JINN_DEBUG'] === 'true' ||
      process.env['DEBUG'] === '1';
    if (debug && err instanceof Error && err.stack) {
      details.stack = err.stack;
    }
    emitEnvelope(
      {
        code: 'fatal',
        message,
        details,
      },
      { writer, exit },
    );
  }
}
