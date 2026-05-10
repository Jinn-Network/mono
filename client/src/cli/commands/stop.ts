import { parseArgs } from 'node:util';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { Store } from '../../store/store.js';

interface StopResult {
  schemaVersion: 1;
  generatedAt: string;
  state: 'stopped' | 'stopping';
  pid: number | null;
  killed: boolean;
  pidfilePath: string;
  pidfileRemoved: boolean;
  stalePidfileCleaned: boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function markShutdownClean(dbPath: string | undefined): void {
  if (!dbPath || !existsSync(dbPath)) return;
  const store = new Store(dbPath);
  try {
    store.setShutdownState('clean');
  } finally {
    store.close();
  }
}

function removePidfile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        json: { type: 'boolean', default: false },
        human: { type: 'boolean', default: false },
        config: { type: 'string' },
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
  let config;
  try {
    if (parsed.values.config || (!ctx.env['JINN_EARNING_DIR'] && !ctx.env['JINN_DB_PATH'])) {
      config = loadConfig(parsed.values.config);
    }
  } catch (err) {
    if (parsed.values.config) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          exampleCli: 'jinn stop --config ~/.jinn-client/config.json',
          details: { field: 'config' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
  }
  const earningDir =
    ctx.env['JINN_EARNING_DIR'] ??
    config?.earningDir ??
    join(process.env['HOME'] ?? '.', '.jinn-client', 'earning');
  const dbPath = ctx.env['JINN_DB_PATH'] ?? config?.dbPath;
  const pidPath = join(earningDir, 'daemon.pid');

  if (!existsSync(pidPath)) {
    markShutdownClean(dbPath);
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        state: 'stopped',
        pid: null,
        killed: false,
        pidfilePath: pidPath,
        pidfileRemoved: false,
        stalePidfileCleaned: false,
      } satisfies StopResult,
      () => 'Daemon is already stopped.',
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
    return;
  }

  const parsedPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
  const pid = Number.isFinite(parsedPid) ? parsedPid : null;
  let killed = false;
  let stalePidfileCleaned = false;
  let pidfileRemoved = false;
  try {
    if (pid === null) throw new Error('invalid pidfile');
    process.kill(pid, 'SIGTERM');
    killed = true;
  } catch {
    // Process already gone; clean the stale pidfile and persisted running bit.
    stalePidfileCleaned = true;
    pidfileRemoved = removePidfile(pidPath);
    markShutdownClean(dbPath);
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      state: killed || (pid !== null && processAlive(pid)) ? 'stopping' : 'stopped',
      pid,
      killed,
      pidfilePath: pidPath,
      pidfileRemoved,
      stalePidfileCleaned,
    },
    (v) => {
      const value = v as StopResult;
      return value.killed
        ? `Sent SIGTERM to daemon pid ${value.pid}.`
        : `Daemon pid ${value.pid} was already gone; cleaned stale state.`;
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
Idempotent: if the daemon is already stopped, returns state=stopped and
killed=false with exit 0. Stale pidfiles are removed.

Examples:
  jinn stop
  jinn stop --human
`,
  run,
};

export default command;
