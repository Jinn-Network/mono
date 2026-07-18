export const AUTOPILOT_RUNTIME_ENV = 'JINN_AUTOPILOT_RUNTIME';

export type AutopilotRuntime = 'claude' | 'hermes';

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
  if (value === 'claude' || value === 'hermes') return value;
  throw new Error(
    `[autopilot] Invalid ${AUTOPILOT_RUNTIME_ENV}=${JSON.stringify(value)}; ` +
      'expected claude or hermes.',
  );
}
