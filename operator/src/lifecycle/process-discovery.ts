/**
 * Shared process-discovery helpers for daemon lifecycle controls.
 *
 * Used by `jinn run` (precheck), `jinn stop` (fallback), and `jinn kill`
 * (enumeration). All helpers are sync — they shell out to `ps` or read
 * /proc — and never block on network or daemon-side I/O.
 *
 * The cmdline-match regex MUST exclude `process.pid` to keep the precheck
 * safe for the running CLI process itself.
 *
 * Design: docs/superpowers/plans/2026-07-14-jinn-lifecycle-orphan-recovery.md
 * Issue: #805
 */
import { execSync as nodeExecSync } from 'node:child_process';

export interface JinnProcess {
  pid: number;
  command: string;
}

/**
 * Tri-state result of probing a single pid's cmdline (#805). `ps` failing
 * (permissions, missing/odd `ps` in a minimal container) is NOT the same as
 * `ps` succeeding and definitively showing a non-jinn cmdline — callers that
 * collapse the two fail open (misclassify a real daemon as reclaimable).
 * `'unknown'` MUST be treated as "could not rule out a live jinn daemon".
 */
export type CmdlineMatch = 'match' | 'no-match' | 'unknown';

// Matches:
//   `node /path/to/dist/bin/jinn.js run [...]`             (published-package entrypoint)
//   `/usr/bin/node .../dist/bin/jinn.js run`
//   `jinn run [...]`                                        (published `jinn` shim)
//   `node --require .../tsx/dist/preflight.cjs --import file://.../tsx/dist/loader.mjs
//     /path/to/src/bin/jinn.ts run`                          (repo-contributor tsx dev mode,
//                                                             `yarn jinn run` -> package.json
//                                                             `"jinn": "tsx src/bin/jinn.ts"`)
// Does NOT match:
//   `grep jinn`
//   `vim jinn-notes.md`
//   `cat /var/log/jinn.log`
//   `jinn run-summary.log` (`run` must be followed by whitespace or end-of-string)
// `.*?` (not a single `\s+\S*` token) between `node` and the script path is
// required for the tsx case: `node --require .../preflight.cjs --import
// file://.../loader.mjs .../src/bin/jinn.ts run` has node flags between the
// interpreter and the script, not just one path token.
const JINN_CMDLINE_RE =
  /(?:\bnode\b.*?(?:dist\/bin\/jinn\.js|src\/bin\/jinn\.ts)|\bjinn\b)\s+run(?=\s|$)/;

// Injectable for tests. Production uses node:child_process.execSync directly.
type ExecSyncFn = (cmd: string) => string | Buffer;
let execSyncImpl: ExecSyncFn = (cmd) => nodeExecSync(cmd, { encoding: 'utf-8' });

/** @internal — tests only */
export function __setExecSyncForTesting(fn: ExecSyncFn): void {
  execSyncImpl = fn;
}
/** @internal — tests only */
export function __resetExecSyncForTesting(): void {
  execSyncImpl = (cmd) => nodeExecSync(cmd, { encoding: 'utf-8' });
}

/** True iff `process.kill(pid, 0)` succeeds. Pure check, no signal sent. */
export function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the cmdline for a single pid and classify it against the jinn regex.
 * Exported (#805) so `pidfile-liveness.ts`'s `jinn run` precheck and `jinn
 * stop`/`jinn kill`'s identity re-verification can reclaim/skip a
 * live-but-not-jinn pid instead of refusing/signaling it.
 *
 * `-ww` (unlimited width) is required — without it BSD/macOS `ps` truncates
 * COMMAND to the terminal width, which can cut the regex's match target out
 * of long cmdlines.
 *
 * Returns `'unknown'` (never `'no-match'`) when `ps` throws or reports empty
 * output — see the `CmdlineMatch` doc comment for why that distinction is
 * load-bearing.
 */
export function pidMatchesJinn(pid: number): CmdlineMatch {
  try {
    const out = String(execSyncImpl(`ps -ww -p ${pid} -o command=`)).trim();
    if (!out) return 'unknown';
    return JINN_CMDLINE_RE.test(out) ? 'match' : 'no-match';
  } catch {
    return 'unknown';
  }
}

/**
 * Enumerate all jinn-daemon processes on the host. Excludes `process.pid`
 * so the calling CLI never lists itself. Returns [] on any ps error or
 * empty output — callers must treat "found nothing" as authoritative.
 */
export function enumerateJinnProcesses(): JinnProcess[] {
  let out: string;
  try {
    out = String(execSyncImpl('ps -ww -eo pid=,command=')).trim();
  } catch {
    return [];
  }
  if (!out) return [];
  const results: JinnProcess[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[1]!, 10);
    const cmd = m[2]!.trim();
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    if (!JINN_CMDLINE_RE.test(cmd)) continue;
    results.push({ pid, command: cmd });
  }
  return results;
}
