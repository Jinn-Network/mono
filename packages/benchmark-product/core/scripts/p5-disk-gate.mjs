import { statfsSync } from "node:fs";

export const P5_MINIMUM_FREE_BYTES = 40n * 1024n * 1024n * 1024n;

export function evaluateP5DiskGate(availableBytes, label) {
  if (typeof availableBytes !== "bigint" || availableBytes < 0n) {
    throw new TypeError("availableBytes must be a non-negative bigint");
  }
  const snapshot = {
    availableBytes: availableBytes.toString(),
    availableGiB: (Number(availableBytes) / (1024 ** 3)).toFixed(2),
    minimumGiB: "40.00",
  };
  if (availableBytes < P5_MINIMUM_FREE_BYTES) {
    throw new Error(
      `P5 disk gate refused ${label}: ${snapshot.availableGiB} GiB free; `
        + "at least 40.00 GiB is required. No caches or user data were deleted.",
    );
  }
  return snapshot;
}

/**
 * P5's fail-closed host-space gate. Call immediately before every Docker/image phase, not once at
 * process startup: long-running grades can move the filesystem back below the threshold.
 */
export function assertP5DiskGate(label, path = "/") {
  const stats = statfsSync(path, { bigint: true });
  const availableBytes = stats.bavail * stats.bsize;
  return evaluateP5DiskGate(availableBytes, label);
}
