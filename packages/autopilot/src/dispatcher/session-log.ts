import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Stable directory for per-session stdout/stderr logs (jinn-mono#533).
 * Lives under the operator's `~/.jinn-client` tree alongside other client
 * state. Resolved once from `os.homedir()` at module load — a fixed,
 * absolute path so `tail -f <dir>/<N>.log` works from any terminal/cwd.
 */
export const SESSIONS_LOG_DIR = join(homedir(), '.jinn-client', 'autopilot', 'sessions');

/**
 * The log-file path for one dispatched session, keyed by issue number:
 * `<SESSIONS_LOG_DIR>/<N>.log`. Deterministic and I/O-free — opening the
 * file (and creating the dir) is the caller's job. The path is intentionally
 * NOT timestamped so it stays predictable for `tail -f`; re-dispatch
 * stability across runs is achieved by opening this path in append mode
 * (see the production SpawnFn lambda).
 */
export function sessionLogPath(issueNumber: number): string {
  return join(SESSIONS_LOG_DIR, `${issueNumber}.log`);
}

/**
 * The dispatch-time marker path for one session, keyed by issue number:
 * `<SESSIONS_LOG_DIR>/<N>.started-at`. Deterministic and I/O-free — the
 * production spawn lambda rewrites (truncates) this file at every dispatch,
 * so its mtime records the most recent dispatch time; `recoverStartedAt`
 * reads it when re-deriving in-flight sessions.
 */
export function sessionStartedAtPath(issueNumber: number): string {
  return join(SESSIONS_LOG_DIR, `${issueNumber}.started-at`);
}

