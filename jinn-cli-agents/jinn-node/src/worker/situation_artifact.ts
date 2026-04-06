import { embedText } from '../agent/mcp/tools/embed_text.js';
import { createArtifact as mcpCreateArtifact } from '../agent/mcp/tools/create_artifact.js';
import { safeParseToolResponse } from './tool_utils.js';
import { encodeSituation, enrichSituation } from './situation_encoder.js';
import { workerLogger } from '../logging/index.js';
import { secrets } from '../config/index.js';
import { createArtifact as apiCreateArtifact } from './control_api_client.js';
import type { RecognitionPhaseResult } from './recognition_helpers.js';

type UnclaimedRequest = {
  id: string;
  mech: string;
  requester: string;
  blockTimestamp?: number;
  ipfsHash?: string;
  delivered?: boolean;
};

export async function generateEmbeddingVector(text: string, model?: string, dim?: number) {
  const args: Record<string, unknown> = { text };
  if (model) args.model = model;
  if (typeof dim === 'number') args.dim = dim;

  const response = await embedText(args);
  const parsed = safeParseToolResponse(response);
  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.message || 'embed_text tool failed');
  }
  if (!Array.isArray(parsed.data.vector)) {
    throw new Error('Embedding result missing vector');
  }
  return parsed.data as { model: string; dim: number; vector: number[] };
}

async function uploadSituationArtifactContent(params: { name: string; content: string }) {
  const response = await mcpCreateArtifact({
    name: params.name,
    topic: 'SITUATION',
    content: params.content,
    type: 'SITUATION',
  });
  const parsed = safeParseToolResponse(response);
  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.message || 'create_artifact tool failed');
  }
  return parsed.data as { cid: string; name?: string; topic: string; contentPreview?: string };
}

export interface CreateSituationArtifactArgs {
  target: UnclaimedRequest;
  metadata: any;
  result: any;
  finalStatus: { status: string } | null;
  recognition?: RecognitionPhaseResult | null;
}

export async function createSituationArtifactForRequest(args: CreateSituationArtifactArgs): Promise<void> {
  // Create situation artifacts for ALL job completions (including FAILED)
  // Learning from failures is just as important as learning from successes
  if (!args.finalStatus) {
    return;
  }

  try {
    const existingArtifacts = Array.isArray(args.result?.artifacts) ? args.result.artifacts : [];
    
    // Use enrichment flow if initial situation exists, otherwise fall back to full encoding
    let situation: any;
    let summaryText: string;
    
    // Model from job metadata, then flash
    const runtimeModel = args.metadata?.model || 'gemini-2.5-flash';
    
    if (args.recognition?.initialSituation) {
      if (args.recognition.initialSituation.job && !args.recognition.initialSituation.job.model) {
        args.recognition.initialSituation.job.model = runtimeModel;
      }
      const enrichResult = await enrichSituation({
        initialSituation: args.recognition.initialSituation,
        output: typeof args.result?.output === 'string' ? args.result.output : JSON.stringify(args.result?.output ?? ''),
        telemetry: args.result?.telemetry || {},
        finalStatus: args.finalStatus.status,
        artifacts: existingArtifacts,
      });
      situation = enrichResult.situation;
      summaryText = enrichResult.summaryText;
    } else {
      // Fallback to full encoding if no initial situation (e.g., recognition disabled)
      const encodeResult = await encodeSituation({
        requestId: args.target.id,
        jobName: args.metadata?.jobName,
        jobDefinitionId: args.metadata?.jobDefinitionId,
        output: typeof args.result?.output === 'string' ? args.result.output : JSON.stringify(args.result?.output ?? ''),
        telemetry: args.result?.telemetry || {},
        finalStatus: args.finalStatus.status,
        additionalContext: args.metadata?.additionalContext,
        artifacts: existingArtifacts,
        model: runtimeModel,
      });
      situation = encodeResult.situation;
      summaryText = encodeResult.summaryText;
    }

    const embedModel = process.env.SITUATION_EMBED_MODEL || 'text-embedding-3-small';
    const embedDim = process.env.SITUATION_EMBED_DIM ? Number(process.env.SITUATION_EMBED_DIM) : 256;
    let embedding: { model: string; dim: number; vector: number[] } | null = null;
    let embeddingStatus = 'unknown';
    if (!secrets.openaiApiKey) {
      embeddingStatus = 'skipped_missing_openai';
      workerLogger.info({ requestId: args.target.id }, 'Skipping embedding: OPENAI_API_KEY not set');
    } else {
      try {
        embedding = await generateEmbeddingVector(summaryText, embedModel, embedDim);
        embeddingStatus = 'ok';
      } catch (embedError: any) {
        embeddingStatus = 'failed';
        workerLogger.warn({ requestId: args.target.id, error: embedError?.message || String(embedError) }, 'Embedding failed; continuing without vector');
      }
    }

    const situationArtifact: any = {
      ...situation,
      ...(embedding ? { embedding } : {}),
      meta: {
        summaryText,
        embeddingStatus,
        recognition: args.recognition && (args.recognition.learningsMarkdown || args.recognition.rawLearnings || args.recognition.initialSituation)
          ? {
            searchQuery: args.recognition.searchQuery,
            similarJobs: args.recognition.similarJobs,
            markdown: args.recognition.learningsMarkdown,
            learnings: args.recognition.rawLearnings,
            initialSituation: args.recognition.initialSituation,
            embeddingStatus: args.recognition.embeddingStatus || embeddingStatus || 'unknown',
          }
          : undefined,
        generatedAt: new Date().toISOString(),
      },
    };

    // Clean up undefined/null fields in recognition to reduce payload size
    // But preserve the recognition object even if only metadata fields remain
    if (situationArtifact.meta?.recognition) {
      const recognition: Record<string, unknown> = situationArtifact.meta.recognition;
      // Only delete fields that are explicitly null or undefined
      Object.keys(recognition).forEach((key) => {
        if (recognition[key] === null || recognition[key] === undefined) {
          delete recognition[key];
        }
      });
      
      // Only delete recognition if ALL fields were null/undefined (empty object)
      // Keep it even if we only have searchQuery, similarJobs, or embeddingStatus
      if (Object.keys(recognition).length === 0) {
        delete situationArtifact.meta.recognition;
      }
    }

    const artifactName = `situation-${args.target.id}`;
    const payload = JSON.stringify(situationArtifact, null, 2);
    const uploaded = await uploadSituationArtifactContent({ name: artifactName, content: payload });

    const artifactRecord = {
      cid: uploaded.cid,
      topic: 'SITUATION',
      name: uploaded.name || artifactName,
      contentPreview: uploaded.contentPreview,
      type: 'SITUATION',  // Add type field for Ponder indexing
    };

    const updatedArtifacts = [...existingArtifacts, artifactRecord];
    (args.result as any).artifacts = updatedArtifacts;

    try {
      await apiCreateArtifact(args.target.id, { cid: uploaded.cid, topic: 'SITUATION', content: null });
    } catch (apiError: any) {
      workerLogger.warn({ requestId: args.target.id, error: apiError?.message || String(apiError) }, 'Failed to persist situation artifact via Control API');
    }

    workerLogger.info({ requestId: args.target.id, cid: uploaded.cid }, 'Situation artifact created');
  } catch (error: any) {
    workerLogger.warn({ requestId: args.target.id, error: error?.message || String(error) }, 'Failed to create situation artifact');
  }
}
