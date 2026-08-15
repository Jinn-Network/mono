import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  enumerateJinnProcesses as defaultEnumerateJinnProcesses,
  pidMatchesJinn as defaultCmdlineMatch,
  processAlive as defaultProcessAlive,
  type CmdlineMatch,
  type JinnProcess,
} from '../../lifecycle/process-discovery.js';

const POLL_INTERVAL_MS = 200;
const SIGTERM_TIMEOUT_MS = 10_000;

export interface KillDeps {
  enumerateJinnProcesses: () => JinnProcess[];
  killSignal: (pid: number, signal: NodeJS.Signals) => void;
  processAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /** #805 — re-verify identity immediately before the SIGKILL escalation, in
   * case the pid was recycled during the SIGTERM poll window. */
  cmdlineMatch: (pid: number) => CmdlineMatch;
}

function defaultKillSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

const PRODUCTION_DEPS: KillDeps = {
  enumerateJinnProcesses: defaultEnumerateJinnProcesses,
  killSignal: defaultKillSignal,
  processAlive: defaultProcessAlive,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  cmdlineMatch: defaultCmdlineMatch,
};

interface KillResult {
  schemaVersion: 1;
  generatedAt: string;
  found: Array<{ pid: number; command: string }>;
  killed: number[];
  forceKilled: number[];
}

/**
 * SIGTERM one pid, poll `processAlive` up to SIGTERM_TIMEOUT_MS, and SIGKILL
 * if it's still alive after that. Returns whether SIGKILL was needed.
 */
async function terminateOne(pid: number, deps: KillDeps): Promise<{ pid: number; forced: boolean }> {
  deps.killSignal(pid, 'SIGTERM');
  let elapsed = 0;
  while (elapsed < SIGTERM_TIMEOUT_MS) {
    if (!deps.processAlive(pid)) {
      return { pid, forced: false };
    }
    await deps.sleep(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;
  }
  if (deps.processAlive(pid)) {
    // #805: re-verify identity immediately before SIGKILL — the pid could in
    // principle have been recycled to an unrelated process during the 10s
    // SIGTERM window. Only skip the SIGKILL on a definitive no-match;
    // 'match' or 'unknown' (ps unavailable) proceed, matching the existing
    // fail-toward-completion posture of `jinn kill`.
    if (deps.cmdlineMatch(pid) === 'no-match') {
      return { pid, forced: false };
    }
    deps.killSignal(pid, 'SIGKILL');
    return { pid, forced: true };
  }
  return { pid, forced: false };
}

export function createKillCommand(deps: KillDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'kill',
    summary: 'Force-terminate jinn daemon processes discovered by cmdline enumeration',
    helpText: `Usage: jinn kill [--all] [--human]

Enumerates host processes whose command line matches a jinn daemon
invocation (\`node .../dist/bin/jinn.js run\` or \`jinn run\`), sends
SIGTERM, waits up to 10s, then sends SIGKILL to any survivor. Excludes
the current process.

Unlike \`jinn stop\`, this does not read a pidfile — it is the recovery
path when the pidfile is stale, missing, or ownerless.

If more than one matching process is found, jinn kill refuses and
requires --all to avoid silently killing an unrelated jinn daemon (e.g.
a second worktree or operator on the same host). A single match is
always killed without --all.

Examples:
  jinn kill
  jinn kill --all
  jinn kill --human
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: { ...COMMON_FLAGS, all: { type: 'boolean' as const, default: false } },
          allowPositionals: false,
        });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn kill',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const found = deps.enumerateJinnProcesses();
      const all = Boolean(parsed.values['all']);

      if (found.length > 1 && !all) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: `Found ${found.length} jinn daemon processes; refusing to kill more than one without --all.`,
            hint: 'Re-run with `jinn kill --all` to terminate all of them.',
            exampleCli: 'jinn kill --all',
            details: {
              field: 'all',
              found: found.map((p) => ({ pid: p.pid, command: p.command })),
            },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const killed: number[] = [];
      const forceKilled: number[] = [];
      for (const proc of found) {
        const result = await terminateOne(proc.pid, deps);
        killed.push(result.pid);
        if (result.forced) forceKilled.push(result.pid);
      }

      const payload: KillResult = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        found: found.map((p) => ({ pid: p.pid, command: p.command })),
        killed,
        forceKilled,
      };

      emitResult(
        payload,
        (v) => {
          const value = v as KillResult;
          if (value.found.length === 0) return 'No jinn daemon processes found.';
          const forced =
            value.forceKilled.length > 0 ? ` (${value.forceKilled.length} required SIGKILL)` : '';
          return `Terminated ${value.killed.length} jinn daemon process(es): ${value.killed.join(', ')}${forced}.`;
        },
        {
          json: Boolean(parsed.values['json']),
          human: Boolean(parsed.values['human']),
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
    },
  };
}

const command: CommandModule = createKillCommand();
export default command;
