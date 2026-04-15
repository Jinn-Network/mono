/**
 * MCP Tool: inspect_job_run
 *
 * Deep inspection of a single job run. Returns request details, delivery status,
 * errors, timing breakdown, invariant coverage, git operations, and token usage.
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
  extractFailedToolCalls,
  type ErrorSummary,
  type GitOperationSummary,
  type TimingMetrics,
  type TokenMetrics,
  type InvariantMetrics,
  type FailedToolCall,
  type WorkerTelemetryLog,
} from './shared/inspection-utils.js';
import { composeSinglePageResponse, type TruncationPolicy } from './shared/context-management.js';

// --- Schema ---

export const inspectJobRunParams = z.object({
  request_id: z.string().min(1).describe('The request ID (0x-prefixed hex string) to inspect'),
  include_artifacts: z.boolean().optional().default(true).describe('Include resolved artifact content'),
  include_telemetry: z.boolean().optional().default(true).describe('Include worker telemetry (timing, errors, git ops)'),
  resolve_ipfs: z.boolean().optional().default(true).describe('Resolve IPFS content for request and delivery'),
});

export type InspectJobRunParams = z.infer<typeof inspectJobRunParams>;

export const inspectJobRunSchema = {
  description: 'Deep inspection of a single job run. Returns request details, delivery status, errors, timing breakdown, invariant coverage, git operations, and token usage.',
  inputSchema: inspectJobRunParams.shape,
};

// --- GraphQL Queries ---

const GET_JOB_RUN_QUERY = `
  query GetJobRun($requestId: String!) {
    request(id: $requestId) {
      id
      jobName
      jobDefinitionId
      workstreamId
      sourceRequestId
      delivered
      deliveryIpfsHash
      blockTimestamp
      ipfsHash
    }
  }
`;

const GET_ARTIFACTS_QUERY = `
  query GetArtifacts($requestId: String!) {
    artifacts(where: { requestId: $requestId }, limit: 100) {
      items {
        id
        name
        topic
        cid
        type
        contentPreview
      }
    }
  }
`;

// --- Types ---

interface RequestData {
  id: string;
  jobName?: string;
  jobDefinitionId?: string;
  workstreamId?: string;
  sourceRequestId?: string;
  delivered: boolean;
  deliveryIpfsHash?: string;
  blockTimestamp?: string;
  ipfsHash?: string;
}

interface ArtifactData {
  id: string;
  name: string;
  topic: string;
  cid: string;
  type?: string;
  contentPreview?: string;
}

interface InspectJobRunResult {
  request: {
    id: string;
    jobName?: string;
    jobDefinitionId?: string;
    workstreamId?: string;
    sourceRequestId?: string;
    status: 'COMPLETED' | 'FAILED' | 'PENDING' | 'DELEGATING';
    delivered: boolean;
    timestamp?: string;
    ipfsHash?: string;
  };
  delivery?: {
    status?: string;
    error?: string;
    model?: string;
  };
  errors?: ErrorSummary[];
  failedToolCalls?: FailedToolCall[];
  timing?: TimingMetrics;
  invariants?: InvariantMetrics;
  gitOps?: GitOperationSummary;
  tokens?: TokenMetrics;
  artifacts?: Array<{
    name: string;
    topic: string;
    cid: string;
    type?: string;
    contentPreview?: string;
  }>;
}

// --- Handler ---

export async function inspectJobRun(params: unknown) {
  // Validate input
  const parsed = inspectJobRunParams.safeParse(params);
  if (!parsed.success) {
    return mcpValidationError(parsed.error.message);
  }

  const { request_id, include_artifacts, include_telemetry, resolve_ipfs } = parsed.data;

  try {
    // Fetch request from Ponder
    const requestResult = await queryPonder<{ request: RequestData | null }>(
      GET_JOB_RUN_QUERY,
      { requestId: request_id }
    );

    if (requestResult.error) {
      return mcpExecutionError(`Failed to query request: ${requestResult.error}`);
    }

    const request = requestResult.data?.request;
    if (!request) {
      return mcpNotFound('Request', request_id);
    }

    // Build base result
    const result: InspectJobRunResult = {
      request: {
        id: request.id,
        jobName: request.jobName,
        jobDefinitionId: request.jobDefinitionId,
        workstreamId: request.workstreamId,
        sourceRequestId: request.sourceRequestId,
        status: request.delivered ? 'COMPLETED' : 'PENDING',
        delivered: request.delivered,
        timestamp: request.blockTimestamp,
        ipfsHash: request.ipfsHash,
      },
    };

    const warnings: string[] = [];

    // Resolve IPFS content if requested
    let deliveryContent: any = null;
    let workerTelemetry: WorkerTelemetryLog | null = null;

    if (resolve_ipfs && request.deliveryIpfsHash) {
      deliveryContent = await fetchIpfsContentMcp(request.deliveryIpfsHash, request.id);
      if (!deliveryContent) {
        warnings.push('Failed to fetch delivery content from IPFS');
      } else {
        // Extract delivery info
        result.delivery = {
          status: deliveryContent.status,
          error: deliveryContent.error,
          model: deliveryContent.model,
        };

        // Update status based on delivery
        if (deliveryContent.status === 'FAILED') {
          result.request.status = 'FAILED';
        } else if (deliveryContent.status === 'DELEGATING') {
          result.request.status = 'DELEGATING';
        }
      }
    }

    // Fetch worker telemetry if requested
    if (include_telemetry) {
      // Query for WORKER_TELEMETRY artifact
      const artifactsResult = await queryPonder<{ artifacts: { items: ArtifactData[] } }>(
        GET_ARTIFACTS_QUERY,
        { requestId: request_id }
      );

      if (artifactsResult.data?.artifacts.items) {
        const telemetryArtifact = artifactsResult.data.artifacts.items.find(
          (a) => a.topic === 'WORKER_TELEMETRY'
        );

        if (telemetryArtifact) {
          const telemetryContent = await fetchIpfsContentMcp(telemetryArtifact.cid);
          if (telemetryContent && telemetryContent.version === 'worker-telemetry-v1') {
            workerTelemetry = telemetryContent as WorkerTelemetryLog;
          }
        }
      }

      if (workerTelemetry) {
        // Extract errors
        result.errors = extractErrorsFromTelemetry(workerTelemetry);

        // Extract git operations
        const gitOps = extractGitOpsFromTelemetry(workerTelemetry);
        if (gitOps) {
          result.gitOps = gitOps;
        }

        // Extract timing
        const timing = extractTimingMetrics(request.id, request.jobName, workerTelemetry);
        if (timing) {
          result.timing = timing;
        }
      }

      // Extract failed tool calls from delivery telemetry
      if (deliveryContent?.telemetry) {
        result.failedToolCalls = extractFailedToolCalls(
          request.id,
          request.jobName,
          deliveryContent.telemetry
        );
      }

      // Extract token metrics from delivery
      if (deliveryContent) {
        const tokens = extractTokenMetrics(request.id, request.jobName, deliveryContent);
        if (tokens) {
          result.tokens = tokens;
        }

        // Extract invariant metrics
        const invariants = extractInvariantMetrics(request.id, request.jobName, deliveryContent);
        if (invariants) {
          result.invariants = invariants;
        }
      }
    }

    // Include artifacts if requested
    if (include_artifacts) {
      const artifactsResult = await queryPonder<{ artifacts: { items: ArtifactData[] } }>(
        GET_ARTIFACTS_QUERY,
        { requestId: request_id }
      );

      if (artifactsResult.data?.artifacts.items) {
        result.artifacts = artifactsResult.data.artifacts.items
          .filter((a) => a.topic !== 'WORKER_TELEMETRY') // Exclude telemetry from artifacts list
          .map((a) => ({
            name: a.name,
            topic: a.topic,
            cid: a.cid,
            type: a.type,
            contentPreview: a.contentPreview,
          }));
      }
    }

    // Apply truncation policy for large responses
    const truncationPolicy: TruncationPolicy = {
      error: 300,
      contentPreview: 200,
      branchUrl: 100,
    };

    const composed = composeSinglePageResponse([result], {
      pageTokenBudget: 12_000,
      perFieldMaxChars: 2_000,
      truncationPolicy,
    });

    return mcpSuccess(composed.data[0], {
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (e: any) {
    return mcpExecutionError(e?.message || String(e));
  }
}
