/**
 * Committed HF-row fixture for the AC1 amd64 gold proof (issue #1683).
 *
 * The gold-proof gate exists to prove GRADING SEMANTICS, not HuggingFace
 * uptime — a multi-day datasets-server 503 outage must not red-gate every
 * client-touching PR. So the known instance's pool task + full HF row are
 * committed here as `known-instance-hf.json` and the gold-proof script loads
 * them from disk by default (zero HF network calls).
 *
 * Refresh the fixture while HF is healthy via {@link RECORD_FIXTURE_COMMAND};
 * `AC1_LIVE_HF=1` runs the proof against a live HF fetch instead.
 *
 * The loader fails loud on a missing/malformed fixture — it never silently
 * falls back to a live fetch.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HfRow } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import type { PoolTask } from '../../../../src/solver-types/_swe-rebench-v2-pool.js';
import { KNOWN_INSTANCE_ID } from './known-instance.js';

export const KNOWN_INSTANCE_HF_FIXTURE_SCHEMA = 'ac1-known-instance-hf.v1' as const;

export const KNOWN_INSTANCE_HF_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'known-instance-hf.json',
);

/** The command that (re)writes the fixture from a live HF fetch. */
export const RECORD_FIXTURE_COMMAND =
  'cd operator && yarn task-creator:amd64-gold-proof --record-fixture';

export interface KnownInstanceHfFixture {
  schemaVersion: typeof KNOWN_INSTANCE_HF_FIXTURE_SCHEMA;
  /** ISO timestamp of when the fixture data was captured. */
  recordedAt: string;
  /** Free-text provenance of the recorded data. */
  source: string;
  /** Full pool row for the known instance (what `loadSweRebenchV2Pool` returns). */
  poolTask: PoolTask;
  /** Full HF datasets-server row (what `HttpHfFetcher.fetchTaskRow` returns). */
  hfRow: HfRow;
}

function fixtureError(detail: string, path: string): Error {
  return new Error(
    `AC1 known-instance HF fixture ${detail} (${path}). ` +
      `Re-record it while HF is healthy: ${RECORD_FIXTURE_COMMAND}`,
  );
}

function requireNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  path: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw fixtureError(`has missing/empty ${where}.${key}`, path);
  }
  return v;
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  path: string,
): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw fixtureError(`has non-string-array ${where}.${key}`, path);
  }
  return v as string[];
}

/**
 * Load and validate the committed fixture. Throws (naming the record
 * command) when the file is missing, unparsable, from a different schema
 * version, recorded for a different instance than the current
 * {@link KNOWN_INSTANCE_ID}, or missing a grading-load-bearing field.
 */
export function loadKnownInstanceHfFixture(
  path: string = KNOWN_INSTANCE_HF_FIXTURE_PATH,
): KnownInstanceHfFixture {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw fixtureError('is missing', path);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fixtureError('is not valid JSON', path);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw fixtureError('is not a JSON object', path);
  }
  const f = parsed as Record<string, unknown>;

  if (f['schemaVersion'] !== KNOWN_INSTANCE_HF_FIXTURE_SCHEMA) {
    throw fixtureError(
      `has schemaVersion ${JSON.stringify(f['schemaVersion'])}, expected ${KNOWN_INSTANCE_HF_FIXTURE_SCHEMA}`,
      path,
    );
  }
  requireNonEmptyString(f, 'recordedAt', 'fixture', path);
  if (!f['poolTask'] || typeof f['poolTask'] !== 'object') {
    throw fixtureError('has missing poolTask', path);
  }
  if (!f['hfRow'] || typeof f['hfRow'] !== 'object') {
    throw fixtureError('has missing hfRow', path);
  }

  const poolTask = f['poolTask'] as Record<string, unknown>;
  requireNonEmptyString(poolTask, 'hf_dataset', 'poolTask', path);
  requireNonEmptyString(poolTask, 'hf_split', 'poolTask', path);
  // The gold patch is what the admission run grades — without it the proof is vacuous.
  requireNonEmptyString(poolTask, 'patch', 'poolTask', path);

  const hfRow = f['hfRow'] as Record<string, unknown>;
  requireNonEmptyString(hfRow, 'repo', 'hfRow', path);
  requireNonEmptyString(hfRow, 'image_name', 'hfRow', path);
  requireNonEmptyString(hfRow, 'test_patch', 'hfRow', path);
  const failToPass = requireStringArray(hfRow, 'FAIL_TO_PASS', 'hfRow', path);
  if (failToPass.length === 0) {
    throw fixtureError('has empty hfRow.FAIL_TO_PASS', path);
  }
  requireStringArray(hfRow, 'PASS_TO_PASS', 'hfRow', path);
  const installConfig = hfRow['install_config'];
  if (!installConfig || typeof installConfig !== 'object') {
    throw fixtureError('has missing hfRow.install_config', path);
  }
  const ic = installConfig as Record<string, unknown>;
  if (typeof ic['log_parser'] !== 'string') {
    throw fixtureError('has missing hfRow.install_config.log_parser', path);
  }
  const testCmd = ic['test_cmd'];
  if (typeof testCmd !== 'string' && !Array.isArray(testCmd)) {
    throw fixtureError('has missing hfRow.install_config.test_cmd', path);
  }

  // Guard against a stale fixture after the known instance rotates: both
  // records must be for the CURRENT KNOWN_INSTANCE_ID.
  for (const [where, obj] of [['poolTask', poolTask], ['hfRow', hfRow]] as const) {
    const id = requireNonEmptyString(obj, 'instance_id', where, path);
    if (id !== KNOWN_INSTANCE_ID) {
      throw fixtureError(
        `was recorded for ${where}.instance_id=${id}, but the current known instance is ${KNOWN_INSTANCE_ID}`,
        path,
      );
    }
  }

  return parsed as KnownInstanceHfFixture;
}
