import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DispatcherConfig } from '../dispatcher/types.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import {
  type SpawnFn,
} from '../dispatcher/coordinator-session.js';
import {
  assertHermesBillingRoute,
  assertHermesRuntimeReady,
} from '../dispatcher/hermes-runtime.js';
import {
  assertCursorRuntimeReady,
} from '../dispatcher/cursor-runtime.js';
import {
  readAttemptManifest,
  listRunnerLiveAttempts,
  markAttemptExited,
  markMarketplaceAttemptRunning,
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
} from './implementation-executor.js';
import {
  makeProductionImplementationActionPort,
} from './implementation-executor-production.js';
import { executeReviewAction } from './review-executor.js';
import { makeProductionReviewActionPort } from './review-executor-production.js';
import { makeReviewSessionProtocol } from './review-session.js';
import {
  makeProductionReviewSessionPort,
} from './review-session-production.js';
import {
  executeMergeAction,
  executeFileReconcileChildAction,
  executeUpdateBranchAction,
} from './merge-executor.js';
import { makeProductionMergeActionPort } from './merge-executor-production.js';
import {
  executeProductionFileCiFailureChild,
  executeProductionRerunFailedChecks,
} from './ci-rerun-production.js';
import {
  makeProductionReconciliationWriter,
  type ReconciliationProjectItemNode,
  type ReconciliationPullRequestNode,
} from './reconciliation-writer-production.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import type {
  TargetedIssueActionContext,
  TargetedNativeIssue,
  TargetedOpenPullRequest,
} from './targeted-action-reader.js';
import type { GitOid, HumanReason } from './types.js';
import type { AutopilotExecutionBackend } from './active-config.js';
import {
  makeLocalSessionExecutionBackend,
  type MarketplaceExecutionHandle,
} from './session-execution-backend.js';
import {
  makeMarketplaceSessionBackend,
  MARKETPLACE_AGENT_SOFT_DEADLINE_MS,
  MARKETPLACE_ADOPTION_RESERVE_MS,
  MARKETPLACE_EVALUATOR_SOFT_DEADLINE_MS,
  MARKETPLACE_VERDICT_ADOPTION_RESERVE_MS,
  type MarketplaceSessionBackend,
} from './marketplace-session-backend.js';
import {
  retiredDeliveryObserver,
  type MarketplaceSolutionObservation,
  type MarketplaceVerdictObservation,
} from './marketplace-delivery-observation.js';
import {
  makeProductionMarketplaceMutationAdoptionCoordinator,
  makeProductionMarketplaceVerificationPort,
} from './marketplace-mutation-adoption-production.js';
import type {
  ConfirmedMarketplaceReviewClaim,
  MarketplaceMutationAdoptionResult,
  MarketplaceReviewClaimPort,
} from './marketplace-mutation-adoption.js';
import {
  linkMarketplaceReviewAttemptToOriginTask,
} from './marketplace-mutation-manifest.js';
import {
  adoptProductionMarketplaceReview,
} from './marketplace-review-adoption-production.js';
import type {
  MarketplaceReviewAdoptionResult,
} from './marketplace-review-adoption.js';

export const AUTOPILOT_V2_REMOTE = 'jinn-autopilot-v2';

export interface ProductionActiveRuntimeOptions {
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly credentials: CredentialPool;
  readonly authorAllowlist: ReadonlySet<string>;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  /** Targeted reads backing the cycle-snapshot reconciliation writer. */
  readonly readPullRequestByNumber: (
    prNumber: number,
  ) => Promise<ReconciliationPullRequestNode | null>;
  readonly readProjectItemForReconciliation: (
    issueNumber: number,
  ) => Promise<ReconciliationProjectItemNode | null>;
  readonly readBranchHeadByName: (headRefName: string) => Promise<GitOid | null>;
  readonly readIssueByNumber: (issueNumber: number) => Promise<TargetedNativeIssue | null>;
  readonly readBlockedByIssueNumbers: (issueNumber: number) => Promise<readonly number[]>;
  readonly readOpenPullRequestsByIssue: (
    issueNumber: number,
  ) => Promise<readonly TargetedOpenPullRequest[]>;
  readonly readIssueActionContext: (
    issueNumber: number,
  ) => Promise<TargetedIssueActionContext>;
  readonly config: DispatcherConfig;
  readonly spawn: SpawnFn;
  readonly executionBackendKind?: AutopilotExecutionBackend;
  readonly marketplaceSolverNetManifestCid?: string;
  readonly marketplaceBackend?: MarketplaceSessionBackend;
  readonly marketplacePreflight?: () => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  readonly marketplaceRecovery?: () => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  readonly marketplaceVerificationPreflight?: () => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  /** Injectable exact-delivery observer for production recovery tests. */
  readonly marketplaceSolutionObserver?: (
    manifestPath: string,
  ) => Promise<MarketplaceSolutionObservation>;
  /** Injectable deterministic adoption boundary for production recovery tests. */
  readonly marketplaceMutationAdopter?: (input: {
    readonly observation: Extract<
      MarketplaceSolutionObservation,
      { readonly status: 'verified' }
    >;
    readonly reviewClaims: MarketplaceReviewClaimPort;
  }) => Promise<MarketplaceMutationAdoptionResult>;
  /** Injectable anchored claim authority for marketplace recovery tests. */
  readonly marketplaceReviewClaims?: MarketplaceReviewClaimPort;
  /** Injectable exact Verdict observer for production recovery tests. */
  readonly marketplaceVerdictObserver?: (
    originManifestPath: string,
    reviewManifestPath: string,
  ) => Promise<MarketplaceVerdictObservation>;
  /** Injectable deterministic review adoption boundary for recovery tests. */
  readonly marketplaceReviewAdopter?: (
    observation: Extract<
      MarketplaceVerdictObservation,
      { readonly status: 'verified' }
    >,
  ) => Promise<MarketplaceReviewAdoptionResult>;
  /** Injectable crash boundary for two-manifest marketplace recovery tests. */
  readonly marketplaceRecoveryBoundary?: (
    boundary: 'verdict-origin-exited' | 'verdict-review-exited',
  ) => Promise<void> | void;
  readonly caps: {
    readonly implementation: number;
    readonly review: number;
  };
  readonly implementationBackpressureThreshold: number;
  /**
   * jinn-mono#1883: canary safety knob (`JINN_AUTOPILOT_ONLY_ISSUES`),
   * parsed in scripts/run-autopilot-v2.ts and threaded through unchanged.
   * `undefined` is unrestricted — see active-runtime.ts.
   */
  readonly onlyIssues?: ReadonlySet<number>;
  readonly staleAfterMs: number;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly readCapabilityAttestation?: typeof readCapabilityAttestation;
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly remoteName?: string;
  /**
   * Injectable delay for the bounded post-win confirmation retries in
   * review-claim acquisition (replication-lag tolerance;
   * see `confirmReviewAcquisition` in review-executor.ts). Defaults to a
   * real `setTimeout`-based sleep.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newWorkPaused?: () => boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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
  | 'executionBackendKind'
  | 'marketplacePreflight'
  | 'marketplaceRecovery'
  | 'marketplaceVerificationPreflight'
  | 'staleAfterMs'
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
      if (options.executionBackendKind === 'marketplace') {
        const remoteDeadlineMs =
          MARKETPLACE_AGENT_SOFT_DEADLINE_MS
          + MARKETPLACE_ADOPTION_RESERVE_MS
          + MARKETPLACE_EVALUATOR_SOFT_DEADLINE_MS
          + MARKETPLACE_VERDICT_ADOPTION_RESERVE_MS;
        if (
          options.staleAfterMs !== undefined
          && options.staleAfterMs <= remoteDeadlineMs
        ) {
          throw new Error(
            'marketplace submission deadline must be shorter than V2 staleness',
          );
        }
        if (options.marketplacePreflight === undefined) {
          throw new Error('marketplace one-shot preflight is unavailable');
        }
        const marketplace = await options.marketplacePreflight();
        if (!marketplace.ok) {
          throw new Error(
            marketplace.detail ?? 'marketplace one-shot preflight failed',
          );
        }
        if (options.marketplaceRecovery === undefined) {
          throw new Error('marketplace attempt recovery is unavailable');
        }
        const recovery = await options.marketplaceRecovery();
        if (!recovery.ok) {
          throw new Error(
            recovery.detail ?? 'marketplace attempt recovery failed',
          );
        }
        if (options.marketplaceVerificationPreflight === undefined) {
          throw new Error(
            'marketplace immutable verification preflight is unavailable',
          );
        }
        const verification =
          await options.marketplaceVerificationPreflight();
        if (!verification.ok) {
          throw new Error(
            verification.detail
            ?? 'marketplace immutable verification preflight failed',
          );
        }
      } else if (options.config.runtime === 'hermes') {
        assertHermesBillingRoute(
          options.config.hermesModel,
          options.config.hermesProvider,
        );
        assertHermesRuntimeReady(options.config.hermesPythonPath);
      }
      if (
        options.executionBackendKind !== 'marketplace'
        && options.config.runtime === 'cursor'
      ) {
        assertCursorRuntimeReady(options.config.cursorBin);
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
  const sleep = options.sleep ?? defaultSleep;
  const remoteName = options.remoteName ?? AUTOPILOT_V2_REMOTE;
  const alive = options.isPidAlive ?? isPidAlive;
  const executionBackendKind = options.executionBackendKind ?? 'local';
  const marketplaceVerification =
    makeProductionMarketplaceVerificationPort(ambient);
  const implementationPreferred = selectCredential(
    options.credentials,
    { phase: 'implement' },
  );
  const implementationPreferredLogin = implementationPreferred.status === 'selected'
    ? implementationPreferred.login
    : options.credentials.logins()[0] ?? '';
  const marketplaceBackend = executionBackendKind === 'marketplace'
    ? options.marketplaceBackend ?? makeMarketplaceSessionBackend({
        runner,
        environment: ambient,
        now,
        ...(options.marketplaceSolverNetManifestCid === undefined
          ? {}
          : {
              solverNetManifestCid:
                options.marketplaceSolverNetManifestCid,
            }),
      })
    : undefined;
  const executionBackend = marketplaceBackend
    ?? makeLocalSessionExecutionBackend({
      config: options.config,
      credentials: options.credentials,
      ambientEnvironment: ambient,
      spawn: options.spawn,
      trackChild: (manifestPath, child) => {
        const trackable = child as TrackableAttemptChild;
        if (
          trackable.pid === undefined
          || typeof trackable.once !== 'function'
        ) {
          throw new Error('Production coordinator child is not trackable');
        }
        trackAttemptChild(manifestPath, trackable, { now });
      },
      isPidAlive: alive,
    });
  const sessionDeadline = () => new Date(
    now().getTime() + MARKETPLACE_AGENT_SOFT_DEADLINE_MS,
  ).toISOString();
  const receiptAuthors = options.credentials.logins();
  // One-swap R3b (issue #2494) retired the production observers with the
  // `jinn tasks observe-autopilot-delivery` verb they shelled out to. The
  // injected-observer seam below is unchanged (production-recovery tests still
  // drive it); the default is now a loud failure, and `autopilotExecutionBackend`
  // refuses to select this backend at all, so no run reaches it holding escrow.
  const observeSolution = options.marketplaceSolutionObserver
    ?? retiredDeliveryObserver('Solution');
  const observeVerdict = options.marketplaceVerdictObserver
    ?? retiredDeliveryObserver('Verdict');
  const confirmedReviewClaim = (
    manifest: ReturnType<typeof readAttemptManifest>,
  ): ConfirmedMarketplaceReviewClaim | undefined => {
    if (
      manifest.phase !== 'review'
      || manifest.prNumber === undefined
      || manifest.reviewGeneration === undefined
      || manifest.reviewRefOid === undefined
      || manifest.reviewApprovalPolicy === undefined
    ) {
      return undefined;
    }
    return {
      head: manifest.expectedHead as GitOid,
      generation: manifest.reviewGeneration,
      refOid: manifest.reviewRefOid as GitOid,
      attemptId: manifest.attemptId,
      manifest,
      reviewer: manifest.selectedLogin,
      approvalPolicy: manifest.reviewApprovalPolicy,
      state: 'active',
    };
  };
  const makeAnchoredReviewClaimPort = (): MarketplaceReviewClaimPort => {
    const reviewPort = makeProductionReviewActionPort({
      repositoryPath: options.repositoryPath,
      worktreeBase: options.worktreeBase,
      runnerId: options.runnerId,
      remoteName,
      readSnapshot: options.readSnapshot,
      runner,
      environment: ambient,
    });
    const recoverExact = async (
      prNumber: number,
      expectedHead: GitOid,
    ): Promise<ConfirmedMarketplaceReviewClaim | undefined> => {
      const candidate = await reviewPort.readCandidate(prNumber);
      if (
        candidate === null
        || candidate.head !== expectedHead
        || candidate.reviewRef === undefined
        || candidate.reviewRef.record.state !== 'active'
      ) {
        return undefined;
      }
      const attempts = listRunnerLiveAttempts(
        join(options.worktreeBase, 'v2'),
        options.runnerId,
        alive,
      );
      const exact = attempts.flatMap((attempt) => {
        if (
          attempt.phase !== 'review'
          || attempt.prNumber !== prNumber
          || attempt.expectedHead !== expectedHead
        ) {
          return [];
        }
        const claim = confirmedReviewClaim(attempt);
        return claim !== undefined
          && claim.refOid === candidate.reviewRef!.oid
          && claim.generation === candidate.reviewRef!.record.generation
          && claim.attemptId === candidate.reviewRef!.record.attempt
          && claim.reviewer.toLowerCase()
            === candidate.reviewRef!.record.reviewer.toLowerCase()
          ? [claim]
          : [];
      });
      if (exact.length > 1) {
        throw new Error('Multiple exact anchored review manifests are live');
      }
      return exact[0];
    };
    return {
      async release(claim) {
        const protocol = makeReviewSessionProtocol(
          makeProductionReviewSessionPort({
            runner,
            environment: {
              ...ambient,
              JINN_AUTOPILOT_SESSION_MANIFEST:
                claim.manifest.paths.manifest,
            },
            now,
          }),
        );
        const released = await protocol.release(claim.manifest);
        if (
          released.status === 'stale'
          || released.status === 'ambiguous'
        ) {
          throw new Error(
            `Anchored review claim release was ${released.status}`,
          );
        }
        markAttemptExited(claim.manifest.paths.manifest, now);
      },
      async acquireOrRecover(input) {
        const expectedHead = input.expectedHead;
        const recovered = await recoverExact(input.prNumber, expectedHead);
        if (recovered !== undefined) {
          const linked = linkMarketplaceReviewAttemptToOriginTask({
            originManifestPath: input.origin.manifestPath,
            reviewManifestPath: recovered.manifest.paths.manifest,
            reviewAttemptId: recovered.attemptId,
            expectedHead: recovered.head,
            reviewGeneration: recovered.generation,
            reviewRefOid: recovered.refOid,
            now,
          });
          return {
            status: 'confirmed',
            claim: confirmedReviewClaim(linked)!,
          };
        }
        const candidate = await reviewPort.readCandidate(input.prNumber);
        if (candidate === null || candidate.head !== expectedHead) {
          return {
            status: 'lost',
            detail: 'Pull request head changed before anchored review claim',
          };
        }
        if (
          candidate.humanHold
          || candidate.approvalPolicy === 'human-codeowner'
        ) {
          return {
            status: 'human',
            detail:
              candidate.humanHold
                ? 'Human authority is active on the review target'
                : 'Current-head CODEOWNER policy excludes marketplace v1',
          };
        }
        const result = await executeReviewAction({
          prNumber: input.prNumber,
          expectedHead,
        }, {
          ...reviewPort,
          credentials: options.credentials,
          ambientEnvironment: ambient,
          nextAttemptId: nextId,
          nextGeneration: nextId,
          runnerId: options.runnerId,
          now,
          sleep,
          staleAfterMs: options.staleAfterMs,
          executionBackendKind: 'marketplace',
          anchoredMarketplaceReview: true,
          receiptAuthors,
          escalateHuman: async ({ candidate: current, reason }) => {
            await escalateReview(
              { candidate: current, reason },
              options.credentials,
              await options.readSnapshot(),
            );
          },
        });
        if (result.status === 'spawned') {
          const claimed = await recoverExact(input.prNumber, expectedHead);
          if (
            claimed === undefined
            || claimed.attemptId !== result.attemptId
            || claimed.refOid !== result.reviewRefOid
            || claimed.generation !== result.generation
          ) {
            return {
              status: 'ambiguous',
              detail: 'Anchored review claim did not read back exactly',
            };
          }
          const linked = linkMarketplaceReviewAttemptToOriginTask({
            originManifestPath: input.origin.manifestPath,
            reviewManifestPath: claimed.manifest.paths.manifest,
            reviewAttemptId: claimed.attemptId,
            expectedHead: claimed.head,
            reviewGeneration: claimed.generation,
            reviewRefOid: claimed.refOid,
            now,
          });
          return {
            status: 'confirmed',
            claim: confirmedReviewClaim(linked)!,
          };
        }
        if (result.status === 'human') {
          return {
            status: 'human',
            detail: 'Anchored review claim entered Human authority',
          };
        }
        if (result.status === 'lost' || result.status === 'ambiguous') {
          return { status: result.status };
        }
        return {
          status: 'ineligible',
          detail:
            result.status === 'already-approved'
              ? 'Exact head is already terminally approved'
              : result.status === 'ineligible'
                ? result.detail
                : 'Anchored review claim did not converge',
        };
      },
    };
  };
  const recoverMarketplaceAttempts = options.marketplaceRecovery ?? (
    marketplaceBackend === undefined
      ? undefined
      : async () => {
          try {
            const attempts = listRunnerLiveAttempts(
              join(options.worktreeBase, 'v2'),
              options.runnerId,
              alive,
            );
            for (const listedAttempt of attempts) {
              // A preceding evaluator-leg recovery may have terminalized its
              // originating mutation attempt. Always refresh the manifest
              // before acting so recovery is independent of directory order.
              const attempt = readAttemptManifest(
                listedAttempt.paths.manifest,
              );
              if (attempt.processState === 'exited') continue;
              if (attempt.execution.backend !== 'marketplace') continue;
              // Review attempts represent the evaluator leg of their
              // originating Task. They must never submit or recover a second
              // marketplace Task.
              if (attempt.phase === 'review') {
                const originManifestPath =
                  attempt.execution.originManifestPath;
                if (originManifestPath === undefined) continue;
                const verdict = await observeVerdict(
                  originManifestPath,
                  attempt.paths.manifest,
                );
                if (verdict.status === 'contradiction') {
                  throw new Error(
                    `Marketplace Verdict delivery contradiction: `
                    + `${verdict.reason}: ${verdict.detail}`,
                  );
                }
                if (verdict.status === 'verified') {
                  const adoption = options.marketplaceReviewAdopter === undefined
                    ? await adoptProductionMarketplaceReview({
                        delivery: verdict.delivery,
                        runner,
                        environment: ambient,
                        now,
                      })
                    : await options.marketplaceReviewAdopter(verdict);
                  if (
                    adoption.status !== 'adopted'
                    && adoption.status !== 'rejected'
                  ) {
                    throw new Error(
                      'Marketplace Verdict adoption returned a non-terminal state',
                    );
                  }
                  const origin = readAttemptManifest(originManifestPath);
                  if (origin.processState === 'running') {
                    markAttemptExited(
                      originManifestPath,
                      now,
                      adoption.head,
                    );
                  }
                  await options.marketplaceRecoveryBoundary?.(
                    'verdict-origin-exited',
                  );
                  markAttemptExited(
                    attempt.paths.manifest,
                    now,
                    adoption.head,
                  );
                  await options.marketplaceRecoveryBoundary?.(
                    'verdict-review-exited',
                  );
                }
                continue;
              }
              let handle: MarketplaceExecutionHandle;
              if (attempt.processState === 'preparing') {
                handle = await marketplaceBackend.recoverPreparing(
                  attempt.paths.manifest,
                );
                markMarketplaceAttemptRunning(
                  attempt.paths.manifest,
                  handle,
                  now,
                );
              } else {
                const execution = attempt.execution;
                if (
                  execution.taskId === undefined
                  || execution.taskCid === undefined
                  || execution.deadline === undefined
                  || execution.requestFile === undefined
                ) {
                  throw new Error(
                    `Marketplace attempt ${attempt.attemptId} has no durable execution handle`,
                  );
                }
                handle = {
                  backend: 'marketplace',
                  taskId: execution.taskId,
                  taskCid: execution.taskCid,
                  deadline: execution.deadline,
                  requestFile: execution.requestFile,
                  ...(execution.creationTransactionHash === undefined
                    ? {}
                    : {
                        creationTransactionHash:
                          execution.creationTransactionHash,
                        creationBlockNumber: execution.creationBlockNumber!,
                      }),
                  ...(execution.solverNetManifestCid === undefined
                    ? {}
                    : {
                        solverNetManifestCid:
                          execution.solverNetManifestCid,
                      }),
                  ...(execution.attemptIndex === undefined
                    ? {}
                    : {
                        attemptIndex: execution.attemptIndex,
                        requestId: execution.requestId!,
                      }),
                };
              }
              if (
                attempt.execution.creationTransactionHash !== undefined
                && attempt.execution.creationBlockNumber !== undefined
              ) {
                if (
                  attempt.execution.adoptionReceiptState?.disposition
                    === 'rejected'
                ) {
                  const reviewManifestPath =
                    attempt.execution.adoptionReceiptState.reviewManifestPath;
                  if (reviewManifestPath !== undefined) {
                    const reviewManifest =
                      readAttemptManifest(reviewManifestPath);
                    if (reviewManifest.processState === 'running') {
                      const claim = confirmedReviewClaim(reviewManifest);
                      if (claim === undefined) {
                        throw new Error(
                          'Rejected Solution has an invalid linked review attempt',
                        );
                      }
                      await (
                        options.marketplaceReviewClaims
                        ?? makeAnchoredReviewClaimPort()
                      ).release(claim);
                      markAttemptExited(
                        reviewManifestPath,
                        now,
                        reviewManifest.expectedHead,
                      );
                    }
                  }
                  markAttemptExited(attempt.paths.manifest, now);
                  continue;
                }
                if (
                  attempt.execution.adoptionReceiptState?.disposition
                    === 'accepted'
                ) {
                  const reviewManifestPath =
                    attempt.execution.adoptionReceiptState.reviewManifestPath;
                  if (
                    reviewManifestPath === undefined
                    || readAttemptManifest(reviewManifestPath).processState
                      === 'exited'
                  ) {
                    throw new Error(
                      'Accepted Solution has no live evaluator-leg attempt',
                    );
                  }
                  continue;
                }
                const delivery = await observeSolution(attempt.paths.manifest);
                if (delivery.status === 'contradiction') {
                  throw new Error(
                    `Marketplace Solution delivery contradiction: `
                    + `${delivery.reason}: ${delivery.detail}`,
                  );
                }
                if (delivery.status === 'verified') {
                  const reviewClaims =
                    options.marketplaceReviewClaims
                    ?? makeAnchoredReviewClaimPort();
                  const adoption = options.marketplaceMutationAdopter === undefined
                    ? await makeProductionMarketplaceMutationAdoptionCoordinator({
                        originManifestPath: attempt.paths.manifest,
                        session: delivery.delivery.session,
                        delivery: delivery.delivery,
                        repositoryPath: options.repositoryPath,
                        worktreeBase: options.worktreeBase,
                        runnerId: options.runnerId,
                        readSnapshot: options.readSnapshot,
                        reviewClaims,
                        runner,
                        environment: ambient,
                        now,
                        verification: marketplaceVerification,
                      }).adopt(delivery.reference)
                    : await options.marketplaceMutationAdopter({
                        observation: delivery,
                        reviewClaims,
                      });
                  if (adoption.status === 'recoverable') {
                    throw new Error(
                      `Marketplace Solution adoption is recoverable at `
                      + `${adoption.stage}: ${adoption.detail}`,
                    );
                  }
                  if (adoption.status === 'rejected') {
                    markAttemptExited(attempt.paths.manifest, now);
                  }
                  continue;
                }
              }
              const observation = await marketplaceBackend.recover(handle);
              if (observation.state === 'completed') {
                markAttemptExited(attempt.paths.manifest, now);
                continue;
              }
              // Preparing recovery rewrites updatedAt, so only the immutable
              // attempt origin may anchor the V2 stale handoff.
              if (
                (
                  observation.state === 'failed'
                  || observation.state === 'cancelled'
                )
                && now().getTime()
                  - Date.parse(attempt.timestamps.createdAt)
                  >= options.staleAfterMs
              ) {
                markAttemptExited(attempt.paths.manifest, now);
              }
            }
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        }
  );
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
    cycleSnapshot: GitHubLifecycleSnapshot,
  ): Promise<void> => {
    const selection = selectCredential(credentials, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error(selection.detail);
    const writer = makeProductionReconciliationWriter({
      repositoryPath: options.repositoryPath,
      cycleSnapshot,
      readPullRequestByNumber: options.readPullRequestByNumber,
      readProjectItemForReconciliation: options.readProjectItemForReconciliation,
      readBranchHeadByName: options.readBranchHeadByName,
      readIssueByNumber: options.readIssueByNumber,
      readBlockedByIssueNumbers: options.readBlockedByIssueNumbers,
      readOpenPullRequestsByIssue: options.readOpenPullRequestsByIssue,
      readIssueActionContext: options.readIssueActionContext,
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
    // Authority order: draft → hold label → marker comment.
    // Decision paths read label+marker; Status paint is painter-owned (Stage 3).
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
    await writer.ensureHumanComment(
      input.candidate.number,
      marker,
      `${marker}\n\n${input.reason.detail}`,
      input.candidate.head,
    );
    // Stage 3: Human Status paint is painter-owned; label+marker are authority.
  };

  return makeActiveRuntime({
    credentials: options.credentials,
    caps: options.caps,
    implementationPreferredLogin,
    implementationBackpressureThreshold:
      options.implementationBackpressureThreshold,
    ...(options.onlyIssues === undefined ? {} : { onlyIssues: options.onlyIssues }),
    readLocalAttempts: () => listRunnerLiveAttempts(
      join(options.worktreeBase, 'v2'),
      options.runnerId,
      alive,
    ),
    preflight: makeProductionCapabilityPreflight({
      ...options,
      executionBackendKind,
      marketplacePreflight: options.marketplacePreflight
        ?? marketplaceBackend?.preflight,
      marketplaceRecovery: recoverMarketplaceAttempts,
      marketplaceVerificationPreflight:
        options.marketplaceVerificationPreflight
        ?? marketplaceVerification.preflight,
    }),
    ...(options.newWorkPaused === undefined
      ? {}
      : { newWorkPaused: options.newWorkPaused }),
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
          executionBackendKind,
          executionBackend,
          sessionDeadline,
          receiptAuthors,
          persistExecutionHandle: (manifestPath, handle) => {
            if (handle.backend !== 'marketplace') return;
            markMarketplaceAttemptRunning(manifestPath, handle, now);
          },
        });
      },

      review: (action, credentials, cycleSnapshot) => {
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
        }, {
          ...port,
          credentials,
          ambientEnvironment: ambient,
          nextAttemptId: nextId,
          nextGeneration: nextId,
          runnerId: options.runnerId,
          now,
          sleep,
          staleAfterMs: options.staleAfterMs,
          executionBackendKind,
          executionBackend,
          sessionDeadline,
          receiptAuthors,
          escalateHuman: (input) => escalateReview(input, credentials, cycleSnapshot),
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

      updateBranch: async (action, credentials) => {
        const result = await executeUpdateBranchAction({
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
        });
        return {
          status: result.status,
          ...(result.status === 'ineligible' || result.status === 'rejected'
            ? { reason: result.reason }
            : {}),
        };
      },

      fileReconcileChild: async (action, credentials, cycleSnapshot) => {
        const result = await executeFileReconcileChildAction({
          prNumber: action.prNumber,
          expectedHead: action.head,
          effort: action.effort,
        }, {
          ...makeProductionMergeActionPort({
            readSnapshot: options.readSnapshot,
            authorAllowlist: options.authorAllowlist,
            runner,
            environment: ambient,
          }),
          credentials,
        });
        if (result.status === 'runaway-hold') {
          await escalateReview({
            candidate: {
              issueNumber: action.issueNumber,
              number: action.prNumber,
              head: action.head,
            },
            reason: {
              phase: 'merge-ready',
              code: 'runaway-child',
              detail:
                `Runaway child guard: ${result.priorCount} prior reconcile children `
                + `on PR #${action.prNumber}; parking for Human.`,
            },
          }, credentials, cycleSnapshot);
          return { status: 'human', detail: 'runaway-child-hold' };
        }
        return {
          status: result.status,
          ...(result.status === 'ineligible'
            ? { reason: result.reason }
            : { detail: `child:${result.childNumber}` }),
        };
      },

      rerunFailedChecks: async (action, credentials) => {
        const selection = selectCredential(credentials, { phase: 'merge' });
        if (selection.status !== 'selected') {
          return { status: 'skipped', reason: 'credential-unavailable' };
        }
        return executeProductionRerunFailedChecks(
          { prNumber: action.prNumber, head: action.head },
          {
            readSnapshot: options.readSnapshot,
            repositoryPath: options.repositoryPath,
            runner,
            environment: ambient,
          },
          selection.credential,
        );
      },

      fileCiFailureChild: async (action, credentials, cycleSnapshot) => {
        const selection = selectCredential(credentials, { phase: 'merge' });
        if (selection.status !== 'selected') {
          return { status: 'skipped', reason: 'credential-unavailable' };
        }
        const result = await executeProductionFileCiFailureChild(
          { prNumber: action.prNumber, head: action.head },
          {
            readSnapshot: options.readSnapshot,
            repositoryPath: options.repositoryPath,
            runner,
            environment: ambient,
          },
          selection.credential,
        );
        if (result.status === 'runaway-hold') {
          await escalateReview({
            candidate: {
              issueNumber: action.issueNumber,
              number: action.prNumber,
              head: action.head,
            },
            reason: {
              phase: 'merge-ready',
              code: 'runaway-child',
              detail:
                `Runaway child guard: ${result.detail ?? 'unknown'} prior ci-failure children `
                + `on PR #${action.prNumber}; parking for Human.`,
            },
          }, credentials, cycleSnapshot);
          return { status: 'human', detail: 'runaway-child-hold' };
        }
        return result;
      },
    },
  });
}
