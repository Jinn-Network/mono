/** Environment-variable parsing shared by the corpus read paths. */

/**
 * `minimum` is 0 where the bound reads `0` as "disabled" (a whole-operation
 * timeout, or a redirect cap of zero meaning "follow none"), and 1 for a byte
 * cap, where zero would not disable anything — it would reject every response
 * as `too_large`. A foot-gun that silently stops all acquisition is worse than
 * ignoring the value, so an out-of-range setting falls back to the default.
 */
export function envInteger(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}
