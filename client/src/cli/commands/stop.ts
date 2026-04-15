import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        json: { type: 'boolean', default: false },
        human: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn stop',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const earningDir =
    ctx.env['JINN_EARNING_DIR'] ?? join(process.env['HOME'] ?? '.', '.jinn-client', 'earning');
  const pidPath = join(earningDir, 'daemon.pid');

  if (!existsSync(pidPath)) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'No running daemon pidfile found.',
        hint: 'The daemon writes its pid to <earningDir>/daemon.pid on startup. Start it with `jinn run` first.',
        exampleCli: 'jinn run',
        details: { field: 'daemon_pidfile', expected: pidPath },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
  let killed = false;
  try {
    process.kill(pid, 'SIGTERM');
    killed = true;
  } catch {
    // Process already gone; treat as success with killed=false.
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      pid,
      killed,
    },
    (v) => {
      const value = v as { pid: number; killed: boolean };
      return value.killed
        ? `Sent SIGTERM to daemon pid ${value.pid}.`
        : `Daemon pid ${value.pid} was already gone.`;
    },
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

const command: CommandModule = {
  name: 'stop',
  summary: 'Signal a running jinn daemon to shut down gracefully',
  helpText: `Usage: jinn stop [--human]

Reads the daemon pid from <earningDir>/daemon.pid and sends SIGTERM.
Idempotent: if the daemon is already stopped, returns killed=false
with exit 0.

Examples:
  npx jinn stop
  npx jinn stop --human
`,
  run,
};

export default command;
