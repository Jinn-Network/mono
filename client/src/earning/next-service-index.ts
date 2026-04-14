/** Next HD service slot after existing rows (avoids reusing an index after a middle-row delete). */
export function nextFleetServiceIndex(services: Array<{ index: number }>): number {
  if (services.length === 0) return 1;
  return Math.max(...services.map(s => s.index)) + 1;
}
