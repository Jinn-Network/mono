import { createHash } from 'node:crypto';
import { gitOid, type GitOid, type PublicationOutcome } from './types.js';
import type { CheckSummary } from './snapshot.js';
import {
  ciCheckFingerprint,
  classifyCiChecks,
  type CiClassification,
} from './ci-classifier.js';

export const CI_RERUN_MARKER_PREFIX = '<!-- jinn-autopilot:ci-rerun:v1';

export function ciRerunRef(prNumber: number, head: GitOid): string {
  return `refs/jinn-autopilot/ci-reruns/v1/pr-${prNumber}/${head}`;
}

export interface CiRerunRecord {
  readonly prNumber: number;
  readonly head: GitOid;
  readonly fingerprint: string;
  readonly runIds: readonly number[];
  readonly requestedAt: string;
}

export function encodeCiRerunRecord(record: CiRerunRecord): string {
  return [
    'Autopilot CI rerun record',
    '',
    `${CI_RERUN_MARKER_PREFIX} pr=${record.prNumber} head=${record.head} fingerprint=${record.fingerprint} -->`,
    `run-ids=${record.runIds.join(',')}`,
    `requested-at=${record.requestedAt}`,
  ].join('\n');
}

export function decodeCiRerunRecord(message: string): CiRerunRecord | null {
  const marker = message.match(
    /<!--\s*jinn-autopilot:ci-rerun:v1\s+pr=(\d+)\s+head=([0-9a-f]{40})\s+fingerprint=([0-9a-f]+)\s*-->/,
  );
  if (marker === null) return null;
  const runIds = message.match(/^run-ids=(.*)$/m)?.[1]
    ?.split(',')
    .filter((value) => value.length > 0)
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0) ?? [];
  const requestedAt = message.match(/^requested-at=(.+)$/m)?.[1];
  if (requestedAt === undefined) return null;
  return {
    prNumber: Number(marker[1]),
    head: gitOid(marker[2]!),
    fingerprint: marker[3]!,
    runIds,
    requestedAt,
  };
}

export function emptyTreeOid(): GitOid {
  return gitOid(createHash('sha1').update('tree 0\0').digest('hex'));
}

export type CiRerunDeps = {
  readChecks(prNumber: number): Promise<readonly CheckSummary[]>;
  readRecord(prNumber: number, head: GitOid): Promise<CiRerunRecord | null>;
  rerunFailedJobs(runId: number): Promise<void>;
  publishRecord(record: CiRerunRecord): Promise<PublicationOutcome>;
  fileCiFailureChild(input: {
    readonly prNumber: number;
    readonly head: GitOid;
    readonly classification: Extract<CiClassification, { state: 'failed' }>;
    readonly record?: CiRerunRecord;
  }): Promise<
    | { readonly status: 'filed' | 'already-open'; readonly childNumber: number }
    | { readonly status: 'runaway-hold'; readonly priorCount: number }
    | { readonly status: 'ineligible'; readonly reason: string }
  >;
};

export type CiRerunExecutionResult =
  | { readonly status: 'rerun-requested'; readonly prNumber: number; readonly head: GitOid }
  | { readonly status: 'waiting'; readonly prNumber: number; readonly head: GitOid; readonly reason: string }
  | { readonly status: 'filed' | 'already-open'; readonly prNumber: number; readonly childNumber: number }
  | { readonly status: 'runaway-hold'; readonly prNumber: number; readonly priorCount: number }
  | { readonly status: 'ineligible'; readonly prNumber: number; readonly reason: string };

function failedClassification(
  checks: readonly CheckSummary[],
): Extract<CiClassification, { state: 'failed' }> | null {
  const classification = classifyCiChecks(checks);
  return classification.state === 'failed' ? classification : null;
}

export async function executeRerunFailedChecksAction(
  action: { readonly prNumber: number; readonly head: GitOid },
  deps: CiRerunDeps,
): Promise<CiRerunExecutionResult> {
  const checks = await deps.readChecks(action.prNumber);
  const failed = failedClassification(checks);
  if (failed === null) {
    const classification = classifyCiChecks(checks);
    if (classification.state === 'green') {
      return {
        status: 'ineligible',
        prNumber: action.prNumber,
        reason: 'checks-green',
      };
    }
    return {
      status: 'waiting',
      prNumber: action.prNumber,
      head: action.head,
      reason: classification.state,
    };
  }
  const existing = await deps.readRecord(action.prNumber, action.head);
  if (existing !== null) {
    return {
      status: 'waiting',
      prNumber: action.prNumber,
      head: action.head,
      reason: 'rerun-already-recorded',
    };
  }
  if (failed.rerunnableRunIds.length === 0) {
    const filed = await deps.fileCiFailureChild({
      prNumber: action.prNumber,
      head: action.head,
      classification: failed,
    });
    if (filed.status === 'filed' || filed.status === 'already-open') {
      return {
        status: filed.status,
        prNumber: action.prNumber,
        childNumber: filed.childNumber,
      };
    }
    if (filed.status === 'runaway-hold') {
      return {
        status: 'runaway-hold',
        prNumber: action.prNumber,
        priorCount: filed.priorCount,
      };
    }
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reason: filed.status === 'ineligible' ? filed.reason : 'file-ci-failure-child-failed',
    };
  }
  for (const runId of failed.rerunnableRunIds) {
    await deps.rerunFailedJobs(runId);
  }
  const record: CiRerunRecord = {
    prNumber: action.prNumber,
    head: action.head,
    fingerprint: ciCheckFingerprint(checks),
    runIds: failed.rerunnableRunIds,
    requestedAt: new Date().toISOString(),
  };
  const outcome = await deps.publishRecord(record);
  if (outcome.status === 'ambiguous') {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reason: 'rerun-record-ambiguous',
    };
  }
  return {
    status: 'rerun-requested',
    prNumber: action.prNumber,
    head: action.head,
  };
}

export async function executeFileCiFailureChildAction(
  action: { readonly prNumber: number; readonly head: GitOid },
  deps: CiRerunDeps,
): Promise<CiRerunExecutionResult> {
  const checks = await deps.readChecks(action.prNumber);
  const failed = failedClassification(checks);
  if (failed === null) {
    const classification = classifyCiChecks(checks);
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reason: classification.state === 'green' ? 'checks-green' : classification.state,
    };
  }
  const record = await deps.readRecord(action.prNumber, action.head);
  if (record === null && failed.rerunnableRunIds.length > 0) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reason: 'rerun-not-attempted',
    };
  }
  const filed = await deps.fileCiFailureChild({
    prNumber: action.prNumber,
    head: action.head,
    classification: failed,
    ...(record === null ? {} : { record }),
  });
  if (filed.status === 'filed' || filed.status === 'already-open') {
    return {
      status: filed.status,
      prNumber: action.prNumber,
      childNumber: filed.childNumber,
    };
  }
  if (filed.status === 'runaway-hold') {
    return {
      status: 'runaway-hold',
      prNumber: action.prNumber,
      priorCount: filed.priorCount,
    };
  }
  return {
    status: 'ineligible',
    prNumber: action.prNumber,
    reason: filed.status === 'ineligible' ? filed.reason : 'file-ci-failure-child-failed',
  };
}
