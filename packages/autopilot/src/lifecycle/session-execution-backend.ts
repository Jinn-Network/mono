import type { SpawnResult } from '../dispatcher/coordinator-session.js';
import {
  spawnCoordinatorSession,
  type SpawnFn,
} from '../dispatcher/coordinator-session.js';
import type { DispatcherConfig, Effort } from '../dispatcher/types.js';
import {
  buildSanitizedChildEnv,
  type CredentialPool,
} from './credentials.js';
import type { GitOid, GitRefName } from './types.js';

export type MutationWorkflow =
  | 'implement'
  | 'fix-child'
  | 'reconcile'
  | 'ci-failure';

export interface ClaimedSessionAttempt {
  readonly manifestPath: string;
  readonly worktreePath: string;
  readonly logPath: string;
  readonly ghConfigDir: string;
  readonly askpassPath: string;
}

interface ClaimedSessionCommon {
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
  };
  readonly pr: {
    readonly number: number;
    readonly body: string;
  };
  readonly targetBase: GitRefName;
  readonly branch: GitRefName;
  readonly claimOid: GitOid;
  readonly expectedHead: GitOid;
  readonly baseSha: GitOid;
  readonly v2AttemptId: string;
  readonly runnerId: string;
  readonly selectedLogin: string;
  readonly deadline: string;
  readonly receiptAuthors: readonly string[];
  readonly attempt: ClaimedSessionAttempt;
}

export interface ClaimedMutationSessionInput extends ClaimedSessionCommon {
  readonly kind: 'mutation';
  readonly workflow: MutationWorkflow;
  readonly childIssueNumber?: number;
  readonly parentPrNumber?: number;
  readonly effort: Effort | null;
}

export interface ClaimedReviewSessionInput extends ClaimedSessionCommon {
  readonly kind: 'review';
  readonly workflow: 'review';
  readonly effort: null;
  readonly reviewGeneration: string;
  readonly reviewRefOid: GitOid;
  readonly approvalPolicy: 'approve-eligible' | 'human-codeowner';
  readonly prAuthor: string;
}

export type ClaimedSessionInput =
  | ClaimedMutationSessionInput
  | ClaimedReviewSessionInput;

export type ExecutionHandle =
  | {
      readonly backend: 'local';
      readonly pid: number;
    }
  | MarketplaceExecutionHandle;

export interface MarketplaceExecutionHandle {
  readonly backend: 'marketplace';
  readonly taskId: string;
  readonly taskCid: string;
  readonly deadline: string;
  readonly requestFile: string;
  readonly attemptIndex?: number;
  readonly requestId?: string;
}

export type ExecutionObservation =
  | { readonly state: 'running' }
  | { readonly state: 'completed' }
  | { readonly state: 'cancelled'; readonly detail?: string }
  | { readonly state: 'failed'; readonly detail: string };

export interface SessionExecutionBackend {
  start(input: ClaimedSessionInput): Promise<ExecutionHandle>;
  recover(handle: ExecutionHandle): Promise<ExecutionObservation>;
  cancel(handle: ExecutionHandle, reason: string): Promise<void>;
}

export interface LocalSessionExecutionBackendOptions {
  readonly config: DispatcherConfig;
  readonly credentials: CredentialPool;
  readonly ambientEnvironment: NodeJS.ProcessEnv;
  readonly spawn: SpawnFn;
  readonly trackChild: (manifestPath: string, child: SpawnResult) => void;
  readonly isPidAlive: (pid: number) => boolean;
  readonly cancelProcess?: (pid: number) => void;
}

function mutationSkill(
  workflow: MutationWorkflow,
): 'implement-issue' | 'fix-child' | 'reconcile' {
  if (workflow === 'implement') return 'implement-issue';
  if (workflow === 'reconcile') return 'reconcile';
  return 'fix-child';
}

function localScenario(input: ClaimedSessionInput): string {
  if (input.kind === 'review') {
    return [
      `Use the review-pr skill on PR #${input.pr.number} for issue #${input.issue.number}.`,
      `The v2 lifecycle already claimed exact head \`${input.expectedHead}\` and created the detached worktree at \`${input.attempt.worktreePath}\`.`,
      'Finish with `autopilot session review-verdict --state <APPROVE|REQUEST_CHANGES> --body-file <path>` or park with `autopilot session human --reason-file <path>`.',
    ].join('\n');
  }
  if (input.workflow !== 'implement') {
    const skill = mutationSkill(input.workflow);
    return [
      `Use the ${skill} skill on child issue #${input.childIssueNumber ?? input.issue.number} for parent PR #${input.pr.number}.`,
      `Issue: #${input.childIssueNumber ?? input.issue.number} — ${input.issue.title}`,
      `The v2 lifecycle already claimed parent branch \`${input.branch}\` and created the detached worktree at \`${input.attempt.worktreePath}\`.`,
      'Do not open a new PR. Work lands as append-only commits on the parent branch.',
      'Finish with `autopilot session child-complete` or park with `autopilot session human --reason-file <path>`.',
    ].join('\n');
  }
  return [
    `Use the implement-issue skill on issue #${input.issue.number}.`,
    `Issue: #${input.issue.number} — ${input.issue.title}`,
    `The v2 lifecycle already claimed \`${input.branch}\`, opened draft PR #${input.pr.number}, and created the detached worktree at \`${input.attempt.worktreePath}\`.`,
    'Use `autopilot session checkpoint` for meaningful durable checkpoints.',
    'Finish with `autopilot session implementation-complete --summary-file <path>` or park with `autopilot session human --reason-file <path>`.',
  ].join('\n');
}

function selectedCredentialFor(
  input: ClaimedSessionInput,
  credentials: CredentialPool,
) {
  const selection = credentials.restrictedTo([input.selectedLogin]).select(
    input.kind === 'review'
      ? { phase: 'review', prAuthor: input.prAuthor }
      : { phase: 'implement' },
  );
  if (
    selection.status !== 'selected'
    || selection.login.toLowerCase() !== input.selectedLogin.toLowerCase()
  ) {
    throw new Error(
      selection.status === 'selected'
        ? 'Claimed session credential selection changed'
        : selection.detail,
    );
  }
  return selection.credential;
}

export function makeLocalSessionExecutionBackend(
  options: LocalSessionExecutionBackendOptions,
): SessionExecutionBackend {
  return {
    async start(input) {
      const credential = selectedCredentialFor(input, options.credentials);
      const environment = buildSanitizedChildEnv(
        options.ambientEnvironment,
        credential,
        {
          ghConfigDir: input.attempt.ghConfigDir,
          askpassPath: input.attempt.askpassPath,
          manifestPath: input.attempt.manifestPath,
        },
      );
      const child = spawnCoordinatorSession({
        kind: input.kind === 'review' ? 'review' : 'implement',
        number: input.kind === 'review'
          ? input.pr.number
          : input.childIssueNumber ?? input.issue.number,
        skill: input.kind === 'review' ? 'review-pr' : mutationSkill(input.workflow),
        scenario: localScenario(input),
        worktreePath: input.attempt.worktreePath,
        effort: input.effort,
        env: environment,
        spawnOptions: {
          detached: true,
          stdio: ['ignore', 'inherit', 'inherit'],
          logPath: input.attempt.logPath,
        },
      }, options.config, { spawn: options.spawn });
      if (child.pid === undefined) {
        throw new Error('Local coordinator did not report a child PID');
      }
      options.trackChild(input.attempt.manifestPath, child);
      return { backend: 'local', pid: child.pid };
    },

    async recover(handle) {
      if (handle.backend !== 'local') {
        return {
          state: 'failed',
          detail: 'Local backend cannot recover a marketplace handle',
        };
      }
      return options.isPidAlive(handle.pid)
        ? { state: 'running' }
        : { state: 'completed' };
    },

    async cancel(handle, _reason) {
      if (handle.backend !== 'local') {
        throw new Error('Local backend cannot cancel a marketplace handle');
      }
      (options.cancelProcess ?? ((pid) => process.kill(pid, 'SIGTERM')))(handle.pid);
    },
  };
}
