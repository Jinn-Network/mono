/**
 * In-process respawn helper for operator-triggered daemon restarts.
 *
 * Issue #289 added respawn-instead-of-exit so the operator panel survives a
 * restart click. Issue #561 fixed the follow-on bug: the original respawn
 * spawned the child *before* the parent had released its server sockets, so
 * the child raced into `.listen(7332)` while the parent still held the port
 * and died with EADDRINUSE / exitCode 11. The fix is `preSpawnCleanup` — an
 * async hook the caller uses to close API + OTLP receivers before the child
 * is spawned. With cleanup in place the port is free synchronously and the
 * child binds on first try; without it (older callers, tests) the helper
 * behaves as before.
 *
 * Every restart-required config change funnels through the same handler:
 *
 *   - POST /v1/setup/network              — RPC URL change
 *   - POST /v1/setup/change-password      — keystore password rotation
 *   - POST /v1/setup/solvernets/:name     — SolverNet enable/disable
 *
 * Headless gate: `JINN_NO_UI=1` (already the established headless flag in
 * main.ts) skips the respawn — operators running `jinn run --no-ui` from a
 * supervisor / systemd unit / docker entrypoint want the supervisor to
 * decide whether to restart, not the daemon.
 *
 * The helper is split out from main.ts so it's unit-testable without
 * touching the entry-point bootstrap path.
 */

import { spawn, type SpawnOptions } from 'node:child_process';

/**
 * Options for `requestDaemonRestart`. All optional in production; the helper
 * defaults to `process` / `node:child_process`. Tests inject doubles.
 */
export interface RequestDaemonRestartOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.argv` (`[node, scriptPath, ...args]`). */
  argv?: readonly string[];
  /** Defaults to `process.execPath` (the node binary). */
  execPath?: string;
  /**
   * Defaults to `node:child_process.spawn`. Injected for tests so we can
   * assert what was spawned without actually forking node.
   */
  spawnFn?: typeof spawn;
  /** Defaults to `(code) => process.exit(code)`. Injected for tests. */
  exitFn?: (code: number) => void;
  /** Defaults to `console.log`. Injected for tests to capture output. */
  log?: (message: string) => void;
  /**
   * Delay (ms) between spawning the child and exiting the parent. Gives the
   * child a moment to bind the API port before the parent vacates it.
   * Defaults to 250ms per the issue body. Tests can pass 0 for synchrony.
   */
  exitDelayMs?: number;
  /**
   * Bypass the headless gate. The operator-dashboard Restart button passes
   * this — when the operator clicks Restart, they explicitly want the
   * daemon to come back, even under a supervisor. Supervisor-driven
   * restart flows (MCP tools, signals) leave this `false` so the
   * supervisor stays in charge.
   */
  forceRespawn?: boolean;
  /**
   * Optional async hook run *before* the replacement child is spawned. The
   * caller uses this to close listening sockets the child will need to
   * bind — API server (7332) and OTLP receiver (4317/4318) — so the child
   * doesn't lose an EADDRINUSE race with the parent. Errors are caught and
   * logged; the respawn still proceeds because leaving the operator
   * stranded is worse than a noisy close. Skipped in headless mode.
   */
  preSpawnCleanup?: () => Promise<void>;
}

/**
 * Pure predicate: true when the current env is headless and respawn should
 * be skipped. Exposed so callers and tests can share the same check.
 */
export function isHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['JINN_NO_UI'] === '1';
}

/**
 * Handle an operator-triggered restart request.
 *
 * - In **interactive** mode (default), spawn a detached child that re-runs
 *   the current node invocation, then exit after a short delay so the child
 *   can bind the API port.
 * - In **headless** mode (`JINN_NO_UI=1`), exit without respawning. The
 *   supervisor is responsible for relaunching the daemon if it wants to.
 *
 * Returns the action taken (for tests). Production callers ignore the return.
 */
export async function requestDaemonRestart(
  opts: RequestDaemonRestartOptions = {},
): Promise<'respawned' | 'headless-exit'> {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv;
  const execPath = opts.execPath ?? process.execPath;
  const spawnFn = opts.spawnFn ?? spawn;
  const exitFn = opts.exitFn ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((message: string) => console.log(message));
  const exitDelayMs = opts.exitDelayMs ?? 250;

  if (isHeadless(env) && !opts.forceRespawn) {
    log(
      '[main] Restart requested via operator MCP, but JINN_NO_UI=1 — exiting without respawn (let the supervisor decide).',
    );
    exitFn(0);
    return 'headless-exit';
  }

  log('[main] Restart requested via operator MCP. Spawning replacement and exiting...');

  // jinn-mono #561: release server sockets BEFORE the child spawns. Without
  // this, the child loses an EADDRINUSE race on 7332 (and OTLP 4317/4318)
  // and dies with exitCode 11 before it can take over.
  if (opts.preSpawnCleanup) {
    try {
      await opts.preSpawnCleanup();
    } catch (err) {
      log(
        `[main] preSpawnCleanup error (proceeding with respawn anyway): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // argv[0] is the node binary; argv[1..] are the script + flags. The child
  // re-runs the same script with the same flags, under the same node binary.
  const childArgs = argv.slice(1);
  const spawnOptions: SpawnOptions = {
    detached: true,
    stdio: 'inherit',
    env,
  };
  const child = spawnFn(execPath, childArgs, spawnOptions);
  // Detach so the parent can exit without taking the child with it.
  child.unref();

  // With preSpawnCleanup the port is already free; the small delay is kept
  // as a paranoid belt-and-suspenders against any kernel-level lingering on
  // SO_LINGER-disabled sockets. Tests pass 0.
  if (exitDelayMs <= 0) {
    exitFn(0);
  } else {
    setTimeout(() => exitFn(0), exitDelayMs);
  }

  return 'respawned';
}
