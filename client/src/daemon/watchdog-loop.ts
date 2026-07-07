/**
 * Loop watchdog supervisor (#1043, follow-up to the #1038 4.5h RPC wedge).
 *
 * A synchronous, network-free loop. On each tick it reads every registered
 * loop's heartbeat (loop-heartbeat.ts → getLoopTick) and compares its age
 * against a per-loop threshold. When a loop is stale it ALWAYS loud-logs and
 * emits a structured `loop_watchdog_stale` event; the process-exit recovery is
 * separately gated behind `autoRestart` (default OFF — the locked Option A
 * decision). v1 therefore always *detects + surfaces*; the non-zero exit is
 * opt-in.
 *
 * IDEMPOTENCY (AC#3, the anchor for "designed, not assumed"): the only
 * recovery action is a non-zero `process.exit`. There is NO new mid-flight
 * re-execution path inside any loop. Recovery flows entirely through the
 * EXISTING idempotent boot path:
 *
 *   process.exit(WATCHDOG_EXIT_CODE)
 *     → Railway restartPolicyType="ON_FAILURE", maxRetries=10
 *       (deploy/railway-*-operator/railway.toml)
 *     → fresh process boots, recoverInFlight() re-drives in-flight tasks
 *       (TaskEngine.recoverInFlight) and the stale-pidfile path clears a dead
 *       lock (src/preflight/pidfile-liveness.ts) — both already idempotent.
 *
 * So restarting a wedged daemon cannot double-claim, double-deliver, or
 * double-pay: it re-enters the same boot reconciliation a crash would.
 */
import type { Store } from '../store/store.js';
import { getLoopTick, type LoopName } from './loop-heartbeat.js';
import { emitStructured } from '../events/emitter.js';

/**
 * Non-zero exit code the watchdog uses for its auto-restart. Distinct from
 * main.ts's graceful `process.exit(0)` so Railway's ON_FAILURE policy treats a
 * watchdog restart as a failure (and a clean operator-requested stop as not).
 */
export const WATCHDOG_EXIT_CODE = 13;

/** Default recovery: loud-log then non-zero exit (Railway restarts us). */
function defaultOnStale(name: string): void {
  console.error(
    `[watchdog] auto-restarting via non-zero exit (loop=${name}, code=${WATCHDOG_EXIT_CODE})`,
  );
  process.exit(WATCHDOG_EXIT_CODE);
}

export interface WatchdogLoopRegistration {
  /** Loop heartbeat name. */
  name: LoopName;
  /** The loop's nominal iteration interval (ms). */
  intervalMs: number;
  /**
   * Optional floor (ms) for the staleness threshold. The for-await adapter
   * loops set this generously (~5 min) because a single RPC wedge can stall a
   * poll far longer than `stalenessFactor * pollIntervalMs`.
   */
  floorMs?: number;
}

export interface WatchdogLoopConfig {
  store: Store;
  loops: WatchdogLoopRegistration[];
  /** Stale when age > stalenessFactor * intervalMs (floored by floorMs). */
  stalenessFactor?: number;
  /** How often the watchdog itself ticks (ms). */
  checkIntervalMs?: number;
  /** When true, a stale loop triggers onStale (the process-exit recovery). */
  autoRestart?: boolean;
  /**
   * Recovery action invoked once per stale episode when autoRestart is on.
   * Optional — defaults to the production process-exit handler. Tests inject a
   * spy. Kept off DaemonConfig so the config surface stays free of functions.
   */
  onStale?: (name: string) => void;
  /** Gate: the watchdog only checks while this returns true (running, not draining). */
  isActive: () => boolean;
  /** Clock seam for tests. Defaults to Date.now. */
  now?: () => number;
}

export class WatchdogLoop {
  private stopped = false;
  private stopResolve?: () => void;
  private readonly stopPromise: Promise<void>;
  private readonly stalenessFactor: number;
  private readonly checkIntervalMs: number;
  private readonly autoRestart: boolean;
  private readonly onStale: (name: string) => void;
  private readonly now: () => number;
  /** Loops currently in a reported-stale episode (fire-once gate). */
  private readonly reportedStale = new Set<string>();

  constructor(private readonly config: WatchdogLoopConfig) {
    this.stalenessFactor = config.stalenessFactor ?? 6;
    this.checkIntervalMs = config.checkIntervalMs ?? 30_000;
    this.autoRestart = config.autoRestart ?? false;
    this.onStale = config.onStale ?? defaultOnStale;
    this.now = config.now ?? (() => Date.now());
    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      if (this.config.isActive()) {
        this.check();
      }
      await Promise.race([
        new Promise((r) => setTimeout(r, this.checkIntervalMs)),
        this.stopPromise,
      ]);
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }

  /** One supervision pass. Synchronous + network-free. */
  check(): void {
    const now = this.now();
    for (const reg of this.config.loops) {
      const last = getLoopTick(this.config.store, reg.name);
      if (last === null) continue; // never ticked — nothing to judge yet
      const threshold = Math.max(this.stalenessFactor * reg.intervalMs, reg.floorMs ?? 0);
      const ageMs = now - last;

      if (ageMs > threshold) {
        // Fire-once per episode: skip if already reported and not yet recovered.
        if (this.reportedStale.has(reg.name)) continue;
        this.reportedStale.add(reg.name);

        const message =
          `[watchdog] loop '${reg.name}' is stale: last tick ${ageMs}ms ago ` +
          `(threshold ${threshold}ms)`;
        console.error(message);
        emitStructured({
          kind: 'error',
          message,
          errorCode: 'loop_watchdog_stale',
          details: {
            loopName: reg.name,
            lastTickAt: last,
            ageMs,
            thresholdMs: threshold,
          },
        });

        if (this.autoRestart) {
          this.onStale(reg.name);
        }
      } else {
        // Heartbeat advanced back under threshold → re-arm for next episode.
        this.reportedStale.delete(reg.name);
      }
    }
  }
}
