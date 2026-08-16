import { parseArgs } from 'node:util';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { Store } from '../../store/store.js';
import { enumerateJinnProcesses, pidMatchesJinn, processAlive } from '../../lifecycle/process-discovery.js';

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
   * when the fallback ran and signaled something. */
  discoveredPids?: number[];
  /** #805 — pids found via cmdline enumeration but NOT signaled because more
   * than one matched: multi-daemon hosts (worktree-per-agent) are a
   * supported pattern, so the fallback refuses to guess which to stop. Run
   * `jinn kill --all` to terminate all of them. Present only when the
   * fallback ran and found more than one match. */
  ambiguousPids?: number[];
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

interface DiscoveryOutcome {
  /** Pids actually SIGTERM'd. */
  signaledPids: number[];
  /** Pids found but deliberately NOT signaled because more than one matched. */
  ambiguousPids: number[];
}

/**
 * #805: cmdline-enumeration fallback for `jinn stop`. Called only when the
 * pidfile-recorded pid could not identify a live daemon (missing pidfile,
 * malformed pidfile, recorded pid already dead, or recorded pid recycled to
 * a non-jinn process) — an orphaned jinn daemon may still be running under a
 * pid the stale pidfile never recorded. SIGTERM only, matching stop's
 * "graceful signal" contract; `jinn kill` owns the SIGKILL escalation.
 *
 * Signals only when exactly one process is discovered. Multi-daemon hosts
 * (worktree-per-agent convention) are a supported pattern — `jinn kill`
 * itself refuses more than one match without `--all`, so the stop fallback
 * must not silently guess and SIGTERM every match host-wide.
 */
function killDiscoveredJinnProcesses(): DiscoveryOutcome {
  const found = enumerateJinnProcesses();
  if (found.length > 1) {
    return { signaledPids: [], ambiguousPids: found.map((p) => p.pid) };
  }
  const signaledPids: number[] = [];
  for (const proc of found) {
    try {
      process.kill(proc.pid, 'SIGTERM');
      signaledPids.push(proc.pid);
    } catch {
      // Process exited between enumeration and signal — not an error.
    }
  }
  return { signaledPids, ambiguousPids: [] };
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
    const discovery = killDiscoveredJinnProcesses();
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        state: discovery.signaledPids.length > 0 ? 'stopping' : 'stopped',
        pid: null,
        killed: discovery.signaledPids.length > 0,
        pidfilePath: pidPath,
        pidfileRemoved: false,
        stalePidfileCleaned: false,
        ...(discovery.signaledPids.length > 0 ? { discoveredPids: discovery.signaledPids } : {}),
        ...(discovery.ambiguousPids.length > 0 ? { ambiguousPids: discovery.ambiguousPids } : {}),
      } satisfies StopResult,
      (v) => {
        const value = v as StopResult;
        if (value.ambiguousPids && value.ambiguousPids.length > 0) {
          return `No pidfile found; ${value.ambiguousPids.length} jinn processes found (pids ${value.ambiguousPids.join(', ')}) — refusing to guess which to stop. Run \`jinn kill --all\`.`;
        }
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
  let ambiguousPids: number[] = [];

  // #805: confirm the recorded pid is actually a jinn daemon before signaling
  // it. `pid === null` (malformed pidfile) and a definitive 'no-match' (pid
  // recycled to an unrelated process) are both treated as "the pidfile does
  // not identify a live daemon" and fall through to enumeration below.
  // 'unknown' (ps unavailable) proceeds with SIGTERM as before — stop must
  // still work when ps can't be probed.
  const cmdlineMatch = pid !== null ? pidMatchesJinn(pid) : 'unknown';
  if (pid !== null && cmdlineMatch !== 'no-match') {
    try {
      process.kill(pid, 'SIGTERM');
      killed = true;
    } catch {
      // Recorded pid is gone; clean stale state and fall through to cmdline
      // enumeration (#805) — an orphaned daemon may still be running under a
      // pid the stale file doesn't record.
      stalePidfileCleaned = true;
      pidfileRemoved = removePidfile(pidPath);
      markShutdownClean(dbPath);
      const discovery = killDiscoveredJinnProcesses();
      discoveredPids = discovery.signaledPids;
      ambiguousPids = discovery.ambiguousPids;
    }
  } else {
    stalePidfileCleaned = true;
    pidfileRemoved = removePidfile(pidPath);
    markShutdownClean(dbPath);
    const discovery = killDiscoveredJinnProcesses();
    discoveredPids = discovery.signaledPids;
    ambiguousPids = discovery.ambiguousPids;
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
      ...(ambiguousPids.length > 0 ? { ambiguousPids } : {}),
    },
    (v) => {
      const value = v as StopResult;
      if (value.ambiguousPids && value.ambiguousPids.length > 0) {
        return `Daemon pid ${value.pid} was already gone; ${value.ambiguousPids.length} jinn processes found (pids ${value.ambiguousPids.join(', ')}) — refusing to guess which to stop. Run \`jinn kill --all\`.`;
      }
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

If the pidfile is missing, malformed, records a pid that is already dead,
or records a pid recycled to a non-jinn process, falls through to cmdline
enumeration (#805). If exactly one jinn daemon process is found, sends it
SIGTERM and reports the pid in discoveredPids. If more than one is found,
signals nothing (multi-daemon hosts are supported) and reports the pids
in ambiguousPids — re-run with \`jinn kill --all\` to terminate all of
them. Use \`jinn kill\` if a process needs a harder SIGKILL escalation.

Examples:
  jinn stop
  jinn stop --human
`,
  run,
};

export default command;
