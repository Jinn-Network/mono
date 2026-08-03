/**
 * D0a P3 (#525/#562/#897): CLI daemon guard.
 *
 * `direct-safe-broadcaster.ts` and `FleetBootstrapper` (via `executeSafeTxDirect`
 * / `executeSafeTxBatch`) skip a nonce ledger / broadcast lock for standalone
 * one-shot CLI verbs on the premise that a CLI verb sends exactly one Safe
 * transaction per invocation. That premise only holds when no `jinn run`
 * daemon is concurrently signing from the SAME agent EOA against the SAME
 * earning directory (`cli/execution-context.ts:186,201`,
 * `cli/commands/solver-plugins.ts:184,239`) -- the daemon and the CLI verb are
 * separate OS processes, so P1/P2's in-process `withEoaBroadcastLock`
 * unification cannot serialize them. If both broadcast around the same time
 * they can read the same pending nonce and collide, exactly like the
 * P2 bug this closes.
 *
 * `checkDaemonGuard` reuses the existing `daemon.pid` read pattern (see
 * `cli/commands/stop.ts`, `api/gather-status.ts`, `cli/commands/keys-backup.ts`,
 * and the more thorough classifier at `preflight/pidfile-liveness.ts`) rather
 * than inventing a new liveness mechanism: it delegates to
 * `checkPidfileLiveness` and blocks whenever that classifier would refuse
 * (a confirmed-alive jinn daemon, or a pid we cannot conclusively rule out —
 * EPERM / unknown errno — fails closed for the same reason the `jinn run`
 * startup gate does), PLUS one deliberate inversion: `checkPidfileLiveness`'s
 * `self-or-pid1-container` branch (`decision: 'unlink-stale'`) is correct
 * for `jinn run`'s OWN startup gate -- a fresh container always precedes the
 * pid-1 daemon writing its own current pidfile, so a pid-1 record there is
 * necessarily stale. It is NOT correct here: this guard runs from a
 * *separate* CLI process, potentially inside the SAME live container, where
 * pid 1 in the pidfile means the daemon it must not race is alive right now.
 * This guard treats that branch as blocking rather than reusing the
 * run-gate's "safe to reclaim" verb.
 */

import { join } from 'node:path';
import { checkPidfileLiveness } from '../preflight/pidfile-liveness.js';
import type { BuildEnvelopeInput } from '../errors/envelope.js';

/** Explicit opt-out for operators who have verified concurrent broadcast is safe. */
export const DAEMON_GUARD_OPT_OUT_ENV = 'JINN_ALLOW_CLI_BROADCAST_WITH_DAEMON';

export type DaemonGuardReason =
  | 'not-running'
  | 'alive'
  | 'eperm'
  | 'unknown'
  | 'opted-out'
  | 'pid1-container';

// Discriminated on `blocked` so `if (result.blocked)` narrows callers to the
// variant that actually carries a confirmed/suspected-alive pid, without a
// separate type assertion at every call site.
export type DaemonGuardResult =
  | { blocked: false; pid: null; pidfilePath: string; reason: 'not-running' | 'opted-out' }
  | {
      blocked: true;
      pid: number | null;
      pidfilePath: string;
      reason: 'alive' | 'eperm' | 'unknown' | 'pid1-container';
    };

export interface CheckDaemonGuardOptions {
  earningDir: string;
  env?: NodeJS.ProcessEnv;
}

function isOptedOut(env: NodeJS.ProcessEnv): boolean {
  const raw = env[DAEMON_GUARD_OPT_OUT_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Returns `blocked: true` only when a live jinn daemon is confirmed (or
 * cannot be conclusively ruled out) for this earning directory. Never
 * mutates the pidfile — this is a read-only check; stale-pidfile cleanup
 * remains `jinn run`'s job via `applyPidfileLivenessGate`.
 */
export function checkDaemonGuard(options: CheckDaemonGuardOptions): DaemonGuardResult {
  const env = options.env ?? process.env;
  const pidPath = join(options.earningDir, 'daemon.pid');

  if (isOptedOut(env)) {
    return { blocked: false, pid: null, pidfilePath: pidPath, reason: 'opted-out' };
  }

  const liveness = checkPidfileLiveness({ pidPath });
  if (liveness.decision === 'refuse') {
    return { blocked: true, pid: liveness.pid, pidfilePath: liveness.pidfilePath, reason: liveness.reason };
  }
  if (liveness.decision === 'unlink-stale' && liveness.reason === 'self-or-pid1-container') {
    return {
      blocked: true,
      pid: liveness.pid,
      pidfilePath: liveness.pidfilePath,
      reason: 'pid1-container',
    };
  }
  return { blocked: false, pid: null, pidfilePath: pidPath, reason: 'not-running' };
}

/** Build the `invalid_invocation` envelope for a blocked `DaemonGuardResult`. */
export function daemonGuardEnvelope(
  result: Extract<DaemonGuardResult, { blocked: true }>,
  exampleCli: string,
): BuildEnvelopeInput {
  return {
    code: 'invalid_invocation',
    message:
      `Refusing to broadcast: a jinn daemon appears to be running (PID ${result.pid ?? 'unknown'}) ` +
      'against this earning directory. This verb signs on-chain writes from the same agent EOA, ' +
      'and a CLI verb has no cross-process lock to prevent a nonce collision with the daemon.',
    hint:
      'Stop the daemon first (`jinn stop`), or set ' +
      `${DAEMON_GUARD_OPT_OUT_ENV}=1 once you have verified it is safe to run concurrently.`,
    exampleCli,
    details: {
      field: 'daemon_pidfile',
      pid: result.pid,
      pidfilePath: result.pidfilePath,
      reason: result.reason,
    },
  };
}
