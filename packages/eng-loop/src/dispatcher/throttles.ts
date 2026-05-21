/** True while another session may be started without exceeding the cap. */
export function concurrencyOk(inFlightCount: number, cap: number): boolean {
  return inFlightCount < cap;
}

/**
 * True while the open-PR queue is within the human's reach. When the count
 * of ready PRs already waiting for batch-merge exceeds the threshold, the
 * dispatcher stops pulling new issues — it self-throttles to the human's
 * pace and cannot outrun them (spec §2, the dominant-failure-mode defence).
 */
export function backpressureOk(openReadyPrCount: number, threshold: number): boolean {
  return openReadyPrCount <= threshold;
}
