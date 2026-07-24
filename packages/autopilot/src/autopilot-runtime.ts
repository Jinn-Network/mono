export const AUTOPILOT_RUNTIME_ENV = 'JINN_AUTOPILOT_RUNTIME';

/**
 * Process-wide coordinator runtimes (successor to the retired per-issue
 * `Implementer` routing from #887). Single canonical list — parsers and CLI
 * validation derive from here, never re-list literals.
 */
export const AUTOPILOT_RUNTIMES = ['claude', 'hermes', 'cursor'] as const;
export type AutopilotRuntime = (typeof AUTOPILOT_RUNTIMES)[number];
export const AUTOPILOT_RUNTIME_SET: ReadonlySet<AutopilotRuntime> = new Set(
  AUTOPILOT_RUNTIMES,
);

/**
 * Resolve the single process-wide coordinator runtime.
 *
 * An unset value preserves the historical Claude default. Every present value
 * is validated exactly so typos cannot silently select a different runtime.
 */
export function parseAutopilotRuntime(
  value: string | undefined,
): AutopilotRuntime {
  if (value === undefined) return 'claude';
  if (AUTOPILOT_RUNTIME_SET.has(value as AutopilotRuntime)) {
    return value as AutopilotRuntime;
  }
  throw new Error(
    `[autopilot] Invalid ${AUTOPILOT_RUNTIME_ENV}=${JSON.stringify(value)}; ` +
      `expected ${AUTOPILOT_RUNTIMES.join(', ')}.`,
  );
}
