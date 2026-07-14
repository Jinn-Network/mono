import { planMergeBatchWaves } from './waves.js';
import type {
  MergeBatchManifest,
  MergeBatchPr,
  MergeBatchSkipReason,
  MergeBatchSkippedPr,
} from './types.js';

export interface CreateManifestInput {
  baseNextSha: string;
  createdAt: string;
  prs: MergeBatchPr[];
  maxWaveSize: number;
}

export type ResumeValidation =
  | { kind: 'valid' }
  | { kind: 'invalid'; reason: string };

export function createMergeBatchManifest(input: CreateManifestInput): MergeBatchManifest {
  const skipped: MergeBatchSkippedPr[] = [];
  const candidates: MergeBatchPr[] = [];

  for (const pr of input.prs) {
    const reason = skipReason(pr);
    if (reason == null) {
      candidates.push(pr);
    } else {
      skipped.push({ pr, reason, detail: skipDetail(pr, reason) });
    }
  }

  return {
    schemaVersion: 1,
    repo: 'Jinn-Network/mono',
    baseBranch: 'next',
    baseNextSha: input.baseNextSha,
    createdAt: input.createdAt,
    waves: planMergeBatchWaves(candidates, { maxWaveSize: input.maxWaveSize }),
    skipped,
  };
}

export function validateResume(
  manifest: MergeBatchManifest,
  currentNextSha: string,
): ResumeValidation {
  if (manifest.baseNextSha !== currentNextSha) {
    return { kind: 'invalid', reason: 'origin/next changed since manifest creation' };
  }
  return { kind: 'valid' };
}

function skipReason(pr: MergeBatchPr): MergeBatchSkipReason | null {
  if (pr.linkedIssueNumber == null) return 'missing-linked-issue';
  if (pr.blockedOn === 'Human') return 'blocked-on-human';
  if (pr.ci.kind === 'pending') return 'awaiting-ci';
  if (pr.ci.kind === 'red') return 'ci-red';
  if (pr.review.kind === 'awaiting-code-owner-review') return 'awaiting-code-owner-review';
  if (pr.review.kind === 'awaiting-maintainer-review') return 'awaiting-maintainer-review';
  return null;
}

function skipDetail(pr: MergeBatchPr, reason: MergeBatchSkipReason): string {
  if (reason === 'awaiting-ci' && pr.ci.kind === 'pending') {
    return `pending checks: ${pr.ci.checks.join(', ')}`;
  }
  if (reason === 'ci-red' && pr.ci.kind === 'red') {
    return `red checks: ${pr.ci.checks.join(', ')}`;
  }
  if (reason === 'awaiting-code-owner-review' && pr.review.kind === 'awaiting-code-owner-review') {
    return `missing owner sets: ${pr.review.missingOwnerSets
      .map((set) => set.join('/'))
      .join(', ')}`;
  }
  if (reason === 'awaiting-maintainer-review') return 'needs OWNER or MEMBER approval';
  if (reason === 'blocked-on-human') return 'linked issue is already paused';
  if (reason === 'missing-linked-issue') return 'PR has no linked issue reference';
  return 'PR needs manual review before batch planning';
}
