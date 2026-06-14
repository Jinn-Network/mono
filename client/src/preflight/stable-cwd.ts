import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep as pathSep } from 'node:path';

/**
 * Issue #909 — `jinn run` inherits the launch shell's CWD. When the daemon is
 * launched from an ephemeral directory that is later deleted, the process's CWD
 * becomes a dangling inode; child processes (e.g. the `claude` CLI harness
 * probe) call `getcwd()` → ENOENT → exit with "The current working directory
 * was deleted...". The fix: on boot, before spawning any child, chdir to a
 * guaranteed-stable directory under $HOME.
 */

/**
 * Sentinel used when `process.cwd()` itself throws (the launch dir was deleted).
 * It is a relative non-path: `existsSync` reports it missing and it fails the
 * under-$HOME check, so the resolver is forced to chdir to a stable target.
 */
const DELETED_CWD_SENTINEL = '<deleted-cwd>';

export interface ResolveStableCwdInput {
  currentCwd: string;
  earningDir: string;
  homeDir: string;
  exists: (p: string) => boolean;
  sep?: string;
}

export interface ResolveStableCwdResult {
  chosenCwd: string;
  needsChdir: boolean;
  logLine: string;
}

/**
 * Pure resolver — no fs/os/process access. All inputs are injected so this can
 * be unit-tested deterministically.
 */
export function resolveStableCwd(input: ResolveStableCwdInput): ResolveStableCwdResult {
  const { currentCwd, earningDir, homeDir, exists } = input;
  const sep = input.sep ?? pathSep;

  const isUnderHome = currentCwd === homeDir || currentCwd.startsWith(homeDir + sep);
  const currentExists = exists(currentCwd);

  if (currentExists && isUnderHome) {
    return {
      chosenCwd: currentCwd,
      needsChdir: false,
      logLine: `[main] cwd ${currentCwd} is stable; no chdir needed`,
    };
  }

  // Prefer the earning dir, then ~/.jinn-client, then $HOME. The terminal
  // homeDir is the last-resort floor and is chosen even if its exists-probe
  // is false — we never return "nothing".
  const candidates = [earningDir, joinPath(homeDir, '.jinn-client', sep), homeDir];
  let chosenCwd = homeDir;
  for (const candidate of candidates) {
    if (candidate === homeDir || exists(candidate)) {
      chosenCwd = candidate;
      break;
    }
  }

  return {
    chosenCwd,
    needsChdir: chosenCwd !== currentCwd,
    logLine: `[main] chdir to ${chosenCwd} (was ${currentCwd})`,
  };
}

function joinPath(base: string, child: string, sep: string): string {
  return base.endsWith(sep) ? base + child : base + sep + child;
}

/**
 * Real-world wrapper: gathers `process.cwd()`, `os.homedir()`, and `existsSync`,
 * delegates the decision to `resolveStableCwd`, then performs the chdir.
 *
 * `earningDir` comes in as a param to keep this decoupled from the config
 * module. Never crashes boot: a `process.cwd()` read can itself throw ENOENT
 * (when the launch dir was deleted), and `process.chdir` can fail — both are
 * caught and logged.
 */
export function ensureStableCwd(opts: { earningDir: string }): ResolveStableCwdResult {
  // process.cwd() throws ENOENT when the current dir's inode is gone. Treat a
  // throw as "cwd is gone": pass a sentinel that the resolver's exists-probe
  // reports as missing, forcing a chdir to a stable target.
  let currentCwd: string;
  try {
    currentCwd = process.cwd();
  } catch {
    currentCwd = DELETED_CWD_SENTINEL;
  }

  const result = resolveStableCwd({
    currentCwd,
    earningDir: opts.earningDir,
    homeDir: homedir(),
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
  });

  if (result.needsChdir) {
    try {
      process.chdir(result.chosenCwd);
    } catch (err) {
      console.warn(
        `[main] failed to chdir to ${result.chosenCwd}: ${err instanceof Error ? err.message : String(err)} — continuing`,
      );
    }
  }

  console.log(result.logLine);
  return result;
}
