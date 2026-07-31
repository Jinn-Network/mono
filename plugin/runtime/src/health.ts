// SPDX-License-Identifier: Apache-2.0

/**
 * One doctor check. `remedy` is `null` when the state is not fixable from this machine —
 * a channel outage, for example — so the host adapter reports a known-outage state
 * instead of printing a remedy that would do nothing.
 */
export interface HealthCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly remedy: string | null;
}

export interface HealthReport {
  readonly ok: boolean;
  readonly version: string;
  readonly checks: readonly HealthCheck[];
}

/** Fold contributed checks into one report. Order is preserved; names must be unique. */
export function summarizeHealth(
  version: string,
  checks: readonly HealthCheck[],
): HealthReport {
  const seen = new Set<string>();
  for (const check of checks) {
    if (check.name.trim() === "") {
      throw new Error("a health check must have a name");
    }
    if (check.detail.trim() === "") {
      throw new Error(`health check ${check.name} must have a detail`);
    }
    if (seen.has(check.name)) {
      throw new Error(`duplicate health check name: ${check.name}`);
    }
    seen.add(check.name);
  }
  return Object.freeze({
    ok: checks.every((check) => check.ok),
    version,
    checks: Object.freeze([...checks]),
  });
}
