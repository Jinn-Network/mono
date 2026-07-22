export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type GitOid = Brand<string, 'GitOid'>;
export type GitRefName = Brand<string, 'GitRefName'>;
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

const OID_PATTERN = /^[0-9a-f]{40}$/;
const INVALID_REF_PATTERN = /[\u0000-\u0020\u007f~^:?*[\]\\]/;

export function gitOid(value: string): GitOid {
  if (!OID_PATTERN.test(value)) {
    throw new Error(`Invalid Git OID: ${value}`);
  }
  return value as GitOid;
}

export function gitRefName(value: string): GitRefName {
  const segments = value.split('/');
  if (
    value.length === 0
    || value === '@'
    || value.startsWith('/')
    || value.endsWith('/')
    || value.startsWith('.')
    || value.endsWith('.')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || INVALID_REF_PATTERN.test(value)
    || segments.some((segment) => segment.length === 0
      || segment.startsWith('.')
      || segment.endsWith('.')
      || segment.endsWith('.lock'))
  ) {
    throw new Error(`Invalid Git ref name: ${value}`);
  }
  return value as GitRefName;
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isoTimestamp(value: string): IsoTimestamp {
  const time = Date.parse(value);
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(time)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return value as IsoTimestamp;
}

export type AutopilotMode = 'observe' | 'recover' | 'active';

export type LifecyclePhase =
  | 'eligible'
  | 'implementing'
  | 'awaiting-review'
  | 'reviewing'
  | 'blocked-by-child'
  | 'merge-ready'
  | 'human'
  | 'merged';

export type BranchClaimPhase = 'implement' | 'fix' | 'reconcile';

interface BranchClaimBase {
  readonly kind: 'branch-claim';
  readonly protocolVersion: 2;
  readonly issueNumber: number;
  readonly attempt: string;
  readonly runner: string;
  readonly login: string;
  readonly expectedHead: GitOid;
  readonly targetBase: GitRefName;
  readonly claimedAt: string;
  readonly phaseComplete?: true;
}

export type BranchClaim =
  | (BranchClaimBase & {
      readonly phase: 'implement';
      readonly prNumber?: number;
    })
  | (BranchClaimBase & {
      readonly phase: 'fix' | 'reconcile';
      readonly prNumber: number;
    });

export type ReviewClaimState =
  | 'active'
  | 'verdict-intent'
  | 'terminal-approved'
  | 'human'
  | 'stale';

export type ReviewVerdictState = 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewVerdict {
  readonly marker: string;
  readonly state: ReviewVerdictState;
}

interface ReviewClaimBase {
  readonly kind: 'review-claim';
  readonly protocolVersion: 2;
  readonly prNumber: number;
  readonly generation: string;
  readonly attempt: string;
  readonly reviewer: string;
  readonly head: GitOid;
  readonly recordedAt: string;
}

export type ReviewClaimRecord =
  | (ReviewClaimBase & {
      readonly state: 'active' | 'human' | 'stale';
      readonly verdict?: never;
    })
  | (ReviewClaimBase & {
      readonly state: 'verdict-intent';
      readonly verdict: ReviewVerdict;
    })
  | (ReviewClaimBase & {
      readonly state: 'terminal-approved';
      readonly verdict: ReviewVerdict & { readonly state: 'APPROVE' };
    });

export type HumanReason =
  | {
      readonly phase: 'eligible' | 'implementing';
      readonly code:
        | 'first-push'
        | 'implementation-escalation'
        | 'branch-mapping-ambiguous'
        | 'invalid-branch-progress-time';
      readonly detail: string;
    }
  | {
      readonly phase: 'awaiting-review' | 'reviewing';
      readonly code:
        | 'review-escalation'
        | 'reviewer-identity-unavailable'
        | 'invalid-review-progress-time';
      readonly detail: string;
    }
  | {
      readonly phase: 'merge-ready';
      readonly code:
        | 'semantic-conflict'
        | 'codeowner-sensitive-conflict'
        | 'invalid-merge-progress-time'
        | 'runaway-child';
      readonly detail: string;
    };

export type IssueEligibilityReason =
  | 'eligible'
  | 'dependency-blocked'
  | 'author-disallowed'
  | 'not-selected';

export interface LifecycleItemBase {
  readonly issueNumber: number;
  readonly v2Marked: boolean;
  readonly projectStatus: 'Todo' | 'In Progress' | 'Human' | 'In Review' | 'Done' | null;
  readonly labels: readonly string[];
  readonly humanHold?: boolean;
  readonly humanReason?: HumanReason;
}

export interface IssueLifecycleItem extends LifecycleItemBase {
  readonly kind: 'issue';
  readonly eligible: boolean;
  readonly eligibilityReason?: IssueEligibilityReason;
  readonly eligibilityDetail?: string;
}

export interface TerminalVerdictEvidence {
  readonly head: GitOid;
  readonly state: ReviewVerdictState;
  readonly recordedAt: string;
  readonly marker: string;
}

export interface PullRequestLifecycleItem extends LifecycleItemBase {
  readonly kind: 'pull-request';
  readonly prNumber: number;
  readonly head: GitOid;
  readonly headChangedAt: string;
  readonly isDraft: boolean;
  readonly merged: boolean;
  readonly needsReview: boolean;
  readonly approved: boolean;
  readonly mergeState: 'clean' | 'behind' | 'conflict' | 'blocked';
  /** Open child issues targeting this PR (Stage 2 single-surface children). */
  readonly openChildKinds?: readonly ('review-finding' | 'reconcile')[];
  readonly branchClaim?: BranchClaim;
  readonly implementationSummary?: string;
  readonly reviewClaim?: ReviewClaimRecord;
  readonly terminalVerdict?: TerminalVerdictEvidence;
}

export type LifecycleItem = IssueLifecycleItem | PullRequestLifecycleItem;

export interface LifecycleSnapshot {
  readonly items: readonly LifecycleItem[];
}

export interface LifecycleMappingDiagnostic {
  readonly code: 'branch-mapping-ambiguous';
  readonly detail: string;
  readonly issueNumbers: readonly number[];
  readonly issues: readonly {
    readonly number: number;
    readonly projectStatus: LifecycleItemBase['projectStatus'];
  }[];
  readonly pullRequests: readonly {
    readonly number: number;
    readonly head: GitOid;
    readonly draft: boolean;
    readonly labels: readonly string[];
  }[];
}

export interface LifecycleViewItem {
  readonly item: LifecycleItem;
  readonly phase: LifecyclePhase;
  readonly underlyingPhase?: Exclude<LifecyclePhase, 'human'>;
  readonly humanReason?: HumanReason;
  readonly stale: boolean;
  readonly staleSince?: string;
  readonly staleReason?: 'branch-head-unchanged' | 'review-progress-unchanged';
  readonly supersededReview: boolean;
}

export interface LifecycleView {
  readonly items: readonly LifecycleViewItem[];
}

export interface LocalCapacity {
  readonly implementationSlots: number;
  readonly reviewSlots: number;
  readonly usableCredentialLanes: number;
}

export type NewWorkAction =
  | { readonly kind: 'claim-implementation'; readonly issueNumber: number }
  | {
      readonly kind: 'claim-review';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly kind: 'update-branch';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly kind: 'file-reconcile-child';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
      readonly effort: 'low' | 'medium' | 'high';
    }
  | {
      readonly kind: 'merge';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    };

export type RecoveryAction =
  | {
      readonly kind: 'mark-review-stale';
      readonly prNumber: number;
      readonly expectedGeneration: string;
      readonly expectedHead: GitOid;
    };

export type PlannedAction = NewWorkAction | RecoveryAction;

export type ScalarOidState = {
  readonly expected: GitOid | null;
  readonly published: GitOid;
  readonly observed: GitOid | null;
};

export type ClaimOutcome =
  | ({ readonly status: 'won' | 'lost' | 'already-applied' } & ScalarOidState)
  | ({ readonly status: 'ambiguous' } & ScalarOidState);

export type PublicationOutcome =
  | ({ readonly status: 'won' | 'lost' | 'already-applied' } & ScalarOidState)
  | ({ readonly status: 'ambiguous' } & ScalarOidState);
