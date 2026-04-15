/**
 * Status inference: pure function to infer final status from telemetry and child jobs
 */

import { getChildJobStatus, getAllChildrenForJobDefinition, type JobLevelChildStatusResult } from './childJobs.js';
import { countSuccessfulDispatchCalls } from './dispatchUtils.js';
import { workerLogger } from '../../logging/index.js';
import { serializeError } from '../logging/errors.js';
import type { FinalStatus, IpfsMetadata, HierarchyJob } from '../types.js';

/**
 * Extract child job statuses from hierarchy for job-level completeness checking
 */
function extractChildrenFromHierarchy(
  hierarchy: HierarchyJob[] | undefined,
  currentJobDefinitionId: string | undefined
): { active: HierarchyJob[]; failed: HierarchyJob[]; completed: HierarchyJob[] } {
  const result = { active: [] as HierarchyJob[], failed: [] as HierarchyJob[], completed: [] as HierarchyJob[] };
  
  if (!hierarchy || !Array.isArray(hierarchy) || !currentJobDefinitionId) {
    return result;
  }

  // Find descendants of the current job definition
  const children = hierarchy.filter(
    (job) => job.level && job.level > 0 && job.sourceJobDefinitionId === currentJobDefinitionId
  );

  for (const child of children) {
    const status = (child.status || '').toLowerCase();
    
    if (status === 'completed' || status === 'delivered' || status === 'success') {
      result.completed.push(child);
    } else if (status === 'failed' || status === 'error') {
      result.failed.push(child);
    } else {
      // Everything else is active (waiting, pending, etc.)
      result.active.push(child);
    }
  }

  return result;
}

/**
 * Infer job status from observable execution signals.
 *
 * Job-centric rule: A job is COMPLETED only if all its children (across all runs) are complete.
 * - FAILED: Error occurred
 * - DELEGATING: Dispatched children this run
 * - WAITING: Has undelivered/failed children (job-level view)
 * - COMPLETED: No outstanding children (either never delegated, or all delivered)
 */
export async function inferJobStatus(params: {
  requestId: string;
  error: any;
  telemetry: any;
  delegatedThisRun?: boolean;
  metadata?: IpfsMetadata;
}): Promise<FinalStatus> {
  const { requestId, error, telemetry, delegatedThisRun, metadata } = params;

  // 1. FAILED: Execution error
  if (error) {
    const errorMessage = serializeError(error);
    return {
      status: 'FAILED',
      message: `Job failed: ${errorMessage}`
    };
  }

  // 2. DELEGATING: Dispatched children this run
  const dispatchCalls = countSuccessfulDispatchCalls(telemetry);
  if (delegatedThisRun || dispatchCalls > 0) {
    return {
      status: 'DELEGATING',
      message: dispatchCalls > 0
        ? `Dispatched ${dispatchCalls} child job(s)`
        : 'Dispatched child job(s) this run',
    };
  }

  // 3. Check for undelivered children - ALWAYS query live from Ponder first
  const hierarchy = metadata?.additionalContext?.hierarchy;
  const jobDefinitionId = metadata?.jobDefinitionId;

  // ============================================================
  // NEW: Query live child status from Ponder (single source of truth)
  // ============================================================
  let liveChildStatus: JobLevelChildStatusResult | null = null;
  if (jobDefinitionId) {
    try {
      liveChildStatus = await getAllChildrenForJobDefinition(jobDefinitionId);
      
      workerLogger.info({
        requestId,
        jobDefinitionId,
        totalChildren: liveChildStatus.totalChildren,
        undeliveredChildren: liveChildStatus.undeliveredChildren,
        queryDuration_ms: liveChildStatus.queryDuration_ms,
        allChildrenDetails: liveChildStatus.allChildren.map(c => ({
          id: c.id,
          delivered: c.delivered,
          fromRequestId: c.requestId
        }))
      }, '[STATUS_INFERENCE] Live Ponder query for all children across all runs');
    } catch (error) {
      workerLogger.warn({
        requestId,
        jobDefinitionId,
        error: serializeError(error)
      }, '[STATUS_INFERENCE] Failed to query live child status, will use hierarchy fallback');
    }
  }

  if (hierarchy && jobDefinitionId) {
    // ============================================================
    // Logging: show hierarchy data we're about to use
    // ============================================================
    workerLogger.info({
      requestId,
      jobDefinitionId,
      hierarchyPresent: true,
      hierarchyLength: hierarchy.length,
      hierarchyJobIds: hierarchy.map(h => h.jobId || h.id).filter(Boolean)
    }, '[STATUS_INFERENCE] Hierarchy data available in metadata');
    
    const children = extractChildrenFromHierarchy(hierarchy, jobDefinitionId);
    
    workerLogger.info({
      requestId,
      jobDefinitionId,
      activeChildren: children.active.map(c => ({
        id: c.id || c.jobId,
        name: c.name || c.jobName,
        status: c.status,
        level: c.level
      })),
      activeChildrenCount: children.active.length,
      completedChildrenCount: children.completed.length,
      failedChildrenCount: children.failed.length
    }, '[STATUS_INFERENCE] Extracted children from hierarchy (snapshot data)');
    
    // ============================================================
    // NEW: Compare hierarchy vs live data and make decision
    // ============================================================
    if (liveChildStatus) {
      workerLogger.info({
        requestId,
        jobDefinitionId,
        comparison: {
          hierarchyActive: children.active.length,
          hierarchyCompleted: children.completed.length,
          hierarchyFailed: children.failed.length,
          liveTotal: liveChildStatus.totalChildren,
          liveUndelivered: liveChildStatus.undeliveredChildren,
          liveDelivered: liveChildStatus.totalChildren - liveChildStatus.undeliveredChildren,
          discrepancy: children.active.length !== liveChildStatus.undeliveredChildren
        }
      }, '[STATUS_INFERENCE] Comparison: hierarchy snapshot vs live Ponder query');
      
      // ============================================================
      // DECISION: Always use live data when available
      // ============================================================
      if (liveChildStatus.undeliveredChildren > 0) {
        workerLogger.info({
          requestId,
          jobDefinitionId,
          decision: 'WAITING',
          reason: 'live_query_shows_undelivered_children',
          undeliveredCount: liveChildStatus.undeliveredChildren,
          undeliveredIds: liveChildStatus.allChildren
            .filter(c => !c.delivered)
            .map(c => c.id)
        }, '[STATUS_INFERENCE] DECISION: Using live query result → WAITING');
        
        return {
          status: 'WAITING',
          message: `Waiting for ${liveChildStatus.undeliveredChildren} child job(s) to deliver (live query)`
        };
      }
      
      // Check for active children (delivered but still DELEGATING/WAITING)
      // A child that delivered with non-terminal status means work is still in progress
      if (liveChildStatus.activeChildren > 0) {
        const activeChildDetails = liveChildStatus.allChildren
          .filter(c => c.delivered && c.jobStatus && (c.jobStatus === 'DELEGATING' || c.jobStatus === 'WAITING'))
          .map(c => ({ id: c.id, status: c.jobStatus }));
        
        workerLogger.info({
          requestId,
          jobDefinitionId,
          decision: 'WAITING',
          reason: 'children_delivered_but_still_delegating',
          activeChildrenCount: liveChildStatus.activeChildren,
          activeChildren: activeChildDetails
        }, '[STATUS_INFERENCE] DECISION: Children delivered but have non-terminal status → WAITING');
        
        return {
          status: 'WAITING',
          message: `Waiting for ${liveChildStatus.activeChildren} child job(s) with non-terminal status (DELEGATING/WAITING) to complete`
        };
      }
      
      workerLogger.info({
        requestId,
        jobDefinitionId,
        decision: 'COMPLETED',
        reason: 'live_query_shows_all_children_complete',
        totalChildren: liveChildStatus.totalChildren
      }, '[STATUS_INFERENCE] DECISION: Using live query result → COMPLETED');
      
      return {
        status: 'COMPLETED',
        message: liveChildStatus.totalChildren > 0
          ? `All ${liveChildStatus.totalChildren} child job(s) complete (delivered with terminal status)`
          : 'Job completed direct work'
      };
    }
    
    // ============================================================
    // Fallback: Use hierarchy if live query failed
    // ============================================================
    workerLogger.warn({
      requestId,
      jobDefinitionId,
      reason: 'live_query_failed_using_hierarchy'
    }, '[STATUS_INFERENCE] Falling back to hierarchy snapshot');
    
    // Block completion if there are failed children (require remediation)
    if (children.failed.length > 0) {
      const failedJobNames = children.failed
        .map(j => j.jobName || j.name || 'unknown')
        .slice(0, 3)
        .join(', ');
      return {
        status: 'WAITING',
        message: `${children.failed.length} child job(s) failed and need remediation: ${failedJobNames}`
      };
    }

    // Block completion if there are active children
    if (children.active.length > 0) {
      return {
        status: 'WAITING',
        message: `Waiting for ${children.active.length} active child job(s) to complete`
      };
    }

    // All children completed or none exist
    const completionReason = children.completed.length > 0
      ? `All ${children.completed.length} child job(s) completed`
      : 'Job completed direct work';

    return {
      status: 'COMPLETED',
      message: completionReason
    };
  }

  // 4. Fallback: Use legacy per-request child checking (for older runs without hierarchy)
  const childJobResult = await getChildJobStatus(requestId);
  const childJobs = childJobResult.childJobs || [];
  const undeliveredChildren = childJobs.filter(c => !c.delivered);

  if (undeliveredChildren.length > 0) {
    return {
      status: 'WAITING',
      message: `Waiting for ${undeliveredChildren.length} child job(s) to deliver`
    };
  }

  // COMPLETED: No undelivered children
  const completionReason = childJobs.length > 0
    ? `All ${childJobs.length} child job(s) delivered`
    : 'Job completed direct work';

  return {
    status: 'COMPLETED',
    message: completionReason
  };
}

