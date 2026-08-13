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
export const AUTOPILOT_EXECUTION_BACKEND_ENV =
  'JINN_AUTOPILOT_EXECUTION_BACKEND';
export const AUTOPILOT_MARKETPLACE_SOLVERNET_MANIFEST_CID_ENV =
  'JINN_AUTOPILOT_MARKETPLACE_SOLVERNET_MANIFEST_CID';
export type AutopilotExecutionBackend = 'local' | 'marketplace';

/**
 * One-swap R3b (issue #2494) retired `jinn tasks observe-autopilot-delivery`,
 * the marketplace backend's only way to confirm a Solution or Verdict delivery.
 * Selecting the backend is therefore refused HERE — at configuration parse,
 * before any Task is posted — rather than at the observation step, which would
 * strand escrow on a session that could never be confirmed.
 *
 * `'marketplace'` stays in the type (and its internals stay compiled and
 * tested) because what was retired is the legacy HTTP indexer, not the backend
 * design: re-backing observation on a native read is what reopens it.
 */
export const AUTOPILOT_MARKETPLACE_BACKEND_RETIRED =
  `${AUTOPILOT_EXECUTION_BACKEND_ENV}=marketplace is retired: exact delivery `
  + 'observation required the legacy HTTP indexer (one-swap R3b, issue #2494). '
  + 'Use local.';

export function autopilotExecutionBackend(
  raw: string | undefined,
): AutopilotExecutionBackend {
  if (raw === undefined || raw === '' || raw === 'local') return 'local';
  if (raw === 'marketplace') {
    throw new Error(AUTOPILOT_MARKETPLACE_BACKEND_RETIRED);
  }
  throw new Error(
    `${AUTOPILOT_EXECUTION_BACKEND_ENV} must be local or marketplace`,
  );
}

/**
 * Optional production escape hatch for zero/ambiguous live jinn-repo.v1
 * manifests. Unset preserves public auto-selection; an explicitly set value
 * must be one non-empty CID without surrounding whitespace.
 */
export function marketplaceSolverNetManifestCid(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim().length === 0) {
    throw new Error(
      `${AUTOPILOT_MARKETPLACE_SOLVERNET_MANIFEST_CID_ENV} must be non-empty when set`,
    );
  }
  if (raw !== raw.trim()) {
    throw new Error(
      `${AUTOPILOT_MARKETPLACE_SOLVERNET_MANIFEST_CID_ENV} must not contain surrounding whitespace`,
    );
  }
  return raw;
}

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
