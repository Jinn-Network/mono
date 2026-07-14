import type { BlockedOn } from '../dispatcher/types.js';

export type MergeBatchCi =
  | { kind: 'green' }
  | { kind: 'pending'; checks: string[] }
  | { kind: 'red'; checks: string[] };

export type MergeBatchReview =
  | { kind: 'satisfied'; approvers: string[] }
  | { kind: 'admin-authorized'; approver: string }
  | { kind: 'awaiting-code-owner-review'; missingOwnerSets: string[][] }
  | { kind: 'awaiting-maintainer-review' };

export type MergeBatchRisk = 'small' | 'normal' | 'large' | 'solo';

export interface MergeBatchPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  author: string;
  linkedIssueNumber: number | null;
  blockedOn: BlockedOn | null;
  files: string[];
  additions: number;
  deletions: number;
  dependsOnPrNumbers: number[];
  review: MergeBatchReview;
  ci: MergeBatchCi;
  risk: MergeBatchRisk;
}

export type MergeBatchSkipReason =
  | 'awaiting-ci'
  | 'ci-red'
  | 'blocked-on-human'
  | 'awaiting-code-owner-review'
  | 'awaiting-maintainer-review'
  | 'missing-linked-issue'
  | 'ambiguous-linked-issue';

export interface MergeBatchSkippedPr {
  pr: MergeBatchPr;
  reason: MergeBatchSkipReason;
  detail: string;
}

export type MergeBatchWaveKind =
  | 'dependency-stack'
  | 'refactor-stack'
  | 'reactive-overlap'
  | 'independent'
  | 'solo-large';

export type MergeBatchWaveStatus =
  | 'planned'
  | 'preflighted'
  | 'executing'
  | 'merged'
  | 'split'
  | 'blocked';

export interface MergeBatchWave {
  id: string;
  kind: MergeBatchWaveKind;
  prs: MergeBatchPr[];
  reason: string;
  status: MergeBatchWaveStatus;
}

export interface MergeBatchManifest {
  schemaVersion: 1;
  repo: 'Jinn-Network/mono';
  baseBranch: 'next';
  baseNextSha: string;
  createdAt: string;
  waves: MergeBatchWave[];
  skipped: MergeBatchSkippedPr[];
}
