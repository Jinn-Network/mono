/**
 * Pidfile liveness preflight (issue #649). Classifies the recorded PID and
 * returns a discriminated decision; side-effect-free so the caller owns the
 * unlink (mirrors the idiom at `client/src/mcp/operator-server.ts:209-213`).
 *
 * Branches (load-bearing — see #649 acceptance criteria):
 *   - File missing               → { decision: 'proceed' }
 *   - File malformed (NaN/empty) → { decision: 'unlink-stale', reason: 'malformed' }
 *   - PID 1 or our own pid       → { decision: 'unlink-stale', reason: 'self-or-pid1-container' }
 *   - process.kill(pid, 0) ESRCH → { decision: 'unlink-stale', reason: 'esrch' }
 *   - process.kill(pid, 0) ok    → { decision: 'refuse', reason: 'alive' }
 *   - process.kill(pid, 0) EPERM → { decision: 'refuse', reason: 'eperm' }
 *   - any other errno            → { decision: 'refuse', reason: 'unknown' }
 *
 * The PID-1/self branch classifies *before* the `process.kill` probe (#805): in
 * a container the daemon is PID 1, whose pidfile outlives the container on the
 * persistent volume; `process.kill(1, 0)` always succeeds, so a probe-first
 * order would mis-classify the stale record as a live sibling and crash-loop.
 *
 * `.trim()` before `parseInt` is required: `main.ts` writes the PID with a
 * trailing `\n` (see `client/src/main.ts` writeFileSync near the pidfile site).
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { emitEnvelope, type EnvelopeSinks } from '../errors/envelope.js';
import { emitStructured } from '../events/emitter.js';

export type PidfileLivenessDecision =
  | { decision: 'proceed' }
  | {
      decision: 'unlink-stale';
      pid: number | null;
      pidfilePath: string;
      reason: 'malformed' | 'esrch' | 'self-or-pid1-container';
    }
  | {
      decision: 'refuse';
      pid: number;
      pidfilePath: string;
      reason: 'alive' | 'eperm' | 'unknown';
    };

export interface CheckPidfileLivenessInput {
  pidPath: string;
}

export function checkPidfileLiveness(
  input: CheckPidfileLivenessInput,
): PidfileLivenessDecision {
  const { pidPath } = input;
  if (!existsSync(pidPath)) {
    return { decision: 'proceed' };
  }

  let raw: string;
  try {
    raw = readFileSync(pidPath, 'utf-8');
  } catch {
    // Unreadable pidfile: treat as stale. If the caller's subsequent write also
    // fails, that surfaces via main.ts's `writeFileSync`.
    return { decision: 'unlink-stale', pid: null, pidfilePath: pidPath, reason: 'malformed' };
  }

  const parsed = parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { decision: 'unlink-stale', pid: null, pidfilePath: pidPath, reason: 'malformed' };
  }

  // #805: in a container the daemon is PID 1; the pidfile on the persistent
  // volume outlives the container, and `process.kill(1, 0)` always succeeds, so
  // we must classify the self/PID-1 record as stale *before* the liveness probe
  // below — otherwise the probe reports it alive and the daemon crash-loops. A
  // record of our own pid is likewise self, never a live sibling.
  if (parsed === 1 || parsed === process.pid) {
    return { decision: 'unlink-stale', pid: parsed, pidfilePath: pidPath, reason: 'self-or-pid1-container' };
  }

  try {
    process.kill(parsed, 0);
    return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'alive' };
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ESRCH') {
      return { decision: 'unlink-stale', pid: parsed, pidfilePath: pidPath, reason: 'esrch' };
    }
    if (errno === 'EPERM') {
      return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'eperm' };
    }
    // Any other errno: conservative refuse rather than risk trampling a daemon
    // we can't classify.
    return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'unknown' };
  }
}

/**
 * Apply the pidfile-liveness gate at `jinn run` startup (#649). On `refuse`
 * emits the `invalid_invocation` envelope and exits (does not return); on
 * `unlink-stale` logs the cleanup, removes the stale pidfile, and returns;
 * on `proceed` returns immediately. Callers MUST write the pidfile themselves
 * after this returns — the helper deliberately stops short of the write so the
 * "// DO NOT add store mutations above this line — see #649" invariant in
 * main.ts stays visible at the call site.
 */
export function applyPidfileLivenessGate(
  pidPath: string,
  sinks: EnvelopeSinks = {},
): void {
  const liveness = checkPidfileLiveness({ pidPath });
  if (liveness.decision === 'refuse') {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Another jinn daemon is already running (PID ${liveness.pid}).`,
        hint: 'Run `jinn stop` to terminate it, or set JINN_EARNING_DIR to a different earning directory.',
        exampleCli: 'jinn stop',
        details: {
          field: 'daemon_pidfile',
          pid: liveness.pid,
          pidfilePath: pidPath,
          reason: liveness.reason,
        },
      },
      sinks,
    );
    // emitEnvelope calls process.exit in production; the test sink may throw
    // or no-op. Either way control does not fall through to the writeFileSync
    // in the caller.
    return;
  }
  if (liveness.decision === 'unlink-stale') {
    emitStructured({
      kind: 'system',
      message: `cleaning up stale pidfile (${liveness.reason})`,
      details: {
        phase: 'preflight',
        pidfilePath: pidPath,
        reason: liveness.reason,
        pid: liveness.pid,
      },
    });
    try {
      unlinkSync(pidPath);
    } catch {
      /* best-effort — the writeFileSync that follows surfaces any real problem */
    }
  }
}
