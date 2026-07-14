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
import { existsSync, readFileSync } from 'node:fs';

export interface PidfileStatus {
  /** Parsed pid, or null if file missing / malformed. */
  pid: number | null;
  /** `process.kill(pid, 0)` succeeded. */
  alive: boolean;
  /** `alive` AND cmdline matches the jinn daemon regex. */
  isJinn: boolean;
}

export interface JinnProcess {
  pid: number;
  command: string;
}

// Matches:
//   `node /path/to/dist/bin/jinn.js run [...]`
//   `/usr/bin/node .../dist/bin/jinn.js run`
//   `jinn run [...]`  (when invoked via the published `jinn` shim)
// Does NOT match:
//   `grep jinn`
//   `vim jinn-notes.md`
//   `cat /var/log/jinn.log`
const JINN_CMDLINE_RE = /(?:\bnode\b[^\s]*\s+\S*dist\/bin\/jinn\.js|\bjinn\b)\s+run\b/;

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
 * Read `pid` from a bare-integer pidfile, then probe liveness and cmdline.
 * Never throws; missing/malformed/dead all return structured negatives.
 */
export function readPidfile(path: string): PidfileStatus {
  if (!existsSync(path)) {
    return { pid: null, alive: false, isJinn: false };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8').trim();
  } catch {
    return { pid: null, alive: false, isJinn: false };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { pid: null, alive: false, isJinn: false };
  }
  const alive = processAlive(parsed);
  if (!alive) {
    return { pid: parsed, alive: false, isJinn: false };
  }
  const isJinn = pidMatchesJinn(parsed);
  return { pid: parsed, alive: true, isJinn };
}

/**
 * Read the cmdline for a single pid; true iff it matches the jinn regex.
 * Exported (#805) so `pidfile-liveness.ts`'s `jinn run` precheck can reclaim
 * a live-but-not-jinn pid instead of refusing.
 */
export function pidMatchesJinn(pid: number): boolean {
  try {
    const out = String(execSyncImpl(`ps -p ${pid} -o command=`)).trim();
    if (!out) return false;
    return JINN_CMDLINE_RE.test(out);
  } catch {
    return false;
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
    out = String(execSyncImpl('ps -eo pid=,command=')).trim();
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
