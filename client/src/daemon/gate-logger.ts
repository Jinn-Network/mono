/**
 * Shared logger contract for pre-claim gates (readiness, spend-cap, ...).
 *
 * Gates log only on state-change transitions, so they need just `warn`/`info`.
 */
export interface GateLogger {
  warn(msg: string): void;
  info(msg: string): void;
}
