/**
 * MCP Tool: inspect_workstream
 *
 * Inspect a workstream execution graph. Returns job tree, aggregated stats,
 * and optional detailed sections (errors, dispatch chain, git activity, metrics, timing, tool analytics).
 */

import { z } from 'zod';
import {
  queryPonder,
  fetchIpfsContentMcp,
  mcpSuccess,
  mcpValidationError,
  mcpNotFound,
  mcpExecutionError,
  extractErrorsFromTelemetry,
  extractGitOpsFromTelemetry,
  extractTimingMetrics,
  extractTokenMetrics,
  extractInvariantMetrics,
  extractToolMetricsFromTelemetry,
  detectDispatchType,
  parseDispatchMessage,
  aggregateErrorsByPattern,
  aggregateTimingMetrics,
  aggregateToolMetrics,
  computeDepth,
  type ErrorSummary,
  type GitOperationSummary,
  type TimingMetrics,
  type TokenMetrics,
  type InvariantMetrics,
  type DispatchType,
  type AggregatedTimingMetrics,
  type AggregatedToolMetrics,
  type WorkerTelemetryLog,
  type ToolMetrics,
} from './shared/inspection-utils.js';
import {
  composeSinglePageResponse,
  encodeCursor,
  decodeCursor,
  type TruncationPolicy,
} from './shared/context-management.js';
import { getCurrentJobContext } from './shared/context.js';

// --- Schema ---

const sectionEnum = z.enum(['errors', 'dispatch', 'git', 'metrics', 'timing', 'tools']);

export const inspectWorkstreamParams = z.object({
  workstream_id: z.string().min(1).describe('The workstream ID to inspect. Use "current" to inspect the agent\'s current workstream.'),
  status: z.enum(['all', 'failed', 'pending', 'completed']).optional().default('all').describe('Filter jobs by status'),
  job_name: z.string().optional().describe('Filter by job name pattern (case-insensitive substring match)'),
  limit: z.number().int().min(1).max(200).optional().default(50).describe('Maximum number of jobs to include'),
  sections: z.array(sectionEnum).optional().default(['errors', 'timing']).describe('Data sections to include in response'),
  depth: z.number().int().min(0).max(10).optional().describe('Maximum hierarchy depth to include'),
  cursor: z.string().optional().describe('Pagination cursor'),
});

export type InspectWorkstreamParams = z.infer<typeof inspectWorkstreamParams>;

export const inspectWorkstreamSchema = {
  description: 'Inspect a workstream execution graph. Returns job tree, aggregated stats, and optional detailed sections (errors, dispatch chain, git activity, metrics, timing, tool analytics). Use "current" for workstream_id to inspect your own workstream.',
  inputSchema: inspectWorkstreamParams.shape,
};

// --- GraphQL Queries ---

const GET_WORKSTREAM_REQUESTS_QUERY = `
  query GetWorkstreamRequests($workstreamId: String!, $limit: Int!) {
    requests(
      where: { workstreamId: $workstreamId }
      orderBy: "blockTimestamp"
      orderDirection: "asc"
      limit: $limit
    ) {
      items {
        id
        jobName
        jobDefinitionId
        sourceRequestId
        sourceJobDefinitionId
        delivered
        deliveryIpfsHash
        blockTimestamp
        ipfsHash
      }
    }
  }
`;

const GET_ARTIFACTS_QUERY = `
  query GetWorkstreamArtifacts($workstreamId: String!, $limit: Int!) {
    artifacts(
      where: { workstreamId: $workstreamId }
      limit: $limit
    ) {
      items {
        id
        requestId
        name
        topic
        cid
        type
      }
    }
  }
`;

// --- Types ---

interface RequestData {
  id: string;
  jobName?: string;
  jobDefinitionId?: string;
  sourceRequestId?: string;
  sourceJobDefinitionId?: string;
  delivered: boolean;
  deliveryIpfsHash?: string;
  blockTimestamp?: string;
  ipfsHash?: string;
}

interface ArtifactData {
  id: string;
  requestId: string;
  name: string;
  topic: string;
  cid: string;
  type?: string;
}

interface WorkstreamStats {
  uniqueJobs: number;
  totalJobRuns: number;
  completedRuns: number;
  failedRuns: number;
  pendingRuns: number;
  totalArtifacts: number;
}

interface JobNode {
  requestId: string;
  jobName?: string;
  jobDefinitionId?: string;
  status: string;
  depth: number;
  childCount: number;
}

interface DispatchChainEntry {
  requestId: string;
  jobName?: string;
  depth: number;
  dispatchType: DispatchType;
  dispatchReason?: string;
  status: string;
}

interface GitSummary {
  totalBranches: number;
  pushedBranches: number;
  conflicts: Array<{ branch: string; files: string[] }>;
}

interface MetricsSummary {
  tokenUsage: { total: number; byJob: Array<{ requestId: string; jobName?: string; tokens: number }> };
  invariants: { totalMeasured: number; totalPassed: number; totalFailed: number; unmeasuredJobs: number };
  toolCalls: { total: number; failures: number };
}

interface InspectWorkstreamResult {
  workstreamId: string;
  stats: WorkstreamStats;
  jobs: JobNode[];
  errors?: {
    total: number;
    byPhase: Record<string, number>;
    topErrors: Array<{ pattern: string; count: number; phase: string }>;
  };
  dispatchChain?: DispatchChainEntry[];
  gitSummary?: GitSummary;
  metrics?: MetricsSummary;
  timing?: AggregatedTimingMetrics;
  tools?: AggregatedToolMetrics;
  drillDownIds?: {
    failedJobs: string[];
    slowestJobs: string[];
  };
}

// --- Handler ---

export async function inspectWorkstream(params: unknown) {
  // Validate input
  const parsed = inspectWorkstreamParams.safeParse(params);
  if (!parsed.success) {
    return mcpValidationError(parsed.error.message);
  }

  let { workstream_id, status, job_name, limit, sections, depth, cursor } = parsed.data;

  // Handle "current" workstream resolution
  if (workstream_id === 'current') {
    const ctx = getCurrentJobContext();
    if (!ctx.workstreamId) {
      return mcpValidationError('No current workstream context. Provide an explicit workstream_id.');
    }
    workstream_id = ctx.workstreamId;
  }

  const includeSections = new Set(sections);

  try {
    // Decode pagination cursor
    const keyset = decodeCursor<{ offset: number }>(cursor) ?? { offset: 0 };
    const fetchLimit = limit + keyset.offset;

    // Fetch all requests in workstream
    const requestsResult = await queryPonder<{ requests: { items: RequestData[] } }>(
      GET_WORKSTREAM_REQUESTS_QUERY,
      { workstreamId: workstream_id, limit: fetchLimit + 50 } // Extra for filtering
    );

    if (requestsResult.error) {
      return mcpExecutionError(`Failed to query workstream: ${requestsResult.error}`);
    }

    const allRequests = requestsResult.data?.requests.items || [];

    if (allRequests.length === 0) {
      return mcpNotFound('Workstream', workstream_id);
    }

    // Build request map for depth calculation
    const requestMap = new Map<string, { sourceRequestId?: string }>();
    for (const req of allRequests) {
      requestMap.set(req.id, { sourceRequestId: req.sourceRequestId });
    }

    // Find root (first request, or one with no sourceRequestId)
    const rootId = allRequests.find((r) => !r.sourceRequestId)?.id || allRequests[0].id;

    // Apply filters
    let filteredRequests = allRequests;

    // Status filter
    if (status !== 'all') {
      filteredRequests = filteredRequests.filter((r) => {
        if (status === 'completed') return r.delivered;
        if (status === 'pending') return !r.delivered;
        // For 'failed', we need delivery content - approximate with delivered but will refine
        return true;
      });
    }

    // Job name filter (case-insensitive substring)
    if (job_name) {
      const pattern = job_name.toLowerCase();
      filteredRequests = filteredRequests.filter(
        (r) => r.jobName && r.jobName.toLowerCase().includes(pattern)
      );
    }

    // Depth filter
    if (depth !== undefined) {
      filteredRequests = filteredRequests.filter((r) => {
        const d = computeDepth(requestMap, r.id, rootId);
        return d <= depth;
      });
    }

    // Apply pagination
    const paginatedRequests = filteredRequests.slice(keyset.offset, keyset.offset + limit);

    // Build stats
    const uniqueJobDefs = new Set(allRequests.map((r) => r.jobDefinitionId).filter(Boolean));
    const stats: WorkstreamStats = {
      uniqueJobs: uniqueJobDefs.size,
      totalJobRuns: allRequests.length,
      completedRuns: allRequests.filter((r) => r.delivered).length,
      failedRuns: 0, // Will be updated
      pendingRuns: allRequests.filter((r) => !r.delivered).length,
      totalArtifacts: 0,
    };

    // Fetch artifacts count
    const artifactsResult = await queryPonder<{ artifacts: { items: ArtifactData[] } }>(
      GET_ARTIFACTS_QUERY,
      { workstreamId: workstream_id, limit: 500 }
    );
    const artifacts = artifactsResult.data?.artifacts.items || [];
    stats.totalArtifacts = artifacts.length;

    // Build artifact map for telemetry lookup
    const artifactsByRequest = new Map<string, ArtifactData[]>();
    for (const art of artifacts) {
      if (!artifactsByRequest.has(art.requestId)) {
        artifactsByRequest.set(art.requestId, []);
      }
      artifactsByRequest.get(art.requestId)!.push(art);
    }

    // Build job nodes
    const jobs: JobNode[] = [];
    const allErrors: ErrorSummary[] = [];
    const allGitOps: GitOperationSummary[] = [];
    const allTimingMetrics: TimingMetrics[] = [];
    const allTokenMetrics: TokenMetrics[] = [];
    const allInvariantMetrics: InvariantMetrics[] = [];
    const allToolMetrics: ToolMetrics[] = [];
    const dispatchChain: DispatchChainEntry[] = [];
    const failedJobs: string[] = [];

    for (const req of paginatedRequests) {
      const reqDepth = computeDepth(requestMap, req.id, rootId);

      // Count children
      const childCount = allRequests.filter((r) => r.sourceRequestId === req.id).length;

      let jobStatus = req.delivered ? 'COMPLETED' : 'PENDING';

      // Fetch telemetry if needed for sections
      if (includeSections.has('errors') || includeSections.has('timing') || includeSections.has('tools') || includeSections.has('git')) {
        const requestArtifacts = artifactsByRequest.get(req.id) || [];
        const telemetryArtifact = requestArtifacts.find((a) => a.topic === 'WORKER_TELEMETRY');

        if (telemetryArtifact) {
          const telemetry = await fetchIpfsContentMcp(telemetryArtifact.cid);
          if (telemetry && telemetry.version === 'worker-telemetry-v1') {
            const workerTelemetry = telemetry as WorkerTelemetryLog;

            // Errors
            if (includeSections.has('errors')) {
              const errors = extractErrorsFromTelemetry(workerTelemetry);
              allErrors.push(...errors);
              if (errors.length > 0) {
                stats.failedRuns++;
                failedJobs.push(req.id);
              }
            }

            // Git
            if (includeSections.has('git')) {
              const gitOps = extractGitOpsFromTelemetry(workerTelemetry);
              if (gitOps) {
                allGitOps.push(gitOps);
              }
            }

            // Timing
            if (includeSections.has('timing')) {
              const timing = extractTimingMetrics(req.id, req.jobName, workerTelemetry);
              if (timing) {
                allTimingMetrics.push(timing);
              }
            }

            // Tools
            if (includeSections.has('tools')) {
              const toolMetrics = extractToolMetricsFromTelemetry(workerTelemetry);
              if (toolMetrics) {
                allToolMetrics.push(toolMetrics);
              }
            }
          }
        }
      }

      // Fetch delivery for metrics
      if (includeSections.has('metrics') && req.deliveryIpfsHash) {
        const delivery = await fetchIpfsContentMcp(req.deliveryIpfsHash, req.id);
        if (delivery) {
          // Update status
          if (delivery.status === 'FAILED') {
            jobStatus = 'FAILED';
          } else if (delivery.status === 'DELEGATING') {
            jobStatus = 'DELEGATING';
          }

          // Token metrics
          const tokens = extractTokenMetrics(req.id, req.jobName, delivery);
          if (tokens) {
            allTokenMetrics.push(tokens);
          }

          // Invariant metrics
          const invariants = extractInvariantMetrics(req.id, req.jobName, delivery);
          if (invariants) {
            allInvariantMetrics.push(invariants);
          }
        }
      }

      // Build dispatch chain entry
      if (includeSections.has('dispatch') && req.ipfsHash) {
        const requestContent = await fetchIpfsContentMcp(req.ipfsHash);
        const additionalContext = requestContent?.additionalContext;
        const dispatchType = detectDispatchType(additionalContext);
        const dispatchReason = parseDispatchMessage(additionalContext);

        dispatchChain.push({
          requestId: req.id,
          jobName: req.jobName,
          depth: reqDepth,
          dispatchType,
          dispatchReason,
          status: jobStatus,
        });
      }

      jobs.push({
        requestId: req.id,
        jobName: req.jobName,
        jobDefinitionId: req.jobDefinitionId,
        status: jobStatus,
        depth: reqDepth,
        childCount,
      });
    }

    // Build result
    const result: InspectWorkstreamResult = {
      workstreamId: workstream_id,
      stats,
      jobs,
    };

    // Add optional sections
    if (includeSections.has('errors') && allErrors.length > 0) {
      const byPhase: Record<string, number> = {};
      for (const err of allErrors) {
        byPhase[err.phase] = (byPhase[err.phase] || 0) + 1;
      }

      result.errors = {
        total: allErrors.length,
        byPhase,
        topErrors: aggregateErrorsByPattern(allErrors, 5).map((e) => ({
          pattern: e.pattern,
          count: e.count,
          phase: e.phase,
        })),
      };
    }

    if (includeSections.has('dispatch') && dispatchChain.length > 0) {
      result.dispatchChain = dispatchChain;
    }

    if (includeSections.has('git') && allGitOps.length > 0) {
      const conflicts: Array<{ branch: string; files: string[] }> = [];
      let pushedCount = 0;

      for (const gitOp of allGitOps) {
        if (gitOp.pushed) pushedCount++;
        if (gitOp.hasConflicts && gitOp.branchName) {
          conflicts.push({
            branch: gitOp.branchName,
            files: gitOp.conflictingFiles || [],
          });
        }
      }

      result.gitSummary = {
        totalBranches: allGitOps.filter((g) => g.branchName).length,
        pushedBranches: pushedCount,
        conflicts,
      };
    }

    if (includeSections.has('metrics')) {
      const totalTokens = allTokenMetrics.reduce((sum, t) => sum + t.totalTokens, 0);
      const tokensByJob = allTokenMetrics
        .filter((t) => t.totalTokens > 0)
        .sort((a, b) => b.totalTokens - a.totalTokens)
        .slice(0, 5)
        .map((t) => ({
          requestId: t.requestId,
          jobName: t.jobName,
          tokens: t.totalTokens,
        }));

      let totalMeasured = 0;
      let totalPassed = 0;
      let totalFailed = 0;
      let unmeasuredJobs = 0;

      for (const inv of allInvariantMetrics) {
        totalMeasured += inv.measuredInvariants;
        totalPassed += inv.passedInvariants;
        totalFailed += inv.failedInvariants;
        if (inv.unmeasuredIds.length > 0) {
          unmeasuredJobs++;
        }
      }

      result.metrics = {
        tokenUsage: { total: totalTokens, byJob: tokensByJob },
        invariants: { totalMeasured, totalPassed, totalFailed, unmeasuredJobs },
        toolCalls: {
          total: allToolMetrics.reduce((sum, t) => sum + t.totalCalls, 0),
          failures: allToolMetrics.reduce((sum, t) => sum + t.failureCount, 0),
        },
      };
    }

    if (includeSections.has('timing') && allTimingMetrics.length > 0) {
      result.timing = aggregateTimingMetrics(allTimingMetrics, 5);
    }

    if (includeSections.has('tools') && allToolMetrics.length > 0) {
      result.tools = aggregateToolMetrics(allToolMetrics, 5);
    }

    // Add drill-down IDs
    result.drillDownIds = {
      failedJobs: failedJobs.slice(0, 5),
      slowestJobs: result.timing?.slowestJobs?.map((j) => j.requestId) || [],
    };

    // Apply truncation policy
    const truncationPolicy: TruncationPolicy = {
      error: 200,
      pattern: 200,
      dispatchReason: 150,
      branch: 100,
    };

    const composed = composeSinglePageResponse([result], {
      pageTokenBudget: 12_000,
      perFieldMaxChars: 1_500,
      truncationPolicy,
    });

    // Calculate pagination meta
    const hasMore = filteredRequests.length > keyset.offset + limit;
    const nextCursor = hasMore ? encodeCursor({ offset: keyset.offset + limit }) : undefined;

    return mcpSuccess(composed.data[0], {
      has_more: hasMore,
      next_cursor: nextCursor,
    });
  } catch (e: any) {
    return mcpExecutionError(e?.message || String(e));
  }
}
