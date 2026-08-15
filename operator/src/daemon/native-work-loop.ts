/**
 * The native operator hosts' background work loop (#2535).
 *
 * Replaces the `setInterval` whose `.catch` did this:
 *
 * ```ts
 * void tick().catch((cause) => { workFailure = cause; stopped = true; clearInterval(timer); });
 * ```
 *
 * Two independent defects lived in those three lines.
 *
 * 1. **The cause was never logged.** It went into `workFailure`, which only `health()` reads, and
 *    nothing was calling `health()`. On the live two-operator gate, operator B's last work tick
 *    was 01:29:06; thirty-four minutes later the process was still up, the checkpoint and eviction
 *    loops were still logging normally, and the only evidence that the solver had stopped solving
 *    was a gap between timestamps. Diagnosing that cost a round.
 *
 * 2. **One rejected tick was permanently terminal.** A single transient rejection — an RPC blip, a
 *    momentarily unreachable source — killed the loop for the lifetime of the process. B recovered
 *    the instant it was restarted, claiming `claim-finalized` immediately on reboot, which is what
 *    a transient failure looks like. Any real deployment would run a solver that had silently
 *    stopped earning until a human noticed.
 *
 * What this does instead:
 *
 * - **Always logs the cause**, on every failed tick, naming the loop and the consecutive-failure
 *   count. A bare tagged `console.warn`/`console.error`, matching `native-discovery.ts` — these
 *   hosts take no logger, and adding an import to them would trip the native product import
 *   boundary guard.
 * - **Recovers on the next tick**, with exponential backoff from the base interval up to a cap, so
 *   a flapping dependency is retried rather than fatal, and a persistently broken one is not
 *   hammered.
 * - **Reports itself unhealthy only when it genuinely cannot continue** — after
 *   `maxConsecutiveFailures` ticks fail in a row with no success in between. That latches
 *   `failure()`, which `createNativeOperatorHost`'s `health()` already turns into a throw. Green
 *   health over a dead loop was the worst of the three options; this leaves it unreachable, because
 *   the loop either keeps running or reports itself broken.
 *
 * `GET /health` deliberately still answers `{ ok: true }`: it is specified as pure process
 * liveness (spec/2026-08-04-headless-operator-rederivation-design.md §6.1) and a 503 there would
 * restart-loop daemons that are correctly waiting. The native host's health contract is
 * `host.health()`, and that is what goes hard-unhealthy here.
 */

export interface NativeWorkLoop {
  /** Runs the first tick inline — a startup failure still rejects — then schedules the rest. */
  start(): Promise<void>;
  stop(): void;
  /** Set only once the loop has given up. `undefined` while it is running or retrying. */
  failure(): unknown;
  /** Consecutive failed ticks since the last success. Zero when healthy. */
  consecutiveFailures(): number;
}

export interface NativeWorkLoopOptions {
  /** Log tag, e.g. `native-solver`. */
  readonly label: string;
  tick(): Promise<void>;
  /** Base interval between successful ticks. Defaults to 5s, the previous `setInterval` period. */
  readonly intervalMs?: number;
  /** Consecutive failures tolerated before the loop latches terminal. Defaults to 10. */
  readonly maxConsecutiveFailures?: number;
  /** Ceiling for the exponential backoff. Defaults to 5 minutes. */
  readonly maxBackoffMs?: number;
  readonly warn?: (message: string) => void;
  readonly error?: (message: string) => void;
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.stack ?? cause.message : String(cause));

export function createNativeWorkLoop(options: NativeWorkLoopOptions): NativeWorkLoop {
  const intervalMs = options.intervalMs ?? 5_000;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 10;
  const maxBackoffMs = options.maxBackoffMs ?? 300_000;
  const warn = options.warn ?? ((message: string) => { console.warn(message); });
  const error = options.error ?? ((message: string) => { console.error(message); });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failure: unknown;
  let consecutiveFailures = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void cycle(); }, delayMs);
    timer.unref?.();
  };

  const backoffMs = (): number =>
    Math.min(intervalMs * 2 ** (consecutiveFailures - 1), maxBackoffMs);

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    try {
      await options.tick();
      consecutiveFailures = 0;
      schedule(intervalMs);
    } catch (cause) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        // Terminal. Latch it so `health()` throws, and say so at error level — this is the line
        // whose absence cost a live round.
        failure = cause;
        stopped = true;
        error(
          `[${options.label}] work loop STOPPED after ${consecutiveFailures} consecutive failed `
          + `ticks; health will now report unhealthy. Last cause: ${describe(cause)}`,
        );
        return;
      }
      const delayMs = backoffMs();
      warn(
        `[${options.label}] work tick failed (${consecutiveFailures} of `
        + `${maxConsecutiveFailures} consecutive) — retrying in ${delayMs}ms: ${describe(cause)}`,
      );
      schedule(delayMs);
    }
  };

  return {
    async start() {
      if (stopped) throw new Error(`[${options.label}] work loop is stopped`);
      // The first tick runs inline so a startup failure still rejects `start()`, exactly as the
      // previous `await tick()` did. Only ticks after startup are retried.
      await options.tick();
      consecutiveFailures = 0;
      schedule(intervalMs);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    failure: () => failure,
    consecutiveFailures: () => consecutiveFailures,
  };
}
