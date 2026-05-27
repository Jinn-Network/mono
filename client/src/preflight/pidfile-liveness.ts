/**
 * Pidfile liveness preflight (issue #649). Classifies the recorded PID and
 * returns a discriminated decision; side-effect-free so the caller owns the
 * unlink (mirrors the idiom at `client/src/mcp/operator-server.ts:209-213`).
 *
 * Branches (load-bearing — see #649 acceptance criteria):
 *   - File missing               → { decision: 'proceed' }
 *   - File malformed (NaN/empty) → { decision: 'unlink-stale', reason: 'malformed' }
 *   - process.kill(pid, 0) ESRCH → { decision: 'unlink-stale', reason: 'esrch' }
 *   - process.kill(pid, 0) ok    → { decision: 'refuse', reason: 'alive' }
 *   - process.kill(pid, 0) EPERM → { decision: 'refuse', reason: 'eperm' }
 *   - any other errno            → { decision: 'refuse', reason: 'unknown' }
 *
 * `.trim()` before `parseInt` is required: `main.ts` writes the PID with a
 * trailing `\n` (see `client/src/main.ts` writeFileSync near the pidfile site).
 */

import { existsSync, readFileSync } from 'node:fs';

export type PidfileLivenessDecision =
  | { decision: 'proceed' }
  | {
      decision: 'unlink-stale';
      pid: number | null;
      pidfilePath: string;
      reason: 'malformed' | 'esrch';
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
