/**
 * Pidfile liveness preflight (issue #649).
 *
 * Reads <earningDir>/daemon.pid (if present), classifies the recorded PID,
 * and returns a discriminated decision the caller acts on. The function does
 * NOT mutate the filesystem — on `unlink-stale` the caller is responsible for
 * the `unlinkSync(pidPath)` call. Keeping the classifier side-effect-free
 * makes it trivially testable and lets the caller wrap the unlink in its own
 * try/catch consistent with the existing idiom in
 * `client/src/mcp/operator-server.ts:209-213`.
 *
 * Behavioral contract (mirrors the issue body's acceptance criteria + the
 * proven pattern at `client/src/mcp/operator-server.ts:203-215`):
 *
 *   - File missing               → { decision: 'proceed' }
 *   - File malformed (NaN/empty) → { decision: 'unlink-stale', reason: 'malformed' }
 *   - process.kill(pid, 0) ESRCH → { decision: 'unlink-stale', reason: 'esrch' }
 *   - process.kill(pid, 0) ok    → { decision: 'refuse', reason: 'alive' }
 *   - process.kill(pid, 0) EPERM → { decision: 'refuse', reason: 'eperm' }
 *   - any other errno            → { decision: 'refuse', reason: 'unknown' }
 *
 * The newline handling matches `client/src/cli/commands/stop.ts:124`: read
 * the file, `.trim()`, `parseInt(_, 10)`. `main.ts` writes the pidfile with a
 * trailing `\n` (see `client/src/main.ts:2578`), so trim is required.
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
    // Unreadable pidfile: treat as malformed/stale. The caller will unlink
    // and proceed; if the next write also fails, that failure surfaces
    // upstream via main.ts's `writeFileSync` call.
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
    // Any other errno: conservative refuse. Better to surface a clear error
    // to the operator than risk trampling a daemon we can't classify.
    return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'unknown' };
  }
}
