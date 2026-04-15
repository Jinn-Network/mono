import fetch from 'cross-fetch';
import type { Situation, SituationArtifactReference, SituationContext, SituationExecution } from '../types/situation.js';
export const SITUATION_ARTIFACT_VERSION = "sit-enc-v1.1";
import { ExtractedArtifact } from './artifacts.js';
import { workerLogger } from '../logging/index.js';
import { extractPromptSections } from './recognition_helpers.js';
import { config } from '../config/index.js';

const PONDER_GRAPHQL_URL = config.services.ponderUrl;

interface SituationEncoderInput {
  requestId: string;
  jobName?: string;
  jobDefinitionId?: string;
  output: string;
  telemetry: any;
  finalStatus: string;
  additionalContext?: any;
  artifacts: ExtractedArtifact[];
  model?: string;
}

interface SituationEncoderResult {
  situation: Omit<Situation, 'embedding'>;
  summaryText: string;
}

interface InitialSituationInput {
  requestId: string;
  jobName?: string;
  jobDefinitionId?: string;
  model?: string;
  additionalContext?: any;
}

/**
 * Extract deterministic context from additionalContext envelope (hierarchy data)
 * Returns child/sibling request IDs and related data if available
 */
function extractDeterministicContext(
  additionalContext: any,
  currentJobDefinitionId?: string
): {
  childRequestIds: string[];
  siblingRequestIds: string[];
  childArtifacts: Array<{ id: string; name: string; topic: string; cid: string }>;
} {
  const result = {
    childRequestIds: [] as string[],
    siblingRequestIds: [] as string[],
    childArtifacts: [] as Array<{ id: string; name: string; topic: string; cid: string }>,
  };

  if (!additionalContext || typeof additionalContext !== 'object') {
    return result;
  }

  const hierarchy = additionalContext.hierarchy;
  if (!Array.isArray(hierarchy) || !currentJobDefinitionId) {
    return result;
  }

  // Find the current job in the hierarchy (level 0)
  const currentJob = hierarchy.find(
    (item: any) => item.jobId === currentJobDefinitionId && item.level === 0
  );
  if (!currentJob) {
    return result;
  }

  // Children are nodes whose parent is the current job
  const children = hierarchy.filter(
    (item: any) =>
      item.level > 0 && item.sourceJobDefinitionId === currentJobDefinitionId
  );
  for (const child of children) {
    if (Array.isArray(child.requestIds)) {
      result.childRequestIds.push(...child.requestIds);
    }
    if (Array.isArray(child.artifactRefs)) {
      result.childArtifacts.push(...child.artifactRefs);
    }
  }

  // Siblings share the same parent but are different jobs
  const parentId = currentJob.sourceJobDefinitionId;
  if (parentId) {
    const siblings = hierarchy.filter(
      (item: any) =>
        item.level === 0 &&
        item.sourceJobDefinitionId === parentId &&
        item.jobId !== currentJobDefinitionId
    );
    for (const sibling of siblings) {
      if (Array.isArray(sibling.requestIds)) {
        result.siblingRequestIds.push(...sibling.requestIds);
      }
    }
  }

  result.childRequestIds = [...new Set(result.childRequestIds)];
  result.siblingRequestIds = [...new Set(result.siblingRequestIds)];

  return result;
}

interface InitialSituationResult {
  situation: Omit<Situation, 'embedding' | 'execution' | 'artifacts'>;
  summaryText: string;
}

interface EnrichSituationInput {
  initialSituation: Omit<Situation, 'embedding' | 'execution' | 'artifacts'>;
  output: string;
  telemetry: any;
  finalStatus: string;
  artifacts: ExtractedArtifact[];
}

interface RequestRecord {
  id: string;
  jobDefinitionId?: string | null;
  sourceRequestId?: string | null;
  sourceJobDefinitionId?: string | null;
  jobName?: string | null;
  additionalContext?: any;
}

interface JobDefinitionRecord {
  id: string;
  blueprint?: string | null;
  enabledTools?: string[] | null;
}

async function fetchGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      workerLogger.warn({ status: res.status }, 'SituationEncoder GraphQL request failed');
      return null;
    }
    const json = await res.json();
    if (json.errors) {
      workerLogger.warn({ errors: json.errors }, 'SituationEncoder GraphQL returned errors');
      return null;
    }
    return json.data as T;
  } catch (error: any) {
    workerLogger.warn({ message: error?.message || String(error) }, 'SituationEncoder GraphQL error');
    return null;
  }
}

function parseAdditionalContext(value: unknown): any {
  if (!value) return undefined;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function truncate(text: unknown, max = 400): string {
  if (!text) return '';
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function buildExecutionTrace(telemetry: any): SituationExecution['trace'] {
  if (!telemetry || !Array.isArray(telemetry.toolCalls)) return [];

  return telemetry.toolCalls.slice(0, 15).map((call: any) => {
    const tool = typeof call?.tool === 'string' ? call.tool : 'unknown_tool';
    const args = truncate(call?.args ?? '', 350);

    let summary: string;
    if (call?.result) {
      summary = truncate(call.result, 350);
    } else if (call?.success === false) {
      summary = 'Tool call failed';
    } else {
      summary = call?.success ? 'Tool call succeeded' : 'Tool call executed';
    }

    return {
      tool,
      args,
      result_summary: summary,
    };
  });
}

function mapArtifacts(artifacts: ExtractedArtifact[]): SituationArtifactReference[] {
  return artifacts.slice(0, 10).map((artifact, index) => ({
    topic: artifact.topic,
    name: artifact.name || `artifact-${index + 1}`,
    contentPreview: truncate(artifact.contentPreview ?? '', 200) || undefined,
  }));
}

function extractStructuredFieldsFromPrompt(prompt?: string | null): {
  objective?: string;
  acceptanceCriteria?: string;
} {
  if (!prompt) return {};
  const sections = extractPromptSections(prompt);
  const pick = (key: string) => {
    const value = sections[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  };
  return {
    objective: pick('Objective'),
    acceptanceCriteria: pick('Acceptance Criteria'),
  };
}

function deriveSummaryText(params: {
  requestId: string;
  jobName?: string;
  objective?: string;
  acceptanceCriteria?: string;
  status: SituationExecution['status'];
  parentRequestId?: string;
  childRequestIds: string[];
  siblingRequestIds: string[];
  trace: SituationExecution['trace'];
  finalOutputSummary: string;
  artifacts: SituationArtifactReference[];
}): string {
  const lines: string[] = [];
  lines.push(`Job ${params.requestId}${params.jobName ? `: ${params.jobName}` : ''}`);
  lines.push(`Status: ${params.status}`);
  if (params.objective) {
    lines.push(`Objective: ${truncate(params.objective, 400)}`);
  }
  if (params.acceptanceCriteria) {
    lines.push(`Acceptance Criteria: ${truncate(params.acceptanceCriteria, 400)}`);
  }
  lines.push(`Parent: ${params.parentRequestId || 'none'}`);
  lines.push(`Children: ${params.childRequestIds.length > 0 ? params.childRequestIds.join(', ') : 'none'}`);
  lines.push(`Siblings: ${params.siblingRequestIds.length > 0 ? params.siblingRequestIds.join(', ') : 'none'}`);
  if (params.trace.length > 0) {
    const toolSummaries = params.trace.slice(0, 8).map((step) => `${step.tool} -> ${truncate(step.result_summary, 120)}`);
    lines.push(`Key Actions: ${toolSummaries.join(' | ')}`);
  }
  if (params.artifacts.length > 0) {
    const artifactSummaries = params.artifacts.map((a) => `${a.topic}:${a.name}`);
    lines.push(`Artifacts: ${artifactSummaries.join(', ')}`);
  }
  if (params.finalOutputSummary) {
    lines.push(`Final Output: ${truncate(params.finalOutputSummary, 500)}`);
  }
  return lines.join('\n');
}

async function fetchRequestRecord(requestId: string): Promise<RequestRecord | null> {
  const query = `
    query ($id: String!) {
      request(id: $id) {
        id
        jobDefinitionId
        sourceRequestId
        sourceJobDefinitionId
        jobName
        additionalContext
      }
    }
  `;
  const data = await fetchGraphQL<{ request: RequestRecord | null }>(query, { id: requestId });
  if (!data?.request) return null;
  const additionalContext = parseAdditionalContext(data.request.additionalContext);
  return {
    ...data.request,
    additionalContext,
  };
}

async function fetchJobDefinition(jobDefinitionId: string): Promise<JobDefinitionRecord | null> {
  const query = `
    query ($id: String!) {
      jobDefinition(id: $id) {
        id
        blueprint
        enabledTools
      }
    }
  `;
  const data = await fetchGraphQL<{ jobDefinition: JobDefinitionRecord | null }>(query, { id: jobDefinitionId });
  return data?.jobDefinition || null;
}

async function fetchRelatedRequestIds(sourceRequestId: string, excludeId?: string): Promise<string[]> {
  const query = `
    query ($sourceRequestId: String!) {
      requests(where: { sourceRequestId: $sourceRequestId }, limit: 50) {
        items { id }
      }
    }
  `;
  const data = await fetchGraphQL<{ requests: { items: Array<{ id: string }> } | null }>(query, { sourceRequestId });
  const items = data?.requests?.items || [];
  return items
    .map((item) => String(item.id))
    .filter((id) => !excludeId || id !== excludeId);
}

function deriveInitialSummaryText(params: {
  requestId: string;
  jobName?: string;
  objective?: string;
  acceptanceCriteria?: string;
  parentRequestId?: string;
  siblingRequestIds: string[];
  prompt?: string;
  enabledTools?: string[];
  blueprint?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Job ${params.requestId}${params.jobName ? `: ${params.jobName}` : ''}`);
  if (params.objective) {
    lines.push(`Objective: ${truncate(params.objective, 400)}`);
  }
  if (params.acceptanceCriteria) {
    lines.push(`Acceptance Criteria: ${truncate(params.acceptanceCriteria, 400)}`);
  }
  if (params.blueprint) {
    lines.push(`Blueprint: ${truncate(params.blueprint, 400)}`);
  }
  if (params.prompt) {
    lines.push(`Prompt: ${truncate(params.prompt, 600)}`);
  }
  if (params.enabledTools && params.enabledTools.length > 0) {
    lines.push(`Tools: ${params.enabledTools.join(', ')}`);
  }
  lines.push(`Parent: ${params.parentRequestId || 'none'}`);
  lines.push(`Siblings: ${params.siblingRequestIds.length > 0 ? params.siblingRequestIds.join(', ') : 'none'}`);
  return lines.join('\n');
}

export async function createInitialSituation(input: InitialSituationInput): Promise<InitialSituationResult> {
  const requestRecord = await fetchRequestRecord(input.requestId);

  const parentRequestId = requestRecord?.sourceRequestId || undefined;
  const parentJobDefinitionId = requestRecord?.sourceJobDefinitionId || undefined;

  // Resolve job identity early to align with deterministic context
  const jobName = input.jobName || requestRecord?.jobName || undefined;
  const jobDefinitionId = input.jobDefinitionId || requestRecord?.jobDefinitionId || undefined;

  const deterministicContext = extractDeterministicContext(
    input.additionalContext ?? requestRecord?.additionalContext,
    jobDefinitionId
  );

  const siblingRequestIdsFromQuery = parentRequestId
    ? await fetchRelatedRequestIds(parentRequestId, input.requestId).catch(() => [])
    : [];
  const siblingRequestIds = Array.from(
    new Set([...(deterministicContext.siblingRequestIds || []), ...siblingRequestIdsFromQuery])
  );

  // Extract blueprint for metadata (objective/acceptanceCriteria extracted later from prompt on line 318)
  const blueprint = (input.additionalContext ?? requestRecord?.additionalContext)?.blueprint
    ? String((input.additionalContext ?? requestRecord?.additionalContext).blueprint)
    : undefined;

  const situationContext: SituationContext = {
    parentRequestId,
    parent: parentRequestId
      ? {
        requestId: parentRequestId,
        jobDefinitionId: parentJobDefinitionId,
      }
      : undefined,
    childRequestIds: deterministicContext.childRequestIds || [],
    siblingRequestIds,
  };

  // Fetch job definition to enrich with blueprint and enabled tools
  let jobBlueprint: string | undefined;
  let enabledTools: string[] | undefined;
  if (jobDefinitionId) {
    const jobDef = await fetchJobDefinition(jobDefinitionId);
    if (jobDef) {
      jobBlueprint = jobDef.blueprint || undefined;
      enabledTools = jobDef.enabledTools || undefined;
    }
  }

  // Blueprint-based jobs: no objective/acceptanceCriteria extraction
  // Blueprint is the primary job specification

  const summaryText = deriveInitialSummaryText({
    requestId: input.requestId,
    jobName,
    objective: undefined,
    acceptanceCriteria: undefined,
    parentRequestId,
    siblingRequestIds,
    prompt: undefined,
    enabledTools,
    blueprint: jobBlueprint,
  });

  const situation: Omit<Situation, 'embedding' | 'execution' | 'artifacts'> = {
    version: SITUATION_ARTIFACT_VERSION,
    job: {
      requestId: input.requestId,
      jobDefinitionId,
      jobName,
      blueprint: jobBlueprint,
      model: input.model,
      enabledTools,
    },
    context: situationContext,
  };

  return { situation, summaryText };
}

export async function enrichSituation(input: EnrichSituationInput): Promise<SituationEncoderResult> {
  const existingChildIds =
    input.initialSituation.context.childRequestIds ||
    [];

  const childRequestIdsFromQuery =
    (await fetchRelatedRequestIds(input.initialSituation.job.requestId).catch(() => [])) || [];
  const childRequestIds = Array.from(new Set([...existingChildIds, ...childRequestIdsFromQuery]));

  const executionTrace = buildExecutionTrace(input.telemetry);
  const status: SituationExecution['status'] =
    input.finalStatus === 'COMPLETED' ? 'COMPLETED' :
      input.finalStatus === 'DELEGATING' ? 'DELEGATING' :
        input.finalStatus === 'WAITING' ? 'WAITING' : 'FAILED';

  const finalOutputSummary = truncate(input.output, 1200);

  const artifacts = mapArtifacts(input.artifacts);

  // Enrich the context with child requests discovered post-execution
  const enrichedContext: SituationContext = {
    ...input.initialSituation.context,
    parent: input.initialSituation.context.parentRequestId
      ? {
        requestId: input.initialSituation.context.parentRequestId,
        jobDefinitionId: input.initialSituation.context.parent?.jobDefinitionId,
      }
      : input.initialSituation.context.parent,
    childRequestIds,
    siblingRequestIds: input.initialSituation.context.siblingRequestIds,
  };

  const summaryText = deriveSummaryText({
    requestId: input.initialSituation.job.requestId,
    jobName: input.initialSituation.job.jobName,
    objective: input.initialSituation.job.objective,
    acceptanceCriteria: input.initialSituation.job.acceptanceCriteria,
    status,
    parentRequestId: input.initialSituation.context.parentRequestId,
    childRequestIds,
    siblingRequestIds: input.initialSituation.context.siblingRequestIds || [],
    trace: executionTrace,
    finalOutputSummary,
    artifacts,
  });

  const situation: Omit<Situation, 'embedding'> = {
    ...input.initialSituation,
    execution: {
      status,
      trace: executionTrace,
      finalOutputSummary,
    },
    context: enrichedContext,
    artifacts,
  };

  return { situation, summaryText };
}

export async function encodeSituation(input: SituationEncoderInput): Promise<SituationEncoderResult> {
  const requestRecord = await fetchRequestRecord(input.requestId);

  const parentRequestId = requestRecord?.sourceRequestId || undefined;
  const jobName = input.jobName || requestRecord?.jobName || undefined;
  const jobDefinitionId = input.jobDefinitionId || requestRecord?.jobDefinitionId || undefined;

  const effectiveAdditionalContext =
    input.additionalContext ?? requestRecord?.additionalContext;
  const deterministicContext = extractDeterministicContext(
    effectiveAdditionalContext,
    jobDefinitionId
  );

  const childRequestIdsFromEnvelope = deterministicContext.childRequestIds || [];
  const childRequestIdsFromQuery =
    (await fetchRelatedRequestIds(input.requestId).catch(() => [])) || [];
  const childRequestIds = Array.from(
    new Set([...childRequestIdsFromEnvelope, ...childRequestIdsFromQuery])
  );
  const siblingRequestIds = parentRequestId
    ? await fetchRelatedRequestIds(parentRequestId, input.requestId).catch(() => [])
    : [];
  const parentJobDefinitionId = requestRecord?.sourceJobDefinitionId || undefined;

  const executionTrace = buildExecutionTrace(input.telemetry);
  const status: SituationExecution['status'] =
    input.finalStatus === 'COMPLETED' ? 'COMPLETED' :
      input.finalStatus === 'DELEGATING' ? 'DELEGATING' :
        input.finalStatus === 'WAITING' ? 'WAITING' : 'FAILED';

  const finalOutputSummary = typeof input.output === 'string' ? input.output : JSON.stringify(input.output);

  const artifacts = mapArtifacts(input.artifacts);

  const situationContext: SituationContext = {
    parentRequestId,
    parent: parentRequestId
      ? {
        requestId: parentRequestId,
        jobDefinitionId: parentJobDefinitionId,
      }
      : undefined,
    childRequestIds,
    siblingRequestIds,
  };

  let jobBlueprint: string | undefined;
  let enabledTools: string[] | undefined;
  if (jobDefinitionId) {
    const jobDef = await fetchJobDefinition(jobDefinitionId);
    if (jobDef) {
      jobBlueprint = jobDef.blueprint || undefined;
      enabledTools = jobDef.enabledTools || undefined;
    }
  }
  // Blueprint-based jobs: no objective/acceptanceCriteria extraction

  const summaryText = deriveSummaryText({
    requestId: input.requestId,
    jobName,
    objective: undefined,
    acceptanceCriteria: undefined,
    status,
    parentRequestId,
    childRequestIds,
    siblingRequestIds,
    trace: executionTrace,
    finalOutputSummary,
    artifacts,
  });

  const situation: Omit<Situation, 'embedding'> = {
    version: SITUATION_ARTIFACT_VERSION,
    job: {
      requestId: input.requestId,
      jobDefinitionId,
      jobName,
      blueprint: jobBlueprint,
      model: input.model,
      enabledTools,
    },
    execution: {
      status,
      trace: executionTrace,
      finalOutputSummary,
    },
    context: situationContext,
    artifacts,
  };

  return { situation, summaryText };
}
