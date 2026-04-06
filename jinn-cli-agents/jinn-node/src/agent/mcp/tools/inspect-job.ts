/**
 * MCP Tool: inspect_job
 *
 * Inspect a job definition and its execution history. Returns job metadata,
 * all runs with status/errors, and child jobs.
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
  extractFailedToolCalls,
  type ErrorSummary,
  type FailedToolCall,
  type WorkerTelemetryLog,
} from './shared/inspection-utils.js';
import {
  composeSinglePageResponse,
  encodeCursor,
  decodeCursor,
  type TruncationPolicy,
} from './shared/context-management.js';

// --- Schema ---

export const inspectJobParams = z.object({
  job_definition_id: z.string().uuid().describe('The job definition UUID to inspect'),
  include_runs: z.boolean().optional().default(true).describe('Include execution history'),
  max_runs: z.number().int().min(1).max(50).optional().default(10).describe('Maximum number of runs to include (most recent first)'),
  include_children: z.boolean().optional().default(true).describe('Include child jobs created by this job'),
  cursor: z.string().optional().describe('Pagination cursor for runs'),
});

export type InspectJobParams = z.infer<typeof inspectJobParams>;

export const inspectJobSchema = {
  description: 'Inspect a job definition and its execution history. Returns job metadata, all runs with status/errors, and child jobs.',
  inputSchema: inspectJobParams.shape,
};

// --- GraphQL Queries ---

const GET_JOB_DEFINITION_QUERY = `
  query GetJobDefinition($id: String!) {
    jobDefinition(id: $id) {
      id
      name
      lastStatus
      enabledTools
      blueprint
      createdAt
    }
  }
`;

const GET_JOB_RUNS_QUERY = `
  query GetJobRuns($jobDefinitionId: String!, $limit: Int!) {
    requests(
      where: { jobDefinitionId: $jobDefinitionId }
      orderBy: "blockTimestamp"
      orderDirection: "desc"
      limit: $limit
    ) {
      items {
        id
        jobName
        delivered
        deliveryIpfsHash
        blockTimestamp
        workstreamId
        sourceRequestId
      }
    }
  }
`;

const GET_CHILD_JOBS_QUERY = `
  query GetChildJobs($sourceJobDefinitionId: String!, $limit: Int!) {
    requests(
      where: { sourceJobDefinitionId: $sourceJobDefinitionId }
      orderBy: "blockTimestamp"
      orderDirection: "desc"
      limit: $limit
    ) {
      items {
        id
        jobName
        jobDefinitionId
        delivered
        workstreamId
      }
    }
  }
`;

const GET_TELEMETRY_ARTIFACT_QUERY = `
  query GetTelemetryArtifact($requestId: String!) {
    artifacts(where: { AND: [{ requestId: $requestId }, { topic: "WORKER_TELEMETRY" }] }, limit: 1) {
      items {
        cid
      }
    }
  }
`;

// --- Types ---

interface JobDefinitionData {
  id: string;
  name?: string;
  lastStatus?: string;
  enabledTools?: string;
  blueprint?: string;
  createdAt?: string;
}

interface RequestData {
  id: string;
  jobName?: string;
  delivered: boolean;
  deliveryIpfsHash?: string;
  blockTimestamp?: string;
  workstreamId?: string;
  sourceRequestId?: string;
}

interface ChildJobData {
  id: string;
  jobName?: string;
  jobDefinitionId?: string;
  delivered: boolean;
  workstreamId?: string;
}

interface RunSummary {
  requestId: string;
  status: string;
  timestamp?: string;
  workstreamId?: string;
  errorCount: number;
  childCount: number;
  errors?: ErrorSummary[];
  failedToolCalls?: FailedToolCall[];
}

interface InspectJobResult {
  jobDefinition: {
    id: string;
    name?: string;
    lastStatus?: string;
    enabledTools?: string[];
    blueprint?: string;
    createdAt?: string;
  };
  summary: {
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    pendingRuns: number;
    totalChildren: number;
  };
  runs?: RunSummary[];
  children?: Array<{
    requestId: string;
    jobName?: string;
    jobDefinitionId?: string;
    delivered: boolean;
    workstreamId?: string;
  }>;
  drillDownIds?: {
    failedRuns: string[];
    recentRuns: string[];
  };
}

// --- Handler ---

export async function inspectJob(params: unknown) {
  // Validate input
  const parsed = inspectJobParams.safeParse(params);
  if (!parsed.success) {
    return mcpValidationError(parsed.error.message);
  }

  const { job_definition_id, include_runs, max_runs, include_children, cursor } = parsed.data;

  try {
    // Fetch job definition
    const jobDefResult = await queryPonder<{ jobDefinition: JobDefinitionData | null }>(
      GET_JOB_DEFINITION_QUERY,
      { id: job_definition_id }
    );

    if (jobDefResult.error) {
      return mcpExecutionError(`Failed to query job definition: ${jobDefResult.error}`);
    }

    const jobDef = jobDefResult.data?.jobDefinition;
    if (!jobDef) {
      return mcpNotFound('Job definition', job_definition_id);
    }

    // Parse enabled tools
    let enabledTools: string[] | undefined;
    if (jobDef.enabledTools) {
      try {
        enabledTools = JSON.parse(jobDef.enabledTools);
      } catch {
        enabledTools = [jobDef.enabledTools];
      }
    }

    // Build base result
    const result: InspectJobResult = {
      jobDefinition: {
        id: jobDef.id,
        name: jobDef.name,
        lastStatus: jobDef.lastStatus,
        enabledTools,
        blueprint: jobDef.blueprint,
        createdAt: jobDef.createdAt,
      },
      summary: {
        totalRuns: 0,
        completedRuns: 0,
        failedRuns: 0,
        pendingRuns: 0,
        totalChildren: 0,
      },
    };

    const warnings: string[] = [];

    // Fetch runs if requested
    if (include_runs) {
      // Decode cursor for pagination
      const keyset = decodeCursor<{ offset: number }>(cursor) ?? { offset: 0 };
      const fetchLimit = max_runs + keyset.offset + 1; // Extra to check for more

      const runsResult = await queryPonder<{ requests: { items: RequestData[] } }>(
        GET_JOB_RUNS_QUERY,
        { jobDefinitionId: job_definition_id, limit: fetchLimit }
      );

      if (runsResult.data?.requests.items) {
        const allRuns = runsResult.data.requests.items;
        result.summary.totalRuns = allRuns.length;

        // Apply offset
        const paginatedRuns = allRuns.slice(keyset.offset, keyset.offset + max_runs);

        // Count statuses
        for (const run of allRuns) {
          if (run.delivered) {
            result.summary.completedRuns++;
          } else {
            result.summary.pendingRuns++;
          }
        }

        // Analyze runs (fetch telemetry for error info)
        const runs: RunSummary[] = [];
        const failedRuns: string[] = [];

        for (const run of paginatedRuns) {
          const runSummary: RunSummary = {
            requestId: run.id,
            status: run.delivered ? 'COMPLETED' : 'PENDING',
            timestamp: run.blockTimestamp,
            workstreamId: run.workstreamId,
            errorCount: 0,
            childCount: 0,
          };

          // Try to fetch telemetry for error analysis
          const telemetryResult = await queryPonder<{ artifacts: { items: Array<{ cid: string }> } }>(
            GET_TELEMETRY_ARTIFACT_QUERY,
            { requestId: run.id }
          );

          if (telemetryResult.data?.artifacts.items[0]?.cid) {
            const telemetry = await fetchIpfsContentMcp(telemetryResult.data.artifacts.items[0].cid);
            if (telemetry && telemetry.version === 'worker-telemetry-v1') {
              const workerTelemetry = telemetry as WorkerTelemetryLog;
              const errors = extractErrorsFromTelemetry(workerTelemetry);
              runSummary.errorCount = errors.length;

              if (errors.length > 0) {
                runSummary.errors = errors.slice(0, 3); // Include top 3 errors
                failedRuns.push(run.id);
                result.summary.failedRuns++;
              }
            }
          }

          // Check delivery for failed tool calls
          if (run.deliveryIpfsHash) {
            const delivery = await fetchIpfsContentMcp(run.deliveryIpfsHash, run.id);
            if (delivery?.telemetry) {
              const failedTools = extractFailedToolCalls(run.id, run.jobName, delivery.telemetry);
              if (failedTools.length > 0) {
                runSummary.failedToolCalls = failedTools.slice(0, 3);
              }

              // Update status based on delivery
              if (delivery.status === 'FAILED') {
                runSummary.status = 'FAILED';
              } else if (delivery.status === 'DELEGATING') {
                runSummary.status = 'DELEGATING';
              }
            }
          }

          runs.push(runSummary);
        }

        result.runs = runs;
        result.drillDownIds = {
          failedRuns: failedRuns.slice(0, 5),
          recentRuns: paginatedRuns.slice(0, 5).map((r) => r.id),
        };
      }
    }

    // Fetch children if requested
    if (include_children) {
      const childrenResult = await queryPonder<{ requests: { items: ChildJobData[] } }>(
        GET_CHILD_JOBS_QUERY,
        { sourceJobDefinitionId: job_definition_id, limit: 50 }
      );

      if (childrenResult.data?.requests.items) {
        result.summary.totalChildren = childrenResult.data.requests.items.length;
        result.children = childrenResult.data.requests.items.slice(0, 20).map((c) => ({
          requestId: c.id,
          jobName: c.jobName,
          jobDefinitionId: c.jobDefinitionId,
          delivered: c.delivered,
          workstreamId: c.workstreamId,
        }));
      }
    }

    // Apply truncation policy for large responses
    const truncationPolicy: TruncationPolicy = {
      error: 300,
      blueprint: 500,
      contentPreview: 150,
    };

    const composed = composeSinglePageResponse([result], {
      pageTokenBudget: 12_000,
      perFieldMaxChars: 2_000,
      truncationPolicy,
    });

    // Calculate pagination meta
    const hasMore = result.runs && result.summary.totalRuns > (decodeCursor<{ offset: number }>(cursor)?.offset ?? 0) + max_runs;
    const nextCursor = hasMore
      ? encodeCursor({ offset: (decodeCursor<{ offset: number }>(cursor)?.offset ?? 0) + max_runs })
      : undefined;

    return mcpSuccess(composed.data[0], {
      warnings: warnings.length > 0 ? warnings : undefined,
      has_more: hasMore,
      next_cursor: nextCursor,
    });
  } catch (e: any) {
    return mcpExecutionError(e?.message || String(e));
  }
}
