/**
 * Telemetry augmentation: merge recognition prefix into metadata
 */

import type { RecognitionPhaseResult } from '../recognition_helpers.js';
import type { IpfsMetadata } from '../types.js';

/**
 * Augment metadata prompt with recognition learnings and progress checkpoint
 */
export function augmentPromptWithRecognition(
  metadata: IpfsMetadata,
  recognition: RecognitionPhaseResult | null
): IpfsMetadata {
  const parts: string[] = [];
  
  // Add recognition learnings if available
  if (recognition?.promptPrefix) {
    const prefix = recognition.promptPrefix.trim();
    if (prefix.length > 0) {
      parts.push(prefix);
    }
  }
  
  // Add progress checkpoint if available
  if (recognition?.progressCheckpoint?.checkpointSummary) {
    const checkpoint = recognition.progressCheckpoint.checkpointSummary.trim();
    if (checkpoint.length > 0) {
      // Wrap checkpoint in clear read-only framing
      parts.push(`---
## Historical Progress (Read-Only Context)

The following information describes work completed in prior runs. This is historical data for your awareness.
**DO NOT poll for updates, check status, or wait for children** - this context is frozen at job start time.

${checkpoint}
---`);
    }
  }
  
  // If no augmentation, return original metadata
  if (parts.length === 0) {
    return metadata;
  }
  
  const originalBlueprint = metadata?.blueprint || '';
  return {
    ...metadata,
    blueprint: `${parts.join('\n\n')}\n\n${originalBlueprint}`,
  };
}

