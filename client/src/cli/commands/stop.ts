import { parseArgs } from 'node:util';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { Store } from '../../store/store.js';
import { enumerateJinnProcesses, processAlive } from '../../lifecycle/process-discovery.js';

interface StopResult {
  schemaVersion: 1;
  generatedAt: string;
  state: 'stopped' | 'stopping';
  pid: number | null;
  killed: boolean;
  pidfilePath: string;
  pidfileRemoved: boolean;
  stalePidfileCleaned: boolean;
  /** #805 — pids found and SIGTERM'd via cmdline enumeration when the
   * recorded pidfile pid could not identify a live daemon. Present only
   * when the fallback ran and found something. */
  discoveredPids?: number[];
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

/**
 * #805: cmdline-enumeration fallback for `jinn stop`. Called only when the
 * pidfile-recorded pid could not identify a live daemon (missing pidfile,
 * malformed pidfile, or the recorded pid is already dead) — an orphaned
 * jinn daemon may still be running under a pid the stale pidfile never
 * recorded. SIGTERM only, matching stop's "graceful signal" contract;
 * `jinn kill` owns the SIGKILL escalation.
 */
function killDiscoveredJinnProcesses(): number[] {
  const found = enumerateJinnProcesses();
  const killedPids: number[] = [];
  for (const proc of found) {
    try {
      process.kill(proc.pid, 'SIGTERM');
      killedPids.push(proc.pid);
    } catch {
      // Process exited between enumeration and signal — not an error.
    }
  }
  return killedPids;
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
    // #805: no pidfile to read — fall through to cmdline enumeration so an
    // orphaned daemon (pidfile lost or never written) still gets signaled
    // instead of `jinn stop` silently no-oping.
    const discoveredPids = killDiscoveredJinnProcesses();
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        state: discoveredPids.length > 0 ? 'stopping' : 'stopped',
        pid: null,
        killed: discoveredPids.length > 0,
        pidfilePath: pidPath,
        pidfileRemoved: false,
        stalePidfileCleaned: false,
        ...(discoveredPids.length > 0 ? { discoveredPids } : {}),
      } satisfies StopResult,
      (v) => {
        const value = v as StopResult;
        return value.discoveredPids && value.discoveredPids.length > 0
          ? `No pidfile found; discovered and signaled ${value.discoveredPids.length} orphaned jinn process(es): ${value.discoveredPids.join(', ')}.`
          : 'Daemon is already stopped.';
      },
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
  let discoveredPids: number[] = [];
  try {
    if (pid === null) throw new Error('invalid pidfile');
    process.kill(pid, 'SIGTERM');
    killed = true;
  } catch {
    // Recorded pid is gone or the pidfile was malformed; clean stale state
    // and fall through to cmdline enumeration (#805) — an orphaned daemon
    // may still be running under a pid the stale file doesn't record.
    stalePidfileCleaned = true;
    pidfileRemoved = removePidfile(pidPath);
    markShutdownClean(dbPath);
    discoveredPids = killDiscoveredJinnProcesses();
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      state:
        killed || discoveredPids.length > 0 || (pid !== null && processAlive(pid))
          ? 'stopping'
          : 'stopped',
      pid,
      killed: killed || discoveredPids.length > 0,
      pidfilePath: pidPath,
      pidfileRemoved,
      stalePidfileCleaned,
      ...(discoveredPids.length > 0 ? { discoveredPids } : {}),
    },
    (v) => {
      const value = v as StopResult;
      if (value.killed && value.discoveredPids && value.discoveredPids.length > 0) {
        return `Daemon pid ${value.pid} was already gone; signaled ${value.discoveredPids.length} discovered jinn process(es): ${value.discoveredPids.join(', ')}.`;
      }
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

If the pidfile is missing, malformed, or records a pid that is already
dead, falls through to cmdline enumeration (#805) and sends SIGTERM to
any jinn daemon process found, reporting the pids in discoveredPids. Use
\`jinn kill\` if a process needs a harder SIGKILL escalation.

Examples:
  jinn stop
  jinn stop --human
`,
  run,
};

export default command;
