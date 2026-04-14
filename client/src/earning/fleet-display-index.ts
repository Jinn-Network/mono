/**
 * Display index for operator-facing JSON (jinn fleet / balance / rewards).
 * Persisted {@link ServiceState.index} is the HD derivation slot (typically 1-based).
 */

import type { ServiceState } from './types.js';

/** Same value as `services[].index` in GET fleet v1 and related surfaces. */
export function displayFleetServiceIndex(svc: ServiceState): number {
  return Math.max(0, svc.index - 1);
}

export function findServiceByDisplayIndex(
  services: ServiceState[],
  displayIndex: number,
): ServiceState | undefined {
  return services.find(s => displayFleetServiceIndex(s) === displayIndex);
}
