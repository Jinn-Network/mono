import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DispatcherConfig } from '../dispatcher/types.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import {
  spawnCoordinatorSession,
  type SpawnFn,
  type SpawnResult,
} from '../dispatcher/coordinator-session.js';
import {
  assertHermesBillingRoute,
  assertHermesRuntimeReady,
} from '../dispatcher/hermes-runtime.js';
import {
  listRunnerLiveAttempts,
  trackAttemptChild,
  type TrackableAttemptChild,
} from './attempt-workspace.js';
import { makeActiveRuntime } from './active-runtime.js';
import { formatHumanCommentMarker } from './codecs.js';
import {
  selectCredential,
  type CredentialPool,
} from './credentials.js';
import {
  CAPABILITY_ATTESTATION_ENV,
  readCapabilityAttestation,
} from './capability-attestation.js';
import {
  CANONICAL_GITHUB_HTTPS_REMOTE,
  executeImplementationAction,
  makeCanonicalImplementationSpawner,
} from './implementation-executor.js';
import {
  makeProductionImplementationActionPort,
} from './implementation-executor-production.js';
import { executeReviewAction } from './review-executor.js';
import { makeProductionReviewActionPort } from './review-executor-production.js';
import { executeMergePrepAction } from './merge-prep-executor.js';
import { makeProductionMergePrepActionPort } from './merge-prep-executor-production.js';
import { executeMergeAction } from './merge-executor.js';
import { makeProductionMergeActionPort } from './merge-executor-production.js';
import { makeProductionReconciliationWriter } from './reconciliation-writer-production.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import type { GitOid, HumanReason } from './types.js';

export const AUTOPILOT_V2_REMOTE = 'jinn-autopilot-v2';

export interface ProductionActiveRuntimeOptions {
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly credentials: CredentialPool;
  readonly authorAllowlist: ReadonlySet<string>;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly config: DispatcherConfig;
  readonly spawn: SpawnFn;
  readonly caps: {
    readonly implementation: number;
    readonly review: number;
    readonly mergePrep: number;
  };
  readonly implementationBackpressureThreshold: number;
  readonly staleAfterMs: number;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly readCapabilityAttestation?: typeof readCapabilityAttestation;
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly remoteName?: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function requireTrackable(child: SpawnResult): TrackableAttemptChild {
  if (
    child.pid === undefined
    || typeof (child as Partial<TrackableAttemptChild>).once !== 'function'
  ) {
    throw new Error('Production coordinator child is not trackable');
  }
  return child as TrackableAttemptChild;
}

function reviewScenario(input: {
  readonly prNumber: number;
  readonly issueNumber: number;
  readonly head: string;
  readonly worktreePath: string;
  readonly recoverFixes: boolean;
}): string {
  return [
    `Use the review-pr skill on PR #${input.prNumber} for issue #${input.issueNumber}.`,
    `The v2 lifecycle already claimed exact head \`${input.head}\` and created the detached worktree at \`${input.worktreePath}\`.`,
    input.recoverFixes
      ? 'Resume the same review generation’s fix-and-re-review loop.'
      : 'Run the canonical review, fix, and re-review loop.',
    'Publish review fixes with `autopilot session review-fix-publish`.',
    'Finish with `autopilot session review-verdict --state <APPROVE|REQUEST_CHANGES> --body-file <path>` or park with `autopilot session human --reason-file <path>`.',
  ].join('\n');
}

function mergePrepScenario(input: {
  readonly prNumber: number;
  readonly issueNumber: number;
  readonly head: string;
  readonly targetBaseOid: string;
  readonly worktreePath: string;
}): string {
  return [
    `Use the merge-prep skill on PR #${input.prNumber} for issue #${input.issueNumber}.`,
    `The v2 lifecycle already claimed exact head \`${input.head}\`, bound target base \`${input.targetBaseOid}\`, and created the detached worktree at \`${input.worktreePath}\`.`,
    'Resolve mechanical conflicts only. Never merge, approve, or bypass a human or CI gate.',
    'Finish with `autopilot session merge-prep-complete --summary-file <path>` or park with `autopilot session human --reason-file <path>`.',
  ].join('\n');
}

export function makeProductionCapabilityPreflight(
  options: Pick<
  ProductionActiveRuntimeOptions,
  | 'repositoryPath'
  | 'credentials'
  | 'config'
  | 'runner'
  | 'remoteName'
  | 'environment'
  | 'now'
  | 'readCapabilityAttestation'
  >,
): () => Promise<{ readonly ok: boolean; readonly detail?: string }> {
  const runner = options.runner ?? defaultRunner;
  const remoteName = options.remoteName ?? AUTOPILOT_V2_REMOTE;
  const ambient = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const readAttestation =
    options.readCapabilityAttestation ?? readCapabilityAttestation;
  return async () => {
    try {
      if (options.credentials.logins().length === 0) {
        throw new Error('no configured GitHub credential is available');
      }
      const url = (await runner('git', [
        '-C', options.repositoryPath,
        'remote', 'get-url', remoteName,
      ])).trim();
      if (url !== CANONICAL_GITHUB_HTTPS_REMOTE) {
        throw new Error(
          `${remoteName} must be the canonical HTTPS GitHub remote`,
        );
      }
      const attestationPath = ambient[CAPABILITY_ATTESTATION_ENV];
      if (attestationPath === undefined || attestationPath.length === 0) {
        throw new Error(
          `${CAPABILITY_ATTESTATION_ENV} must name a fresh live capability attestation`,
        );
      }
      readAttestation(attestationPath, {
        remoteName,
        configuredLogins: options.credentials.logins(),
        now: now(),
      });
      if (options.config.runtime === 'hermes') {
        assertHermesBillingRoute(
          options.config.hermesModel,
          options.config.hermesProvider,
        );
        assertHermesRuntimeReady(options.config.hermesPythonPath);
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function makeProductionActiveRuntime(
  options: ProductionActiveRuntimeOptions,
): ReturnType<typeof makeActiveRuntime> {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const nextId = options.nextId ?? randomUUID;
  const remoteName = options.remoteName ?? AUTOPILOT_V2_REMOTE;
  const alive = options.isPidAlive ?? isPidAlive;
  const track = (manifestPath: string, child: SpawnResult): void => {
    trackAttemptChild(manifestPath, requireTrackable(child), { now });
  };
  const implementationPreferred = selectCredential(
    options.credentials,
    { phase: 'implement' },
  );
  const implementationPreferredLogin = implementationPreferred.status === 'selected'
    ? implementationPreferred.login
    : options.credentials.logins()[0] ?? '';
  const implementationSpawner = makeCanonicalImplementationSpawner(
    options.config,
    options.spawn,
  );
  const reviewSpawner = (
    input: Parameters<import('./review-executor.js').ReviewExecutorDeps['spawnCoordinator']>[0],
  ) => spawnCoordinatorSession({
    kind: 'review',
    number: input.candidate.number,
    skill: 'review-pr',
    scenario: reviewScenario({
      prNumber: input.candidate.number,
      issueNumber: input.candidate.issueNumber,
      head: input.candidate.head,
      worktreePath: input.worktreePath,
      recoverFixes: input.recoverFixes,
    }),
    worktreePath: input.worktreePath,
    effort: null,
    env: input.environment,
    spawnOptions: {
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      logPath: input.logPath,
    },
  }, options.config, { spawn: options.spawn });
  const mergePrepSpawner = (
    input: Parameters<
    import('./merge-prep-executor.js').MergePrepExecutorDeps['spawnCoordinator']
    >[0],
  ) => spawnCoordinatorSession({
    kind: 'merge-prep',
    number: input.candidate.prNumber,
    skill: 'merge-prep',
    scenario: mergePrepScenario({
      prNumber: input.candidate.prNumber,
      issueNumber: input.candidate.issueNumber,
      head: input.candidate.head,
      targetBaseOid: input.candidate.targetBaseOid,
      worktreePath: input.worktreePath,
    }),
    worktreePath: input.worktreePath,
    effort: null,
    env: input.environment,
    spawnOptions: {
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      logPath: input.logPath,
    },
  }, options.config, { spawn: options.spawn });
  const escalateReview = async (
    input: {
      readonly candidate: {
        readonly issueNumber: number;
        readonly number: number;
        readonly head: GitOid;
      };
      readonly reason: HumanReason;
    },
    credentials: CredentialPool,
  ): Promise<void> => {
    const selection = selectCredential(credentials, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error(selection.detail);
    const writer = makeProductionReconciliationWriter({
      repositoryPath: options.repositoryPath,
      readSnapshot: options.readSnapshot,
      credential: selection.credential,
      runner,
      environment: ambient,
      now,
    });
    const before = await writer.readPullRequest(input.candidate.number);
    if (before?.head !== input.candidate.head) {
      throw new Error('Review Human escalation lost exact-head authority');
    }
    const marker = formatHumanCommentMarker({
      issueNumber: input.candidate.issueNumber,
      prNumber: input.candidate.number,
      reason: input.reason,
    });
    await writer.setPullRequestDraft(
      input.candidate.number,
      true,
      input.candidate.head,
    );
    await writer.setPullRequestLabel(
      input.candidate.number,
      'review:needs-human',
      true,
      input.candidate.head,
    );
    await writer.setProjectStatus(
      input.candidate.issueNumber,
      'Human',
      input.candidate.head,
    );
    await writer.ensureHumanComment(
      input.candidate.number,
      marker,
      `${marker}\n\n${input.reason.detail}`,
      input.candidate.head,
    );
  };

  return makeActiveRuntime({
    credentials: options.credentials,
    caps: options.caps,
    implementationPreferredLogin,
    implementationBackpressureThreshold:
      options.implementationBackpressureThreshold,
    readLocalAttempts: () => listRunnerLiveAttempts(
      join(options.worktreeBase, 'v2'),
      options.runnerId,
      alive,
    ),
    preflight: makeProductionCapabilityPreflight(options),
    handlers: {
      implementation: (action, credentials) => {
        const port = makeProductionImplementationActionPort({
          repositoryPath: options.repositoryPath,
          worktreeBase: options.worktreeBase,
          runnerId: options.runnerId,
          remoteName,
          credentials,
          authorAllowlist: options.authorAllowlist,
          readSnapshot: options.readSnapshot,
          runner,
          environment: ambient,
        });
        return executeImplementationAction(action, {
          ...port,
          credentials,
          remoteUrl: CANONICAL_GITHUB_HTTPS_REMOTE,
          ambientEnvironment: ambient,
          nextAttemptId: nextId,
          runnerId: options.runnerId,
          now,
          spawnCoordinator: implementationSpawner,
          trackChild: track,
        });
      },

      review: (action, credentials) => {
        const port = makeProductionReviewActionPort({
          repositoryPath: options.repositoryPath,
          worktreeBase: options.worktreeBase,
          runnerId: options.runnerId,
          remoteName,
          readSnapshot: options.readSnapshot,
          runner,
          environment: ambient,
        });
        return executeReviewAction({
          prNumber: action.prNumber,
          expectedHead: action.head,
          recoverFixes: action.recoverFixes,
        }, {
          ...port,
          credentials,
          ambientEnvironment: ambient,
          nextAttemptId: nextId,
          nextGeneration: nextId,
          runnerId: options.runnerId,
          now,
          staleAfterMs: options.staleAfterMs,
          spawnCoordinator: reviewSpawner,
          trackChild: track,
          escalateHuman: (input) => escalateReview(input, credentials),
        });
      },

      mergePrep: (action, credentials) => {
        const port = makeProductionMergePrepActionPort({
          repositoryPath: options.repositoryPath,
          worktreeBase: options.worktreeBase,
          runnerId: options.runnerId,
          remoteName,
          readSnapshot: options.readSnapshot,
          runner,
          environment: ambient,
        });
        return executeMergePrepAction({
          prNumber: action.prNumber,
          expectedHead: action.head,
          recoverStale: action.recoverStale,
        }, {
          ...port,
          credentials,
          remoteUrl: CANONICAL_GITHUB_HTTPS_REMOTE,
          ambientEnvironment: ambient,
          nextAttemptId: nextId,
          runnerId: options.runnerId,
          now,
          spawnCoordinator: mergePrepSpawner,
          trackChild: track,
          escalateHuman: async () => {},
        });
      },

      merge: (action, credentials) => executeMergeAction({
        prNumber: action.prNumber,
        expectedHead: action.head,
      }, {
        ...makeProductionMergeActionPort({
          readSnapshot: options.readSnapshot,
          authorAllowlist: options.authorAllowlist,
          runner,
          environment: ambient,
        }),
        credentials,
      }),
    },
  });
}
