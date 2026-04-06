/**
 * Agent execution: spawn Gemini CLI, handle stdout/stderr, capture telemetry
 */

import { Agent } from '../../agent/agent.js';
import { createBlueprintBuilder } from '../prompt/index.js';
import { setJobContext, clearJobContext, snapshotJobContext, restoreJobContext } from '../metadata/jobContext.js';
import { extractMissionInvariantIds } from '../prompt/utils/invariantIds.js';
import { parseAnnotatedTools, normalizeToolArray, extractModelPolicyFromBlueprint } from '../../shared/template-tools.js';
import { didDispatchChild } from '../status/dispatchUtils.js';
import { updateJobStatus } from '../control_api_client.js';
import type { UnclaimedRequest, IpfsMetadata, AdditionalContext, AgentExecutionResult } from '../types.js';
import { DEFAULT_WORKER_MODEL, normalizeGeminiModel } from '../../shared/gemini-models.js';

/**
 * Execution context for agent run
 */
export interface ExecutionContext {
  request: UnclaimedRequest;
  metadata: IpfsMetadata;
}

/**
 * Run agent for a request with proper environment context
 * 
 * Tool configuration is handled centrally via gemini-agent/toolPolicy.ts.
 * The Agent class computes MCP include/exclude lists and CLI whitelists
 * based on the enabledTools passed here, ensuring consistency across the system.
 */
function extractCompletedChildRequestIds(additionalContext: AdditionalContext | undefined): string[] {
  if (!additionalContext) {
    return [];
  }
  const hierarchy = Array.isArray(additionalContext.hierarchy)
    ? additionalContext.hierarchy
    : [];
  const ids = new Set<string>();
  hierarchy
    .filter((job) => job && job.level && job.level > 0 && job.status === 'completed')
    .forEach((job) => {
      if (Array.isArray(job.requestIds)) {
        job.requestIds.forEach((id) => {
          if (typeof id === 'string' && id.length > 0) {
            ids.add(id);
          }
        });
      }
    });
  return Array.from(ids);
}

export async function runAgentForRequest(
  request: UnclaimedRequest,
  metadata: IpfsMetadata
): Promise<AgentExecutionResult> {
  // Model comes from job metadata (set at dispatch time), fallback to flash
  const modelNormalization = normalizeGeminiModel(metadata?.model, DEFAULT_WORKER_MODEL);
  const model = modelNormalization.normalized;
  // Normalize tools to string array (handles both string and object formats from IPFS metadata)
  const enabledTools = normalizeToolArray(metadata?.enabledTools);
  const toolPolicy = Array.isArray(metadata?.tools) ? parseAnnotatedTools(metadata.tools) : null;
  const requiredTools = toolPolicy?.requiredTools ?? undefined;
  const availableTools = toolPolicy?.availableTools ?? undefined;
  const completedChildRequestIds = extractCompletedChildRequestIds(metadata?.additionalContext);

  // Determine if this is a coding job based on presence of code metadata
  const isCodingJob = !!metadata?.codeMetadata;

  // For artifact-only jobs (no code), pass null to prevent loading external repos.
  // For coding jobs, prefer explicit repo root from environment if set (handles test fixtures).
  const codeWorkspace = isCodingJob
    ? (process.env.CODE_METADATA_REPO_ROOT || undefined)
    : null;

  const agent = new Agent(
    model,
    enabledTools,
    {
      jobId: request.id,
      jobDefinitionId: metadata?.jobDefinitionId || null,
      jobName: metadata?.jobName || 'job',
      workstreamId: metadata?.workstreamId || request.workstreamId || request.id,
      phase: 'execution',
      projectRunId: null,
      sourceEventId: null,
      projectDefinitionId: null
    },
    codeWorkspace,
    {
      isCodingJob,
      onStatusUpdate: (status: string) => {
        // Fire-and-forget status update to Control API
        updateJobStatus(request.id, status).catch(() => { });
      }
    }
  );

  // Build unified prompt from BlueprintBuilder
  // Recognition is attached to metadata.recognition by jobRunner before calling this
  const blueprintBuilder = createBlueprintBuilder();
  const prompt = await blueprintBuilder.buildPrompt(request.id, metadata, metadata.recognition);

  // Extract mission invariant IDs from blueprint for downstream validation
  const blueprintInvariantIds = extractMissionInvariantIds(metadata?.blueprint);

  // Extract model policy: IPFS-level allowedModels (from parent cascade) takes precedence over blueprint
  const blueprintObj = (() => { try { return JSON.parse(metadata?.blueprint || '{}'); } catch { return {}; } })();
  const blueprintModelPolicy = extractModelPolicyFromBlueprint(blueprintObj);
  const modelPolicy = {
    allowedModels: Array.isArray(metadata?.allowedModels) && metadata.allowedModels.length > 0
      ? metadata.allowedModels
      : blueprintModelPolicy.allowedModels,
    defaultModel: blueprintModelPolicy.defaultModel,
  };

  // Snapshot and set job context for downstream tools
  const prevContext = snapshotJobContext();
  try {
    setJobContext({
      requestId: request.id,
      mechAddress: request.mech,
      jobDefinitionId: metadata?.jobDefinitionId || undefined,
      baseBranch:
        metadata?.codeMetadata?.branch?.name ||
        metadata?.codeMetadata?.baseBranch ||
        undefined,
      workstreamId: metadata?.workstreamId || request.workstreamId || request.id, // Fallback to requestId for root jobs
      ventureId: metadata?.ventureId || request.ventureId || undefined,
      parentRequestId: metadata?.sourceRequestId || undefined,
      branchName: metadata?.codeMetadata?.branch?.name || undefined,
      completedChildRequestIds,
      requiredTools,
      availableTools,
      blueprintInvariantIds: blueprintInvariantIds.length > 0 ? blueprintInvariantIds : undefined,
      allowedModels: modelPolicy.allowedModels.length > 0 ? modelPolicy.allowedModels : undefined,
      defaultModel: modelPolicy.defaultModel !== DEFAULT_WORKER_MODEL ? modelPolicy.defaultModel : undefined,
    });

    const result = await agent.run(prompt);
    const telemetry = result.telemetry || {};
    const delegated = didDispatchChild(telemetry);

    return {
      output: result.output || '',
      structuredSummary: result.structuredSummary,
      jobInstanceStatusUpdate: result.jobInstanceStatusUpdate,
      telemetry,
      delegated,
    };
  } finally {
    restoreJobContext(prevContext);
  }
}
