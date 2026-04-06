/**
 * Artifact extraction and consolidation from execution output and telemetry
 */

import { extractArtifactsFromOutput, extractArtifactsFromTelemetry } from '../artifacts.js';
import { createArtifact } from '../control_api_client.js';
import type { AgentExecutionResult } from '../types.js';

/**
 * Extract and consolidate artifacts from execution result
 */
export async function consolidateArtifacts(
  result: AgentExecutionResult,
  requestId: string
): Promise<AgentExecutionResult> {
  const artifacts = [
    ...extractArtifactsFromOutput(result?.output || ''),
    ...extractArtifactsFromTelemetry(result?.telemetry || {}),
  ];

  if (artifacts.length > 0) {
    // Store artifacts via Control API
    for (const artifact of artifacts) {
      try {
        await createArtifact(requestId, {
          cid: artifact.cid,
          topic: artifact.topic,
          content: null,
        });
      } catch (error) {
        // Non-critical - artifacts may already exist
      }
    }

    return {
      ...result,
      artifacts,
    };
  }

  return result;
}

/**
 * Extract artifacts from error telemetry
 */
export async function extractArtifactsFromError(
  errorTelemetry: any,
  requestId: string
): Promise<Array<{ cid: string; topic: string }>> {
  const artifacts = extractArtifactsFromTelemetry(errorTelemetry || {});
  
  if (artifacts.length > 0) {
    for (const artifact of artifacts) {
      try {
        await createArtifact(requestId, {
          cid: artifact.cid,
          topic: artifact.topic,
          content: null,
        });
      } catch (error) {
        // Non-critical
      }
    }
  }
  
  return artifacts;
}

