/**
 * Build MEMORY type artifacts for reflection
 */

import { extractArtifactsFromOutput, extractArtifactsFromTelemetry, type ExtractedArtifact } from '../artifacts.js';
import type { ReflectionResult } from '../types.js';

/**
 * Extract MEMORY artifacts emitted during reflection.
 *
 * Reflection runs as a separate Gemini invocation, so the artifacts it produces
 * are not captured by the execution-phase consolidator. This helper surfaces
 * those artifacts so they can be merged into the delivery payload.
 */
export function extractMemoryArtifacts(reflection: ReflectionResult | null): ExtractedArtifact[] {
  if (!reflection) {
    return [];
  }

  const artifacts: ExtractedArtifact[] = [
    ...extractArtifactsFromTelemetry(reflection.telemetry || {}),
    ...extractArtifactsFromOutput(reflection.output || ''),
  ];

  if (artifacts.length === 0) {
  return [];
  }

  const seen = new Set<string>();

  return artifacts
    .filter((artifact) => {
      const type = artifact.type?.toUpperCase();
      if (type === 'MEMORY') return true;
      const topic = artifact.topic?.toLowerCase();
      return !type && topic === 'learnings';
    })
    .filter((artifact) => {
      const key = `${artifact.cid}|${artifact.topic}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((artifact) => ({
      ...artifact,
      type: artifact.type ?? 'MEMORY',
    }));
}

