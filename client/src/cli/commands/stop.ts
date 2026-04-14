import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';

async function run(ctx: CommandContext): Promise<void> {
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

  ctx.writer.write(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      pid,
      killed,
    }) + '\n',
  );
}

const command: CommandModule = {
  name: 'stop',
  summary: 'Signal a running jinn daemon to shut down gracefully',
  helpText: `Usage: jinn stop [--json]

Reads the daemon pid from <earningDir>/daemon.pid and sends SIGTERM.
Idempotent: if the daemon is already stopped, returns killed=false
with exit 0.

Examples:
  jinn stop
  jinn stop --json | jq '.killed'
`,
  run,
};

export default command;
