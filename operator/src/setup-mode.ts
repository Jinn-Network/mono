/**
 * Setup-mode controller for the daemon.
 *
 * The daemon process can be in two states:
 * - 'setup'   — Hono API + operator MCP are up, but the daemon loops
 *               (creator, engine-watcher, delivery-watcher, ...) are gated.
 *               Used when the keystore is missing or bootstrap is incomplete.
 * - 'running' — All loops are active.
 *
 * `computeDaemonMode` is a pure function from inputs to mode.
 * `createSetupModeController` wraps it with a small state machine that supports
 * `refresh()` on input changes and `waitUntilRunning()` for callers that need
 * to gate their start-up on the running transition.
 */

export type DaemonMode = 'setup' | 'running';

export interface DaemonModeInputs {
  /** True when the master keystore exists on disk. */
  keystoreExists: boolean;
  /** True when every service in the fleet is operational (`complete` or `safe_binding_pending`). */
  allComplete: boolean;
}

export function computeDaemonMode(inputs: DaemonModeInputs): DaemonMode {
  if (!inputs.keystoreExists) return 'setup';
  if (!inputs.allComplete) return 'setup';
  return 'running';
}

export interface SetupModeController {
  /** Current mode. */
  mode(): DaemonMode;
  /**
   * Resolves once the mode is or becomes 'running'. If already running,
   * resolves on next microtask.
   */
  waitUntilRunning(): Promise<void>;
  /** Re-evaluate the mode based on the input thunks. */
  refresh(inputs: DaemonModeInputs): void;
}

export function createSetupModeController(initial: DaemonModeInputs): SetupModeController {
  let current: DaemonMode = computeDaemonMode(initial);
  const waiters: Array<() => void> = [];

  return {
    mode: () => current,

    waitUntilRunning: () => {
      if (current === 'running') return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },

    refresh: (inputs) => {
      const next = computeDaemonMode(inputs);
      if (next === current) return;
      current = next;
      if (next === 'running') {
        while (waiters.length > 0) {
          const w = waiters.shift();
          try { w?.(); } catch { /* swallow waiter errors */ }
        }
      }
    },
  };
}
