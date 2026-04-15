/**
 * Delivery payload: structure output, telemetry, PR URL for IPFS registry
 */

import type { AgentExecutionResult, IpfsMetadata, RecognitionPhaseResult, ReflectionResult } from '../types.js';
import type { MeasurementCoverage } from '../execution/measurementCoverage.js';
import type { Provenance } from '../../shared/registry/types.js';

/**
 * Build execution provenance metadata from available params.
 * Returns a Provenance object for embedding in artifacts.
 */
function buildExecutionProvenance(params: {
  requestId: string;
  metadata: IpfsMetadata;
  workerAddress?: string;
  durationMs?: number;
}): Provenance {
  const { requestId, metadata, workerAddress, durationMs } = params;

  const provenance: Provenance = {
    method: 'agent-execution',
    execution: {
      requestId,
      ...(workerAddress ? { agent: `eip155:8453:${workerAddress}` } : {}),
      ...(metadata.blueprint ? { blueprint: metadata.blueprint } : {}),
      ...(metadata.enabledTools ? { tools: metadata.enabledTools } : {}),
      chain: 'eip155:8453',
      timestamp: new Date().toISOString(),
      ...(durationMs ? { duration: `PT${Math.round(durationMs / 1000)}S` } : {}),
    },
    derivedFrom: [],
  };

  // Add blueprint as a derivedFrom source if present
  if (metadata.blueprint) {
    provenance.derivedFrom!.push({
      contentHash: metadata.blueprint,
      relationship: 'blueprint',
      description: 'Blueprint that defined the execution constraints',
    });
  }

  // Add template reference if present
  if (metadata.templateId) {
    provenance.derivedFrom!.push({
      contentHash: metadata.templateId,
      relationship: 'template',
      description: 'Template that structured the workflow',
    });
  }

  // Clean up empty derivedFrom
  if (provenance.derivedFrom!.length === 0) {
    delete provenance.derivedFrom;
  }

  return provenance;
}

function normalizeOutputFieldName(field: any): string | null {
  if (!field || typeof field !== 'object') return null;
  if (typeof field.path === 'string') {
    const match = field.path.match(/^\$\.result\.([A-Za-z0-9_]+)$/);
    if (match?.[1]) return match[1];
  }
  if (typeof field.name === 'string' && field.name.length > 0) {
    return field.name;
  }
  return null;
}

function getOutputFieldNames(outputSpec: any): { required: string[]; all: string[] } {
  const required: string[] = [];
  const all: string[] = [];

  if (Array.isArray(outputSpec?.fields)) {
    for (const field of outputSpec.fields) {
      const name = normalizeOutputFieldName(field);
      if (!name) continue;
      all.push(name);
      if (field?.required === true) {
        required.push(name);
      }
    }
  }

  if (all.length === 0 && outputSpec?.schema?.properties && typeof outputSpec.schema.properties === 'object') {
    const requiredSet = new Set(Array.isArray(outputSpec.schema.required) ? outputSpec.schema.required : []);
    for (const name of Object.keys(outputSpec.schema.properties)) {
      all.push(name);
      if (requiredSet.has(name)) required.push(name);
    }
  }

  if (
    all.length === 0 &&
    outputSpec?.properties &&
    typeof outputSpec.properties === 'object'
  ) {
    const requiredSet = new Set(Array.isArray(outputSpec.required) ? outputSpec.required : []);
    for (const name of Object.keys(outputSpec.properties)) {
      all.push(name);
      if (requiredSet.has(name)) required.push(name);
    }
  }

  return { required, all };
}

function extractJsonCandidates(text: string): any[] {
  if (!text || typeof text !== 'string') return [];
  const candidates: any[] = [];

  const fenced = text.matchAll(/```json\s*([\s\S]*?)```/gi);
  for (const match of fenced) {
    if (!match[1]) continue;
    try {
      candidates.push(JSON.parse(match[1]));
    } catch {
      // ignore
    }
  }

  let started = false;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let buffer = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!started) {
      if (ch === '{') {
        started = true;
        depth = 1;
        buffer = '{';
        inString = false;
        escapeNext = false;
      }
      continue;
    }

    buffer += ch;
    if (escapeNext) {
      escapeNext = false;
    } else if (ch === '\\' && inString) {
      escapeNext = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }

    if (started && depth === 0) {
      try {
        candidates.push(JSON.parse(buffer));
      } catch {
        // ignore
      }
      started = false;
      buffer = '';
      inString = false;
      escapeNext = false;
    }
  }

  return candidates;
}

function candidateScore(candidate: any, requiredFields: string[]): number {
  if (!candidate || typeof candidate !== 'object') return -1;
  const root = resolveCandidateRoot(candidate);
  return requiredFields.reduce((acc, field) => {
    if (root[field] !== undefined) return acc + 1;
    if (field === 'contentBody' && root.content !== undefined) return acc + 1;
    return acc;
  }, 0);
}

function coerceFromToolArgs(args: any): any | null {
  if (!args) return null;
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (typeof args === 'object') return args;
  return null;
}

function parseMaybeJson(value: any): any | null {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

function resolveCandidateRoot(candidate: any): any {
  if (!candidate || typeof candidate !== 'object') return candidate;
  if (candidate.result && typeof candidate.result === 'object') return candidate.result;
  const parsedContent = parseMaybeJson(candidate.content);
  if (parsedContent && typeof parsedContent === 'object') return parsedContent;
  return candidate;
}

function extractStructuredResult(
  result: AgentExecutionResult,
  outputSpec: any
): Record<string, any> | null {
  if (!outputSpec) return null;

  const { required, all } = getOutputFieldNames(outputSpec);
  const targetFields = all.length > 0 ? all : required;
  if (targetFields.length === 0) return null;

  const candidates: any[] = [];
  candidates.push(...extractJsonCandidates(result.output || ''));

  const toolCalls = Array.isArray((result as any)?.telemetry?.toolCalls)
    ? (result as any).telemetry.toolCalls
    : [];
  for (const call of toolCalls) {
    if (call?.tool !== 'create_artifact' || call?.success !== true) continue;
    const parsedArgs = coerceFromToolArgs(call.args);
    if (parsedArgs) {
      candidates.push(parsedArgs);
      const parsedContent = parseMaybeJson(parsedArgs.content);
      if (parsedContent) candidates.push(parsedContent);
    }
  }

  if (candidates.length === 0) return null;

  let best: any = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = candidateScore(candidate, required.length > 0 ? required : targetFields);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best) return null;

  const root = resolveCandidateRoot(best);
  const structured: Record<string, any> = {};
  for (const field of targetFields) {
    if (root[field] !== undefined) {
      structured[field] = root[field];
      continue;
    }
    if (field === 'contentBody' && root.content !== undefined) {
      structured[field] = root.content;
    }
  }

  return Object.keys(structured).length > 0 ? structured : null;
}

/**
 * Build delivery payload for IPFS registry
 */
export function buildDeliveryPayload(params: {
  requestId: string;
  result: AgentExecutionResult;
  metadata: IpfsMetadata;
  recognition?: RecognitionPhaseResult | null;
  reflection?: ReflectionResult | null;
  workerTelemetry?: any;
  finalStatus?: { status: string; message?: string };
  measurementCoverage?: MeasurementCoverage | null;
}): any {
  const { requestId, result, metadata, recognition, reflection, workerTelemetry, finalStatus, measurementCoverage } = params;
  const structuredResult = extractStructuredResult(result, metadata?.outputSpec);

  // Build execution provenance from available data
  const workerAddress = process.env.JINN_SERVICE_MECH_ADDRESS;
  const durationMs = result.telemetry?.durationMs || workerTelemetry?.durationMs;
  const provenance = buildExecutionProvenance({ requestId, metadata, workerAddress, durationMs });

  // Enrich artifacts with provenance metadata
  const artifacts = (result.artifacts || []).map((artifact) => ({
    ...artifact,
    provenance,
  }));

  return {
    requestId: String(requestId),
    output: result.output || '',
    structuredSummary: result.structuredSummary || result.output?.slice(-1200) || '',
    telemetry: result.telemetry || {},
    artifacts,
    provenance,
    ...(result.jobInstanceStatusUpdate ? { jobInstanceStatusUpdate: result.jobInstanceStatusUpdate } : {}),
    ...(metadata?.jobDefinitionId ? { jobDefinitionId: metadata.jobDefinitionId } : {}),
    ...(metadata?.jobName ? { jobName: metadata.jobName } : {}),
    ...(metadata?.blueprint ? { blueprint: metadata.blueprint } : {}),
    // Template passthrough: include templateId and outputSpec so x402 gateway can use them directly
    ...(metadata?.templateId ? { templateId: metadata.templateId } : {}),
    ...(metadata?.outputSpec ? { outputSpec: metadata.outputSpec } : {}),
    ...(structuredResult ? { result: structuredResult } : {}),
    ...(finalStatus ? { status: finalStatus.status, statusMessage: finalStatus.message } : {}),
    ...(workerTelemetry ? { workerTelemetry } : {}),
    ...(measurementCoverage ? { measurementCoverage } : {}),
    ...(recognition
      ? {
        recognition: {
          initialSituation: recognition.initialSituation,
          embeddingStatus: recognition.embeddingStatus,
          similarJobs: recognition.similarJobs,
          learnings: recognition.rawLearnings,
          learningsMarkdown: recognition.learningsMarkdown,
          searchQuery: recognition.searchQuery,
          progressCheckpoint: recognition.progressCheckpoint,
        },
      }
      : {}),
    ...(reflection
      ? {
        reflection: {
          output: reflection.output,
          telemetry: reflection.telemetry,
        },
      }
      : {}),
    ...(result.pullRequestUrl ? { pullRequestUrl: result.pullRequestUrl } : {}),
    ...(metadata?.codeMetadata?.branch?.name
      ? {
        executionPolicy: {
          branch: metadata.codeMetadata.branch.name,
          ensureTestsPass: true,
          description: 'Agent executed work on the provided branch and passed required validations.',
        },
      }
      : {}),
  };
}
