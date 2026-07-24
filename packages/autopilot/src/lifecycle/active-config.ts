export function explicitEnvironmentFlag(
  raw: string | undefined,
  label: string,
): boolean {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${label} must be true or false`);
}

/** Active-mode cleanup defaults on; opt out with `false`. */
export function activeCleanupEnabled(
  raw: string | undefined,
  label: string,
): boolean {
  if (raw === undefined || raw === '') return true;
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${label} must be true or false`);
}

export const DEFAULT_ATTEMPT_GRACE_MS = 30 * 60 * 1000;
export const DEFAULT_AUTOPILOT_DISK_FLOOR_GB = 10;

export function nonNegativeEnvironmentInteger(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is too large`);
  return value;
}

export function attemptGraceMs(
  raw: string | undefined,
  fallback = DEFAULT_ATTEMPT_GRACE_MS,
): number {
  return nonNegativeEnvironmentInteger(
    raw,
    fallback,
    'JINN_AUTOPILOT_ATTEMPT_GRACE_MS',
  );
}

export function autopilotDiskFloorBytes(
  raw: string | undefined,
  fallbackGb = DEFAULT_AUTOPILOT_DISK_FLOOR_GB,
): number {
  const gb = nonNegativeEnvironmentInteger(
    raw,
    fallbackGb,
    'JINN_AUTOPILOT_DISK_FLOOR_GB',
  );
  return gb * 1024 * 1024 * 1024;
}
