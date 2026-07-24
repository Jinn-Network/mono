import { createHash } from 'node:crypto';
import type { CheckSummary } from './snapshot.js';

export const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

export type CiClassification =
  | { readonly state: 'green' }
  | { readonly state: 'missing' }
  | {
      readonly state: 'pending';
      readonly pending: readonly CheckSummary[];
    }
  | {
      readonly state: 'failed';
      readonly failed: readonly CheckSummary[];
      readonly rerunnableRunIds: readonly number[];
    };

export function classifyCiChecks(checks: readonly CheckSummary[]): CiClassification {
  if (checks.length === 0) return { state: 'missing' };
  const pending = checks.filter((check) => (
    check.status !== 'COMPLETED' || check.conclusion === null
  ));
  if (pending.length > 0) {
    return { state: 'pending', pending };
  }
  const failed = checks.filter((check) => (
    !SUCCESSFUL_CHECK_CONCLUSIONS.has(check.conclusion ?? '')
  ));
  if (failed.length > 0) {
    const rerunnableRunIds = [...new Set(
      failed
        .filter((check) => check.source === 'check-run' && check.runId !== undefined)
        .map((check) => check.runId as number),
    )];
    return { state: 'failed', failed, rerunnableRunIds };
  }
  return { state: 'green' };
}

export function isCiGreen(checks: readonly CheckSummary[]): boolean {
  return classifyCiChecks(checks).state === 'green';
}

export function ciCheckFingerprint(checks: readonly CheckSummary[]): string {
  const normalized = [...checks]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((check) => [
      check.source ?? 'unknown',
      check.name,
      check.status,
      check.conclusion ?? '',
      check.runId ?? '',
      check.runAttempt ?? '',
    ].join(':'));
  return createHash('sha256').update(normalized.join('|')).digest('hex').slice(0, 16);
}
