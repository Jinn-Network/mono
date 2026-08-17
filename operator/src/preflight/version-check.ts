/**
 * Start-time npm-registry version check (issue #641).
 *
 * The daemon does not surface that a newer `@jinn-network/operator` has been
 * published, so operators run stale dashboards. This module supplies the pure,
 * unit-testable pieces main.ts composes into a fire-and-forget check.
 *
 * Nothing here throws: a registry outage, a malformed response, or an
 * unparseable version degrades to `null` / `false`. The check is advisory.
 */

import semver from 'semver';
import { buildInfo } from '../build-info.js';

/** npm `latest` dist-tag endpoint for the published operator package. */
const REGISTRY_LATEST_URL =
  'https://registry.npmjs.org/@jinn-network/operator/latest';

/** Default abort timeout for the registry fetch (ms). */
const DEFAULT_TIMEOUT_MS = 2500;

/** Poll cadence for the recurring background refresh (6 hours). */
export const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The version this process is running (from the build-time package version). */
export function getRunningVersion(): string {
  return buildInfo.implVersion;
}

/**
 * Whether the start-time version check is enabled. Default-on; opt out via
 * `JINN_VERSION_CHECK` set to `0` / `false` / `no` / empty (case-insensitive,
 * whitespace-trimmed). Mirrors the inverted-boolean pattern used for
 * `JINN_RUN_LEGACY_MIGRATIONS` in config.ts.
 */
export function isVersionCheckEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const raw = env['JINN_VERSION_CHECK'];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === '');
}

export interface FetchLatestVersionOptions {
  /** Injectable fetch for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort timeout in ms; defaults to 2500. */
  timeoutMs?: number;
}

/**
 * Best-effort read of the latest published version from the npm registry.
 * Returns the version string, or `null` on any failure (non-200, malformed
 * body, network error, abort/timeout). Never throws.
 */
export async function fetchLatestVersion(
  opts: FetchLatestVersionOptions = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(REGISTRY_LATEST_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const version = (body as { version?: unknown })?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when `latest` is strictly newer than `running`. The dev placeholder
 * (`0.0.0-dev`) sorts below any real release, so a dev build reports an update
 * as available. Unparseable inputs yield `false` (never throws).
 */
export function isNewerVersion(running: string, latest: string): boolean {
  const r = semver.coerce(running);
  const l = semver.coerce(latest);
  if (!r || !l) return false;
  return semver.gt(l, r);
}

/** One-line "update available" log message. */
export function formatUpdateLogLine(latest: string): string {
  return `[version] v${latest} of @jinn-network/operator is available — run \`jinn update\` and restart to pick it up`;
}
