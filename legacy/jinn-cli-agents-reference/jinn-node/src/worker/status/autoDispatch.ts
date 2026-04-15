/**
 * Auto-dispatch: determine if parent needs to be auto-dispatched and call MCP dispatcher
 *
 * Also handles:
 * - Verification dispatch: when a job completes after having children and all children
 *   are integrated, it gets re-dispatched for verification before the parent is notified.
 * - Continuation dispatch: when a job completes but child code is not yet integrated,
 *   it gets re-dispatched to continue integration work.
 */

import { workerLogger } from '../../logging/index.js';
import { dispatchExistingJob } from '../../agent/mcp/tools/dispatch_existing_job.js';
import { withJobContext } from '../mcp/tools.js';
import { safeParseToolResponse } from '../tool_utils.js';
import type { FinalStatus, ParentDispatchDecision } from '../types.js';
import { fetchBranchDetails } from '../git/pr.js';
import type { ExtractedArtifact } from '../artifacts.js';
import { graphQLRequest } from '../../http/client.js';
import type { WorkerTelemetryService } from '../worker_telemetry.js';
import { serializeError } from '../logging/errors.js';
import { isChildIntegrated, batchFetchBranches } from '../git/integration.js';
import { fetchAllChildren } from '../prompt/providers/context/fetchChildren.js';
import { getMaxCycles, requestStop } from '../cycleControl.js';
import { claimParentDispatch } from '../control_api_client.js';
import { config } from '../../config/index.js';

/**
 * Get inherited environment variables for workstream-level config propagation.
 * This ensures venture-scoped JINN_JOB_* vars flow through the entire job hierarchy.
 */
export function getInheritedEnv(): Record<string, string> {
  const envJson = process.env.JINN_CTX_INHERITED_ENV;
  if (!envJson) return {};
  try {
    return JSON.parse(envJson);
  } catch {
    workerLogger.warn('Failed to parse JINN_CTX_INHERITED_ENV');
    return {};
  }
}

const DISPATCH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes - long enough for jobs to process
const MAX_VERIFICATION_ATTEMPTS = 3;
const MAX_PARENT_DISPATCHES = 5; // Max times a parent job def can be dispatched across all children

/**
 * Check if parent was already dispatched for this child JOB DEFINITION by querying on-chain state.
 * This survives worker restarts, unlike in-memory tracking.
 *
 * NOTE: We check by child JOB DEFINITION ID (not request ID) to ensure the parent is only
 * dispatched once per child job, regardless of how many times that child runs (initial,
 * verification, review, etc.).
 */
async function wasRecentlyDispatched(
  parentJobDefId: string,
  childJobDefId: string
): Promise<boolean> {
  try {
    const ponderUrl = config.services.ponderUrl;

    const response = await graphQLRequest<{
      requests: { items: Array<{ id: string; blockTimestamp: string }> }
    }>({
      url: ponderUrl,
      query: `query CheckRecentDispatch($jobDefId: String!, $sourceJobDefId: String!) {
        requests(
          where: {
            jobDefinitionId: $jobDefId,
            sourceJobDefinitionId: $sourceJobDefId
          },
          orderBy: "blockTimestamp",
          orderDirection: "desc",
          limit: 1
        ) {
          items {
            id
            blockTimestamp
          }
        }
      }`,
      variables: {
        jobDefId: parentJobDefId,
        sourceJobDefId: childJobDefId
      },
      context: { operation: 'checkRecentDispatch', parentJobDefId, childJobDefId }
    });

    const recentRequest = response?.requests?.items?.[0];
    if (!recentRequest) return false;

    const dispatchTime = Number(recentRequest.blockTimestamp) * 1000;
    const timeSince = Date.now() - dispatchTime;

    if (timeSince < DISPATCH_COOLDOWN_MS) {
      workerLogger.debug({
        parentJobDefId,
        childJobDefId,
        recentRequestId: recentRequest.id,
        timeSince
      }, 'Found recent dispatch from this child job');
      return true;
    }

    return false;
  } catch (error) {
    workerLogger.warn({ error: serializeError(error), parentJobDefId, childJobDefId }, 'Failed to check recent dispatch, allowing dispatch (fail-open)');
    return false;
  }
}

/**
 * Count total existing dispatches for a parent job definition.
 * Used to enforce MAX_PARENT_DISPATCHES and prevent unbounded cascade (blood rule #65).
 */
async function countExistingDispatches(parentJobDefId: string): Promise<number> {
  try {
    const ponderUrl = config.services.ponderUrl;
    const response = await graphQLRequest<{
      requests: { items: Array<{ id: string }> }
    }>({
      url: ponderUrl,
      query: `query CountParentDispatches($jobDefId: String!) {
        requests(
          where: { jobDefinitionId: $jobDefId },
          limit: 20
        ) {
          items { id }
        }
      }`,
      variables: { jobDefId: parentJobDefId },
      context: { operation: 'countParentDispatches', parentJobDefId }
    });
    return response?.requests?.items?.length ?? 0;
  } catch (error) {
    workerLogger.warn({ error: serializeError(error), parentJobDefId },
      'Failed to count existing dispatches - allowing dispatch (fail-open)');
    return 0;
  }
}

/**
 * Check if a job had children by querying Ponder
 */
async function jobHadChildren(jobDefinitionId: string): Promise<boolean> {
  try {
    const ponderUrl = config.services.ponderUrl;
    const response = await graphQLRequest<{
      jobDefinitions: { items: Array<{ id: string }> };
    }>({
      url: ponderUrl,
      query: `query CheckJobChildren($jobDefId: String!) {
        jobDefinitions(where: { sourceJobDefinitionId: $jobDefId }, limit: 1) {
          items { id }
        }
      }`,
      variables: { jobDefId: jobDefinitionId },
      context: { operation: 'checkJobChildren', jobDefinitionId }
    });

    return (response?.jobDefinitions?.items?.length ?? 0) > 0;
  } catch (error) {
    workerLogger.warn(
      { jobDefinitionId, error: serializeError(error) },
      'Failed to check if job had children, assuming no'
    );
    return false;
  }
}

/**
 * Structure for completed child with branch info
 */



/**
 * Determine if verification is required for this job
 * Returns verification decision with context
 */
export interface VerificationDecision {
  requiresVerification: boolean;
  isVerificationRun: boolean;
  verificationAttempt: number;
  /** Job needs to continue integrating children (not ready for verification yet) */
  needsContinuation?: boolean;
  reason: string;
}

/**
 * Get list of child jobs whose code is not yet integrated into parent branch
 */
async function getUnintegratedChildren(parentJobDefId: string): Promise<string[]> {
  const parentBranch = process.env.CODE_METADATA_BRANCH_NAME || 'main';

  // Fetch all children from Ponder
  const children = await fetchAllChildren(parentJobDefId);
  if (children.length === 0) return [];

  // Batch fetch branches for efficiency
  const branchNames = children.map(c => c.branchName).filter(Boolean) as string[];
  if (branchNames.length > 0) {
    batchFetchBranches(branchNames, parentBranch);
  }

  // Check each child's integration status
  const unintegrated = children
    .filter(c => c.branchName && !isChildIntegrated(c.branchName, parentBranch))
    .map(c => c.jobName || c.jobDefinitionId);

  if (unintegrated.length > 0) {
    workerLogger.info({
      parentJobDefId,
      unintegratedCount: unintegrated.length,
      unintegratedChildren: unintegrated.slice(0, 5)
    }, 'Found unintegrated children (code not yet merged)');
  }

  return unintegrated;
}

export async function shouldRequireVerification(
  finalStatus: FinalStatus | null,
  metadata: any
): Promise<VerificationDecision> {
  // Only check for COMPLETED status
  if (!finalStatus || finalStatus.status !== 'COMPLETED') {
    return {
      requiresVerification: false,
      isVerificationRun: false,
      verificationAttempt: 0,
      reason: 'Not a COMPLETED status'
    };
  }

  const additionalContext = metadata?.additionalContext;
  const isVerificationRun = additionalContext?.verificationRequired === true;
  const verificationAttempt = additionalContext?.verificationAttempt ?? 0;

  // If this is already a verification run, no further verification needed
  if (isVerificationRun) {
    return {
      requiresVerification: false,
      isVerificationRun: true,
      verificationAttempt,
      reason: 'Already a verification run'
    };
  }

  // Check if THIS job had children it dispatched
  // NOTE: completedChildRuns indicates children that completed and triggered re-dispatch of this job
  // This is the correct signal that this job reviewed completed children
  // DO NOT use hierarchy - that's the parent's context passed down, not this job's children
  const hadChildrenFromContext =
    (additionalContext?.completedChildRuns?.length ?? 0) > 0;

  // Also query Ponder to check if this job dispatched any children
  const jobDefinitionId = metadata?.jobDefinitionId;
  const hadChildrenFromQuery = jobDefinitionId ? await jobHadChildren(jobDefinitionId) : false;

  const hadChildren = hadChildrenFromContext || hadChildrenFromQuery;

  workerLogger.debug({
    jobDefinitionId,
    hadChildrenFromContext,
    hadChildrenFromQuery,
    hadChildren,
    completedChildRunsCount: additionalContext?.completedChildRuns?.length ?? 0,
  }, 'Verification check: did this job have children?');

  if (!hadChildren) {
    return {
      requiresVerification: false,
      isVerificationRun: false,
      verificationAttempt: 0,
      reason: 'Job had no children - direct execution, no verification needed'
    };
  }

  // Job had children - check if all children's CODE is integrated
  const unintegratedChildren = jobDefinitionId
    ? await getUnintegratedChildren(jobDefinitionId)
    : [];

  if (unintegratedChildren.length > 0) {
    // Children exist but code not integrated - need to continue integration
    workerLogger.info({
      jobDefinitionId,
      unintegratedCount: unintegratedChildren.length,
      unintegrated: unintegratedChildren.slice(0, 3)
    }, 'Children not yet integrated - deferring verification');

    return {
      requiresVerification: false,
      isVerificationRun: false,
      verificationAttempt: 0,
      needsContinuation: true,
      reason: `${unintegratedChildren.length} children not yet integrated`
    };
  }

  // All children integrated - ready for verification
  return {
    requiresVerification: true,
    isVerificationRun: false,
    verificationAttempt: 0,
    reason: 'Job completed with all children integrated - verification required'
  };
}

/**
 * Dispatch job for verification (re-dispatch self with verificationRequired flag)
 */
async function dispatchForVerification(
  metadata: any,
  requestId: string,
  telemetry?: WorkerTelemetryService
): Promise<boolean> {
  const jobDefinitionId = metadata?.jobDefinitionId;
  if (!jobDefinitionId) {
    workerLogger.error({ requestId }, 'Cannot dispatch for verification: missing jobDefinitionId');
    return false;
  }

  const additionalContext = metadata?.additionalContext ?? {};
  const currentAttempt = additionalContext?.verificationAttempt ?? 0;
  const nextAttempt = currentAttempt + 1;

  if (nextAttempt > MAX_VERIFICATION_ATTEMPTS) {
    workerLogger.error(
      { requestId, jobDefinitionId, attempts: nextAttempt },
      'Max verification attempts exceeded - job requires human review'
    );
    // Don't dispatch for verification, let it complete (will dispatch parent with unverified status)
    return false;
  }

  workerLogger.info(
    { requestId, jobDefinitionId, verificationAttempt: nextAttempt },
    'Dispatching job for verification'
  );

  if (telemetry) {
    telemetry.startPhase('verification_dispatch');
    telemetry.logCheckpoint('verification_dispatch', 'dispatching_for_verification', {
      jobDefinitionId,
      verificationAttempt: nextAttempt
    });
  }

  try {
    const lineageInfo = metadata?.lineage;
    const baseBranch =
      lineageInfo?.dispatcherBranchName ||
      lineageInfo?.dispatcherBaseBranch ||
      metadata?.codeMetadata?.baseBranch ||
      metadata?.codeMetadata?.branch?.name ||
      undefined;
    const mechAddress = metadata?.workerAddress || metadata?.mech || undefined;

    // Query workstreamId from Ponder to preserve it during verification dispatch
    let workstreamId: string | undefined;
    try {
      const ponderUrl = config.services.ponderUrl;
      const response = await graphQLRequest<{ request: { workstreamId?: string } | null }>({
        url: ponderUrl,
        query: `query GetWorkstreamId($id: String!) {
          request(id: $id) {
            workstreamId
          }
        }`,
        variables: { id: requestId },
        context: { operation: 'getVerificationWorkstreamId', requestId }
      });
      workstreamId = response?.request?.workstreamId;
      if (workstreamId) {
        workerLogger.debug({ requestId, workstreamId }, 'Retrieved workstream ID for verification dispatch');
      }
    } catch (error) {
      workerLogger.warn({ requestId, error: serializeError(error) }, 'Failed to query workstream ID for verification, will proceed without it');
    }

    // Build verification context - preserve existing context and add verification flag
    // Include inherited env vars for workstream-level config propagation
    const verificationContext = {
      ...additionalContext,
      env: { ...getInheritedEnv(), ...(additionalContext?.env || {}) },
      verificationRequired: true,
      verificationAttempt: nextAttempt,
      verificationTriggeredAt: new Date().toISOString(),
      verificationSourceRequestId: requestId
    };

    const rawResult = await withJobContext(
      {
        requestId: lineageInfo?.parentDispatcherRequestId || undefined,
        jobDefinitionId,
        baseBranch,
        mechAddress,
        branchName: lineageInfo?.dispatcherBranchName || metadata?.codeMetadata?.branch?.name || undefined,
        workstreamId,
        ventureId: metadata?.ventureId || undefined,
      },
      async () =>
        dispatchExistingJob({
          jobId: jobDefinitionId,
          message: JSON.stringify({
            content: `Verification run ${nextAttempt}/${MAX_VERIFICATION_ATTEMPTS}: verify merged child work satisfies all assertions`,
            type: 'verification'
          }),
          workstreamId,
          additionalContext: verificationContext,
          // Use the job's own tools — don't override with browser_automation
          // (the chrome-devtools-mcp extension repo was deleted; verification
          //  should use the same toolset as the original job execution)
        })
    );

    const dispatchResult = safeParseToolResponse(rawResult);

    if (dispatchResult.ok) {
      if (telemetry) {
        telemetry.logCheckpoint('verification_dispatch', 'dispatch_success', {
          jobDefinitionId,
          verificationAttempt: nextAttempt,
          newRequestId: dispatchResult.data?.request_ids?.[0]
        });
      }
      workerLogger.info(
        {
          jobDefinitionId,
          verificationAttempt: nextAttempt,
          newRequestId: dispatchResult.data?.request_ids?.[0]
        },
        'Verification dispatch successful'
      );
      return true;
    } else {
      if (telemetry) {
        telemetry.logError('verification_dispatch', dispatchResult?.message || 'Unknown error');
      }
      workerLogger.error(
        { jobDefinitionId, error: dispatchResult?.message },
        'Failed to dispatch for verification'
      );
      return false;
    }
  } catch (error) {
    if (telemetry) {
      telemetry.logError('verification_dispatch', error instanceof Error ? error.message : String(error));
    }
    workerLogger.error(
      { jobDefinitionId, error: serializeError(error) },
      'Error dispatching for verification'
    );
    return false;
  } finally {
    if (telemetry) {
      telemetry.endPhase('verification_dispatch');
    }
  }
}

/**
 * Dispatch job for continuation (re-dispatch self to continue integrating children)
 * This is NOT a verification run - the job still has integration work to do.
 */
async function dispatchForContinuation(
  metadata: any,
  requestId: string,
  telemetry?: WorkerTelemetryService
): Promise<boolean> {
  const jobDefinitionId = metadata?.jobDefinitionId;
  if (!jobDefinitionId) {
    workerLogger.error({ requestId }, 'Cannot dispatch for continuation: missing jobDefinitionId');
    return false;
  }

  workerLogger.info(
    { requestId, jobDefinitionId },
    'Dispatching job for continuation (children not yet integrated)'
  );

  if (telemetry) {
    telemetry.startPhase('continuation_dispatch');
    telemetry.logCheckpoint('continuation_dispatch', 'dispatching_for_continuation', { jobDefinitionId });
  }

  try {
    const lineageInfo = metadata?.lineage;
    const baseBranch =
      lineageInfo?.dispatcherBranchName ||
      lineageInfo?.dispatcherBaseBranch ||
      metadata?.codeMetadata?.baseBranch ||
      undefined;
    const mechAddress = metadata?.workerAddress || metadata?.mech || undefined;

    // Query workstreamId from Ponder
    let workstreamId: string | undefined;
    try {
      const ponderUrl = config.services.ponderUrl;
      const response = await graphQLRequest<{ request: { workstreamId?: string } | null }>({
        url: ponderUrl,
        query: `query GetWorkstreamId($id: String!) { request(id: $id) { workstreamId } }`,
        variables: { id: requestId },
        context: { operation: 'getContinuationWorkstreamId', requestId }
      });
      workstreamId = response?.request?.workstreamId;
    } catch (error) {
      workerLogger.warn({ requestId, error: serializeError(error) }, 'Failed to query workstream ID for continuation');
    }

    const rawResult = await withJobContext(
      {
        requestId: lineageInfo?.parentDispatcherRequestId || undefined,
        jobDefinitionId,
        baseBranch,
        mechAddress,
        branchName: lineageInfo?.dispatcherBranchName || metadata?.codeMetadata?.branch?.name || undefined,
        workstreamId,
        ventureId: metadata?.ventureId || undefined,
      },
      async () =>
        dispatchExistingJob({
          jobId: jobDefinitionId,
          message: JSON.stringify({
            content: 'Continue integration: some children have unintegrated code',
            type: 'continuation'
          }),
          workstreamId,
          // Preserve existing context and include inherited env vars for workstream-level config propagation
          additionalContext: {
            ...metadata?.additionalContext,
            env: { ...getInheritedEnv(), ...(metadata?.additionalContext?.env || {}) }
          }
        })
    );

    const dispatchResult = safeParseToolResponse(rawResult);

    if (dispatchResult.ok) {
      if (telemetry) {
        telemetry.logCheckpoint('continuation_dispatch', 'dispatch_success', {
          jobDefinitionId,
          newRequestId: dispatchResult.data?.request_ids?.[0]
        });
      }
      workerLogger.info(
        { jobDefinitionId, newRequestId: dispatchResult.data?.request_ids?.[0] },
        'Continuation dispatch successful'
      );
      return true;
    } else {
      if (telemetry) {
        telemetry.logError('continuation_dispatch', dispatchResult?.message || 'Unknown error');
      }
      workerLogger.error({ jobDefinitionId, error: dispatchResult?.message }, 'Failed to dispatch for continuation');
      return false;
    }
  } catch (error) {
    if (telemetry) {
      telemetry.logError('continuation_dispatch', error instanceof Error ? error.message : String(error));
    }
    workerLogger.error({ jobDefinitionId, error: serializeError(error) }, 'Error dispatching for continuation');
    return false;
  } finally {
    if (telemetry) {
      telemetry.endPhase('continuation_dispatch');
    }
  }
}

const MAX_LOOP_RECOVERY_ATTEMPTS = 3;

/**
 * Dispatch job for a new cycle (re-dispatch cyclic job after completion)
 *
 * When a cyclic job completes (reaches terminal state with no parent to notify),
 * it gets re-dispatched to start a new cycle. The cycle provider will inject
 * invariants instructing the agent to reassess all JOB invariants.
 */
export async function dispatchForCycle(
  metadata: any,
  requestId: string,
  telemetry?: WorkerTelemetryService
): Promise<boolean> {
  const jobDefinitionId = metadata?.jobDefinitionId;
  if (!jobDefinitionId) {
    workerLogger.error({ requestId }, 'Cannot dispatch for cycle: missing jobDefinitionId');
    return false;
  }

  const additionalContext = metadata?.additionalContext ?? {};
  const currentCycleNumber = additionalContext?.cycle?.cycleNumber ?? 0;
  const nextCycleNumber = currentCycleNumber + 1;

  workerLogger.info(
    { requestId, jobDefinitionId, cycleNumber: nextCycleNumber },
    'Dispatching job for new cycle (cyclic operation)'
  );

  if (telemetry) {
    telemetry.startPhase('cycle_dispatch');
    telemetry.logCheckpoint('cycle_dispatch', 'dispatching_for_cycle', {
      jobDefinitionId,
      cycleNumber: nextCycleNumber
    });
  }

  try {
    const lineageInfo = metadata?.lineage;
    const baseBranch =
      lineageInfo?.dispatcherBranchName ||
      lineageInfo?.dispatcherBaseBranch ||
      metadata?.codeMetadata?.baseBranch ||
      metadata?.codeMetadata?.branch?.name ||
      undefined;
    const mechAddress = metadata?.workerAddress || metadata?.mech || undefined;

    // Query workstreamId from Ponder
    let workstreamId: string | undefined;
    try {
      const ponderUrl = config.services.ponderUrl;
      const response = await graphQLRequest<{ request: { workstreamId?: string } | null }>({
        url: ponderUrl,
        query: `query GetWorkstreamId($id: String!) { request(id: $id) { workstreamId } }`,
        variables: { id: requestId },
        context: { operation: 'getCycleWorkstreamId', requestId }
      });
      workstreamId = response?.request?.workstreamId;
    } catch (error) {
      workerLogger.warn({ requestId, error: serializeError(error) }, 'Failed to query workstream ID for cycle dispatch');
    }

    // Build cycle context - preserve existing context and add cycle info
    // Include inherited env vars for workstream-level config propagation
    const cycleContext = {
      ...additionalContext,
      env: { ...getInheritedEnv(), ...(additionalContext?.env || {}) },
      cycle: {
        isCycleRun: true,
        cycleNumber: nextCycleNumber,
        previousCycleCompletedAt: new Date().toISOString(),
        previousCycleRequestId: requestId,
      },
      // Clear any verification/loop recovery flags from previous cycle
      verificationRequired: undefined,
      verificationAttempt: undefined,
      loopRecovery: undefined,
    };

    const rawResult = await withJobContext(
      {
        requestId: lineageInfo?.parentDispatcherRequestId || undefined,
        jobDefinitionId,
        baseBranch,
        mechAddress,
        branchName: lineageInfo?.dispatcherBranchName || metadata?.codeMetadata?.branch?.name || undefined,
        workstreamId,
        ventureId: metadata?.ventureId || undefined,
      },
      async () =>
        dispatchExistingJob({
          jobId: jobDefinitionId,
          message: JSON.stringify({
            content: `Cycle ${nextCycleNumber}: Reassess all invariants and dispatch work as needed.`,
            type: 'cycle',
            cycleNumber: nextCycleNumber,
          }),
          workstreamId,
          additionalContext: cycleContext,
        })
    );

    const dispatchResult = safeParseToolResponse(rawResult);

    if (dispatchResult.ok) {
      if (telemetry) {
        telemetry.logCheckpoint('cycle_dispatch', 'dispatch_success', {
          jobDefinitionId,
          newRequestId: dispatchResult.data?.request_ids?.[0],
          cycleNumber: nextCycleNumber,
        });
      }
      workerLogger.info(
        { jobDefinitionId, newRequestId: dispatchResult.data?.request_ids?.[0], cycleNumber: nextCycleNumber },
        'Cycle dispatch successful'
      );
      return true;
    } else {
      if (telemetry) {
        telemetry.logError('cycle_dispatch', dispatchResult?.message || 'Unknown error');
      }
      workerLogger.error({ jobDefinitionId, error: dispatchResult?.message }, 'Failed to dispatch for cycle');
      return false;
    }
  } catch (error) {
    if (telemetry) {
      telemetry.logError('cycle_dispatch', error instanceof Error ? error.message : String(error));
    }
    workerLogger.error({ jobDefinitionId, error: serializeError(error) }, 'Error dispatching for cycle');
    return false;
  } finally {
    if (telemetry) {
      telemetry.endPhase('cycle_dispatch');
    }
  }
}

/**
 * Dispatch job for loop recovery (re-dispatch self after loop termination)
 * 
 * When a job is terminated by loop protection, we re-dispatch it with context
 * about what caused the loop so the agent can take a different approach.
 */
export async function dispatchForLoopRecovery(
  metadata: any,
  requestId: string,
  loopMessage: string,
  telemetry?: WorkerTelemetryService
): Promise<boolean> {
  const jobDefinitionId = metadata?.jobDefinitionId;
  if (!jobDefinitionId) {
    workerLogger.error({ requestId }, 'Cannot dispatch for loop recovery: missing jobDefinitionId');
    return false;
  }

  const additionalContext = metadata?.additionalContext ?? {};
  const currentAttempt = additionalContext?.loopRecovery?.attempt ?? 0;
  const nextAttempt = currentAttempt + 1;

  if (nextAttempt > MAX_LOOP_RECOVERY_ATTEMPTS) {
    workerLogger.error(
      { requestId, jobDefinitionId, attempts: nextAttempt },
      'Max loop recovery attempts exceeded - job requires human review'
    );
    // Don't dispatch for recovery, let it fail permanently
    return false;
  }

  workerLogger.info(
    { requestId, jobDefinitionId, loopRecoveryAttempt: nextAttempt },
    'Dispatching job for loop recovery'
  );

  if (telemetry) {
    telemetry.startPhase('loop_recovery_dispatch');
    telemetry.logCheckpoint('loop_recovery_dispatch', 'dispatching_for_loop_recovery', {
      jobDefinitionId,
      loopRecoveryAttempt: nextAttempt
    });
  }

  try {
    const lineageInfo = metadata?.lineage;
    const baseBranch =
      lineageInfo?.dispatcherBranchName ||
      lineageInfo?.dispatcherBaseBranch ||
      metadata?.codeMetadata?.baseBranch ||
      metadata?.codeMetadata?.branch?.name ||
      undefined;
    const mechAddress = metadata?.workerAddress || metadata?.mech || undefined;

    // Query workstreamId from Ponder
    let workstreamId: string | undefined;
    try {
      const ponderUrl = config.services.ponderUrl;
      const response = await graphQLRequest<{ request: { workstreamId?: string } | null }>({
        url: ponderUrl,
        query: `query GetWorkstreamId($id: String!) { request(id: $id) { workstreamId } }`,
        variables: { id: requestId },
        context: { operation: 'getLoopRecoveryWorkstreamId', requestId }
      });
      workstreamId = response?.request?.workstreamId;
    } catch (error) {
      workerLogger.warn({ requestId, error: serializeError(error) }, 'Failed to query workstream ID for loop recovery');
    }

    // Build loop recovery context - preserve existing context and add loop info
    // Include inherited env vars for workstream-level config propagation
    const loopRecoveryContext = {
      ...additionalContext,
      env: { ...getInheritedEnv(), ...(additionalContext?.env || {}) },
      loopRecovery: {
        attempt: nextAttempt,
        loopMessage,
        triggeredAt: new Date().toISOString(),
        previousRequestId: requestId,
      },
      // Clear verification flags if any (loop recovery is a fresh attempt)
      verificationRequired: undefined,
      verificationAttempt: undefined,
    };

    const rawResult = await withJobContext(
      {
        requestId: lineageInfo?.parentDispatcherRequestId || undefined,
        jobDefinitionId,
        baseBranch,
        mechAddress,
        branchName: lineageInfo?.dispatcherBranchName || metadata?.codeMetadata?.branch?.name || undefined,
        workstreamId,
        ventureId: metadata?.ventureId || undefined,
      },
      async () =>
        dispatchExistingJob({
          jobId: jobDefinitionId,
          message: JSON.stringify({
            content: `Loop recovery: Previous run terminated due to unproductive loop. Approach task differently.`,
            type: 'loop_recovery',
            loopMessage: loopMessage.slice(0, 500), // Truncate for message field
          }),
          workstreamId,
          additionalContext: loopRecoveryContext,
        })
    );

    const dispatchResult = safeParseToolResponse(rawResult);

    if (dispatchResult.ok) {
      if (telemetry) {
        telemetry.logCheckpoint('loop_recovery_dispatch', 'dispatch_success', {
          jobDefinitionId,
          newRequestId: dispatchResult.data?.request_ids?.[0],
          loopRecoveryAttempt: nextAttempt,
        });
      }
      workerLogger.info(
        { jobDefinitionId, newRequestId: dispatchResult.data?.request_ids?.[0], loopRecoveryAttempt: nextAttempt },
        'Loop recovery dispatch successful'
      );
      return true;
    } else {
      if (telemetry) {
        telemetry.logError('loop_recovery_dispatch', dispatchResult?.message || 'Unknown error');
      }
      workerLogger.error({ jobDefinitionId, error: dispatchResult?.message }, 'Failed to dispatch for loop recovery');
      return false;
    }
  } catch (error) {
    if (telemetry) {
      telemetry.logError('loop_recovery_dispatch', error instanceof Error ? error.message : String(error));
    }
    workerLogger.error({ jobDefinitionId, error: serializeError(error) }, 'Error dispatching for loop recovery');
    return false;
  } finally {
    if (telemetry) {
      telemetry.endPhase('loop_recovery_dispatch');
    }
  }
}

/**
 * Dispatch job for timeout recovery (re-dispatch self after process timeout)
 *
 * When a job is terminated due to process timeout (15 min), we re-dispatch it with context
 * so the system can track retry attempts. Fewer retries than loop recovery since timeout
 * is often a systemic issue (API downtime, network issues).
 */
const MAX_TIMEOUT_RECOVERY_ATTEMPTS = 2;

export async function dispatchForTimeoutRecovery(
  metadata: any,
  requestId: string,
  timeoutMessage: string,
  telemetry?: WorkerTelemetryService
): Promise<boolean> {
  const jobDefinitionId = metadata?.jobDefinitionId;
  if (!jobDefinitionId) {
    workerLogger.error({ requestId }, 'Cannot dispatch for timeout recovery: missing jobDefinitionId');
    return false;
  }

  const additionalContext = metadata?.additionalContext ?? {};
  const currentAttempt = additionalContext?.timeoutRecovery?.attempt ?? 0;
  const nextAttempt = currentAttempt + 1;

  if (nextAttempt > MAX_TIMEOUT_RECOVERY_ATTEMPTS) {
    workerLogger.error(
      { requestId, jobDefinitionId, attempts: nextAttempt },
      'Max timeout recovery attempts exceeded - job requires human review'
    );
    // Don't dispatch for recovery, let it fail permanently
    return false;
  }

  workerLogger.info(
    { requestId, jobDefinitionId, timeoutRecoveryAttempt: nextAttempt },
    'Dispatching job for timeout recovery'
  );

  if (telemetry) {
    telemetry.startPhase('timeout_recovery_dispatch');
    telemetry.logCheckpoint('timeout_recovery_dispatch', 'dispatching_for_timeout_recovery', {
      jobDefinitionId,
      timeoutRecoveryAttempt: nextAttempt
    });
  }

  try {
    const lineageInfo = metadata?.lineage;
    const baseBranch =
      lineageInfo?.dispatcherBranchName ||
      lineageInfo?.dispatcherBaseBranch ||
      metadata?.codeMetadata?.baseBranch ||
      metadata?.codeMetadata?.branch?.name ||
      undefined;
    const mechAddress = metadata?.workerAddress || metadata?.mech || undefined;

    // Query workstreamId from Ponder
    let workstreamId: string | undefined;
    try {
      const ponderUrl = config.services.ponderUrl;
      const response = await graphQLRequest<{ request: { workstreamId?: string } | null }>({
        url: ponderUrl,
        query: `query GetWorkstreamId($id: String!) { request(id: $id) { workstreamId } }`,
        variables: { id: requestId },
        context: { operation: 'getTimeoutRecoveryWorkstreamId', requestId }
      });
      workstreamId = response?.request?.workstreamId;
    } catch (error) {
      workerLogger.warn({ requestId, error: serializeError(error) }, 'Failed to query workstream ID for timeout recovery');
    }

    // Build timeout recovery context - preserve existing context and add timeout info
    // Include inherited env vars for workstream-level config propagation
    const timeoutRecoveryContext = {
      ...additionalContext,
      env: { ...getInheritedEnv(), ...(additionalContext?.env || {}) },
      timeoutRecovery: {
        attempt: nextAttempt,
        timeoutMessage,
        triggeredAt: new Date().toISOString(),
        previousRequestId: requestId,
      },
      // Clear verification flags if any (timeout recovery is a fresh attempt)
      verificationRequired: undefined,
      verificationAttempt: undefined,
    };

    const rawResult = await withJobContext(
      {
        requestId: lineageInfo?.parentDispatcherRequestId || undefined,
        jobDefinitionId,
        baseBranch,
        mechAddress,
        branchName: lineageInfo?.dispatcherBranchName || metadata?.codeMetadata?.branch?.name || undefined,
        workstreamId,
        ventureId: metadata?.ventureId || undefined,
      },
      async () =>
        dispatchExistingJob({
          jobId: jobDefinitionId,
          message: JSON.stringify({
            content: `Timeout recovery: Previous run timed out after 15 minutes. Retrying.`,
            type: 'timeout_recovery',
            timeoutMessage: timeoutMessage.slice(0, 500), // Truncate for message field
          }),
          workstreamId,
          additionalContext: timeoutRecoveryContext,
        })
    );

    const dispatchResult = safeParseToolResponse(rawResult);

    if (dispatchResult.ok) {
      if (telemetry) {
        telemetry.logCheckpoint('timeout_recovery_dispatch', 'dispatch_success', {
          jobDefinitionId,
          newRequestId: dispatchResult.data?.request_ids?.[0],
          timeoutRecoveryAttempt: nextAttempt,
        });
      }
      workerLogger.info(
        { jobDefinitionId, newRequestId: dispatchResult.data?.request_ids?.[0], timeoutRecoveryAttempt: nextAttempt },
        'Timeout recovery dispatch successful'
      );
      return true;
    } else {
      if (telemetry) {
        telemetry.logError('timeout_recovery_dispatch', dispatchResult?.message || 'Unknown error');
      }
      workerLogger.error({ jobDefinitionId, error: dispatchResult?.message }, 'Failed to dispatch for timeout recovery');
      return false;
    }
  } catch (error) {
    if (telemetry) {
      telemetry.logError('timeout_recovery_dispatch', error instanceof Error ? error.message : String(error));
    }
    workerLogger.error({ jobDefinitionId, error: serializeError(error) }, 'Error dispatching for timeout recovery');
    return false;
  } finally {
    if (telemetry) {
      telemetry.endPhase('timeout_recovery_dispatch');
    }
  }
}

// Ponder indexing lag tolerance: poll up to N times before deciding children are incomplete
// Reduced from 10x1000ms since we now self-exclude from sibling check (only need to wait for near-simultaneous siblings)
const PONDER_INDEX_POLL_COUNT = config.services.ponderIndexPollCount;
const PONDER_INDEX_POLL_DELAY_MS = config.services.ponderIndexPollDelayMs;

/**
 * Determine if parent should be dispatched
 */
export async function shouldDispatchParent(
  finalStatus: FinalStatus | null,
  metadata: any
): Promise<ParentDispatchDecision> {
  // Only dispatch on terminal states
  if (!finalStatus || (finalStatus.status !== 'COMPLETED' && finalStatus.status !== 'FAILED')) {
    workerLogger.warn(
      {
        finalStatus: finalStatus?.status,
        hasMetadata: !!metadata,
        sourceJobDefinitionId: metadata?.sourceJobDefinitionId,
      },
      '[PARENT_DISPATCH_DECISION] Not dispatching - status not terminal',
    );
    return {
      shouldDispatch: false,
      reason: `Status is not terminal: ${finalStatus?.status || 'none'}`,
    };
  }
  // Get parent job definition ID
  // First try metadata, but it may be wrong/missing for verification runs
  let parentJobDefId = metadata?.sourceJobDefinitionId;
  const jobDefinitionId = metadata?.jobDefinitionId;

  // If parentJobDefId is missing or equals current job (self-referential from verification dispatch),
  // query Ponder for the authoritative parent relationship
  const wasSelfReferential = parentJobDefId === jobDefinitionId;
  if ((!parentJobDefId || wasSelfReferential) && jobDefinitionId) {
    try {
      const ponderUrl = config.services.ponderUrl;
      const response = await graphQLRequest<{ jobDefinition: { sourceJobDefinitionId: string | null } | null }>({
        url: ponderUrl,
        query: `query GetJobDefParent($id: String!) { jobDefinition(id: $id) { sourceJobDefinitionId } }`,
        variables: { id: jobDefinitionId },
        context: { operation: 'getJobDefParent', jobDefinitionId }
      });
      const ponderParent = response?.jobDefinition?.sourceJobDefinitionId;
      if (ponderParent) {
        workerLogger.info({ jobDefinitionId, ponderParent, metadataParent: parentJobDefId },
          'Using authoritative parent from Ponder (metadata was missing/self-referential)');
        parentJobDefId = ponderParent;
      } else if (wasSelfReferential) {
        // Ponder returned null AND we had a self-referential parent - this is a ROOT JOB
        // Clear the self-referential value to prevent self-dispatch loop
        workerLogger.info({ jobDefinitionId, metadataParent: parentJobDefId },
          'Ponder confirms no parent (root job) - clearing self-referential metadata');
        parentJobDefId = undefined;
      }
    } catch (error) {
      workerLogger.warn({ jobDefinitionId, error: serializeError(error) },
        'Failed to query Ponder for parent job definition');
    }
  }

  if (!parentJobDefId) {
    workerLogger.warn(
      {
        finalStatus: finalStatus.status,
        hasMetadata: !!metadata,
        jobDefinitionId,
      },
      '[PARENT_DISPATCH_DECISION] Not dispatching - no parent job in metadata or Ponder',
    );
    return {
      shouldDispatch: false,
      reason: 'No parent job in metadata or Ponder',
    };
  }

  // Check if ALL direct children of the parent are complete
  // Poll Ponder multiple times to allow for indexing lag
  try {
    const ponderUrl = config.services.ponderUrl;

    // Query all job definitions that have this parent
    const childrenQuery = `query GetParentChildren($parentJobDefId: String!) {
      jobDefinitions(where: { sourceJobDefinitionId: $parentJobDefId }) {
        items {
          id
          name
          lastStatus
        }
      }
    }`;

    let children: Array<{ id: string; name: string; lastStatus: string }> = [];
    let incompleteChildren: typeof children = [];

    for (let poll = 0; poll < PONDER_INDEX_POLL_COUNT; poll++) {
      const childrenData = await graphQLRequest<{
        jobDefinitions: { items: Array<{ id: string; name: string; lastStatus: string }> };
      }>({
        url: ponderUrl,
        query: childrenQuery,
        variables: { parentJobDefId },
        context: { operation: 'checkParentChildrenComplete', parentJobDefId, poll }
      });

      children = childrenData?.jobDefinitions?.items || [];

      if (children.length === 0) {
        // No children found, allow parent dispatch (this shouldn't happen in normal flow)
        workerLogger.debug({ parentJobDefId }, 'No children found for parent, allowing dispatch');
        return { shouldDispatch: true, parentJobDefId };
      }

      // Check if all children are in terminal state (COMPLETED or FAILED)
      // IMPORTANT: Exclude ourselves from this check - we know we're terminal (we passed the check at line 664)
      // but Ponder may not have indexed our status yet due to indexing lag
      incompleteChildren = children.filter(
        child => child.id !== jobDefinitionId &&
          child.lastStatus !== 'COMPLETED' &&
          child.lastStatus !== 'FAILED'
      );

      if (incompleteChildren.length === 0) {
        // All children complete - exit poll loop
        break;
      }

      // Still have incomplete children - wait and poll again (unless this is last poll)
      if (poll < PONDER_INDEX_POLL_COUNT - 1) {
        workerLogger.debug({
          parentJobDefId,
          poll: poll + 1,
          maxPolls: PONDER_INDEX_POLL_COUNT,
          incompleteCount: incompleteChildren.length
        }, 'Waiting for Ponder to index child status...');
        await new Promise(r => setTimeout(r, PONDER_INDEX_POLL_DELAY_MS));
      }
    }

    if (incompleteChildren.length > 0) {
      const incompleteNames = incompleteChildren
        .map(c => `${c.name} (${c.lastStatus})`)
        .slice(0, 3)
        .join(', ');

      workerLogger.info({
        parentJobDefId,
        totalChildren: children.length,
        incompleteChildren: incompleteChildren.length,
        examples: incompleteNames,
        pollsAttempted: PONDER_INDEX_POLL_COUNT
      }, 'Parent dispatch blocked - waiting for all children to complete (after polling)');

      return {
        shouldDispatch: false,
        reason: `Waiting for ${incompleteChildren.length} children to complete: ${incompleteNames}`,
      };
    }

    // All children complete
    workerLogger.info(
      {
        parentJobDefId,
        totalChildren: children.length,
      },
      'All children complete - will dispatch parent',
    );

    return {
      shouldDispatch: true,
      parentJobDefId,
    };
  } catch (error) {
    workerLogger.warn(
      {
        parentJobDefId,
        error: serializeError(error),
      },
      '[PARENT_DISPATCH_DECISION] Failed to check children completion status - blocking parent dispatch for safety',
    );

    return {
      shouldDispatch: false,
      reason: 'Failed to verify children completion status',
    };
  }
}

/**
 * Dispatch parent job when child completes or fails (Work Protocol)
 *
 * This function also handles verification dispatch:
 * - If a job completes after having children (review phase), it gets re-dispatched
 *   for verification before the parent is notified.
 * - Only after verification passes (or max attempts exceeded) does the parent get dispatched.
 */
export async function dispatchParentIfNeeded(
  finalStatus: FinalStatus | null,
  metadata: any,
  requestId: string,
  output: string,
  options?: {
    telemetry?: WorkerTelemetryService;
    artifacts?: ExtractedArtifact[];
  }
): Promise<void> {
  // First, check if this job needs verification before we can dispatch parent
  const verificationDecision = await shouldRequireVerification(finalStatus, metadata);

  workerLogger.debug({
    requestId,
    verificationDecision: {
      requiresVerification: verificationDecision.requiresVerification,
      isVerificationRun: verificationDecision.isVerificationRun,
      verificationAttempt: verificationDecision.verificationAttempt,
      needsContinuation: verificationDecision.needsContinuation,
      reason: verificationDecision.reason
    }
  }, 'Verification decision for job');

  // If this was a verification run that completed without delegating further,
  // we should now dispatch the parent. The verification is done.
  // NOTE: The loop prevention is handled by shouldRequireVerification returning
  // requiresVerification: false for verification runs (line 149-156).
  if (verificationDecision.isVerificationRun) {
    workerLogger.info(
      { requestId, jobDefinitionId: metadata?.jobDefinitionId, verificationAttempt: verificationDecision.verificationAttempt },
      'Verification run completed - proceeding to parent dispatch check'
    );
    // Continue to shouldDispatchParent check below
  }

  // Check if job needs to continue integrating children (code not yet merged)
  if (verificationDecision.needsContinuation) {
    workerLogger.info(
      { requestId, jobDefinitionId: metadata?.jobDefinitionId },
      'Job completed but children not integrated - dispatching for continuation'
    );

    const dispatched = await dispatchForContinuation(metadata, requestId, options?.telemetry);
    if (dispatched) {
      // Continuation dispatch succeeded - don't dispatch parent yet
      return;
    }
    // If continuation dispatch failed, fall through to dispatch parent
    // (better to signal completion than to hang)
    workerLogger.warn(
      { requestId },
      'Continuation dispatch failed - proceeding with parent dispatch'
    );
  }

  if (verificationDecision.requiresVerification) {
    // Job completed after reviewing children - dispatch for verification instead of parent
    workerLogger.info(
      { requestId, jobDefinitionId: metadata?.jobDefinitionId },
      'Job completed after review - dispatching for verification before parent dispatch'
    );

    const dispatched = await dispatchForVerification(metadata, requestId, options?.telemetry);
    if (dispatched) {
      // Verification dispatch succeeded - don't dispatch parent yet
      return;
    }
    // If verification dispatch failed, fall through to dispatch parent
    // (better to complete with unverified work than to hang)
    workerLogger.warn(
      { requestId },
      'Verification dispatch failed - proceeding with parent dispatch'
    );
  }

  const decision = await shouldDispatchParent(finalStatus, metadata);

  if (!decision.shouldDispatch) {
    // Check if this is a root job that should cycle
    // Only cycle if:
    // 1. No parent exists (this is the root)
    // 2. Job is marked as cyclic
    // 3. Job completed successfully (not failed)
    const isRootJob = decision.reason === 'No parent job in metadata or Ponder';
    const isCyclic = metadata?.cyclic === true;
    const isCompleted = finalStatus?.status === 'COMPLETED';

    if (isRootJob && isCyclic && isCompleted) {
      const maxCycles = getMaxCycles();
      const completedCycleNumber = (metadata?.additionalContext?.cycle?.cycleNumber ?? 0) + 1;

      if (maxCycles !== undefined && completedCycleNumber >= maxCycles) {
        const stopRequested = requestStop();
        workerLogger.info(
          {
            requestId,
            jobDefinitionId: metadata?.jobDefinitionId,
            maxCycles,
            completedCycleNumber,
            stopRequested,
          },
          'Max cycles reached - skipping cycle redispatch'
        );
        return;
      }

      workerLogger.info(
        { requestId, jobDefinitionId: metadata?.jobDefinitionId },
        'Root cyclic job completed - dispatching for new cycle'
      );

      const dispatched = await dispatchForCycle(metadata, requestId, options?.telemetry);
      if (dispatched) {
        return;
      }
      // If cycle dispatch failed, log but don't error - job still completed
      workerLogger.warn(
        { requestId },
        'Cycle dispatch failed - job will not continue cycling'
      );
    }

    workerLogger.debug(
      { requestId, decision, isCyclic, isRootJob },
      'Not dispatching parent - decision criteria not met',
    );
    return;
  }

  const parentJobDefId = decision.parentJobDefId!;

  const childJobDefId = metadata?.jobDefinitionId;

  // Check if any sibling has already dispatched the parent using atomic Control API claim
  // This prevents race conditions where Ponder indexing lag causes duplicates
  let alreadyClaimed = false;
  let claimingSibling: string | undefined;

  try {
    if (childJobDefId) {
      const claim = await claimParentDispatch(parentJobDefId, childJobDefId);
      if (!claim.allowed) {
        alreadyClaimed = true;
        claimingSibling = claim.claimed_by;
      }
    }
  } catch (error) {
    // If Control API fails, we fail OPEN (allow dispatch) but log warning
    // This maintains system liveness if Control API is down, though risks duplicates
    // But since Control API is now critical for dedupe, we might want to reconsider this policy
    // For now, mirroring old behavior: warn and proceed
    workerLogger.warn({
      parentJobDefId,
      childJobDefId,
      error: serializeError(error)
    }, 'Failed to check parent dispatch claim via Control API - proceeding (risk of duplicates)');
  }

  if (alreadyClaimed) {
    workerLogger.info({
      parentJobDefId,
      childJobDefId,
      claimingSibling
    }, 'Skipping parent dispatch (already claimed by sibling via atomic check)');
    return;
  }

  // Guard 1: Cooldown - skip if parent was recently dispatched by this child's job def
  if (childJobDefId) {
    const recentlyDispatched = await wasRecentlyDispatched(parentJobDefId, childJobDefId);
    if (recentlyDispatched) {
      workerLogger.info({
        parentJobDefId,
        childJobDefId,
        cooldownMs: DISPATCH_COOLDOWN_MS,
      }, 'Skipping parent dispatch (cooldown - recently dispatched from this child job def)');
      return;
    }
  }

  // Guard 2: Max total dispatches - prevent unbounded cascade (blood rule #65)
  const existingCount = await countExistingDispatches(parentJobDefId);
  if (existingCount >= MAX_PARENT_DISPATCHES) {
    workerLogger.warn({
      parentJobDefId,
      childJobDefId,
      existingCount,
      max: MAX_PARENT_DISPATCHES,
    }, 'Skipping parent dispatch (max total dispatches reached for this parent job def)');
    return;
  }

  let workstreamId: string | undefined;
  try {
    const ponderUrl = config.services.ponderUrl;
    const response = await graphQLRequest<{ request: { workstreamId?: string } | null }>({
      url: ponderUrl,
      query: `query GetWorkstreamId($id: String!) {
        request(id: $id) {
          workstreamId
        }
      }`,
      variables: { id: requestId },
      context: { operation: 'getChildWorkstreamId', requestId }
    });
    workstreamId = response?.request?.workstreamId;
    if (workstreamId) {
      workerLogger.debug({ requestId, workstreamId }, 'Retrieved workstream ID from child request');
    }
  } catch (error) {
    workerLogger.warn({ requestId, error: serializeError(error) }, 'Failed to query child workstream ID, will proceed without it');
  }

  const telemetry = options?.telemetry;
  if (telemetry) {
    telemetry.startPhase('parent_dispatch');
    telemetry.logCheckpoint('parent_dispatch', 'dispatching_parent', {
      parentJobDefId,
      childRequestId: requestId,
      childStatus: finalStatus!.status,
      workstreamId,
      reason: 'child_terminal_state'
    });
  }

  try {
    const lineageInfo = metadata?.lineage;
    if (!lineageInfo) {
      throw new Error('Lineage metadata missing from job; cannot auto-dispatch parent');
    }

    const lineageRequestId = lineageInfo.parentDispatcherRequestId || undefined;
    const baseBranch =
      lineageInfo.dispatcherBranchName ||
      lineageInfo.dispatcherBaseBranch ||
      metadata?.codeMetadata?.baseBranch ||
      metadata?.codeMetadata?.branch?.name ||
      undefined;
    const mechAddress = metadata?.workerAddress || metadata?.mech || undefined;

    const messageContent = `Child job ${finalStatus!.status}: ${finalStatus!.message}. Output: ${output.length > 500 ? output.substring(0, 500) + '...' : output}`;

    const message = {
      content: messageContent,
      to: parentJobDefId,
      from: requestId
    };

    workerLogger.info({
      parentJobDefId,
      childRequestId: requestId,
      message
    }, '[PARENT_DISPATCH_DEBUG] Preparing to dispatch parent with message');

    const maxRetries = 3;
    let dispatchResult: ReturnType<typeof safeParseToolResponse> | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.pow(2, attempt) * 2000;
        workerLogger.info({ parentJobDefId, attempt, backoffMs }, 'Retrying parent dispatch');
        await new Promise(r => setTimeout(r, backoffMs));
      }

      try {
        const rawResult = await withJobContext(
          {
            requestId: lineageRequestId,
            jobDefinitionId: parentJobDefId,
            baseBranch,
            mechAddress,
            branchName: lineageInfo.dispatcherBranchName || undefined,
            ventureId: metadata?.ventureId || undefined,
          },
          async () =>
            dispatchExistingJob({
              jobId: parentJobDefId,
              message: JSON.stringify(message),
              workstreamId,
              // Include inherited env vars for workstream-level config propagation
              additionalContext: { env: getInheritedEnv() }
            })
        );

        dispatchResult = safeParseToolResponse(rawResult);

        workerLogger.info({
          parentJobDefId,
          ok: dispatchResult.ok,
          data: dispatchResult.data
        }, '[PARENT_DISPATCH_DEBUG] Dispatch result');

        if (dispatchResult.ok) {
          break;
        }

        // Check for transient blockchain errors that warrant retry
        if (dispatchResult.message?.includes('Transaction not found') || dispatchResult.message?.includes('timeout')) {
          workerLogger.warn({ parentJobDefId, error: dispatchResult.message }, 'Parent dispatch transient failure');
          continue;
        }

        break;
      } catch (e) {
        workerLogger.warn({ parentJobDefId, error: serializeError(e) }, 'Parent dispatch execution error');
        if (attempt < maxRetries - 1) continue;
      }
    }

    if (dispatchResult?.ok) {
      if (telemetry) {
        telemetry.logCheckpoint('parent_dispatch', 'dispatch_success', {
          parentJobDefId,
          childRequestId: requestId,
          newRequestId: dispatchResult.data?.request_ids?.[0]
        });
      }
      workerLogger.info({
        parentJobDefId,
        childRequestId: requestId,
        newRequestId: dispatchResult.data?.request_ids?.[0]
      }, `Parent job ${parentJobDefId} dispatched successfully`);
    } else {
      if (telemetry) {
        telemetry.logError('parent_dispatch', dispatchResult?.message || 'Unknown error');
      }
      workerLogger.error({
        parentJobDefId,
        childRequestId: requestId,
        error: dispatchResult?.message
      }, `Failed to dispatch parent job ${parentJobDefId}: ${dispatchResult?.message}`);
    }
  } catch (e) {
    if (telemetry) {
      telemetry.logError('parent_dispatch', e instanceof Error ? e.message : String(e));
    }
    workerLogger.error({ error: serializeError(e), parentJobDefId }, `Error dispatching parent job ${parentJobDefId}`);
    throw e;  // Propagate Work Protocol failure
  } finally {
    if (telemetry) {
      telemetry.endPhase('parent_dispatch');
    }
  }
}
