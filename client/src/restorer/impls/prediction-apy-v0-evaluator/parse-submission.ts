import {
  PredictionApySubmissionManifestSchema,
  type PredictionApySubmissionManifest,
} from '../../../types/prediction-apy.js';

/**
 * Parse a restoration submission for prediction.apy.v0. Engine-wrapped jobs store
 * the prediction under `gating` (see manifest assembly); direct IPFS manifests
 * use `prediction` per schema.
 */
export function parsePredictionApySubmissionManifest(manifestJson: string): PredictionApySubmissionManifest {
  const raw = JSON.parse(manifestJson) as Record<string, unknown>;
  const gating = raw['gating'] as Record<string, unknown> | undefined;
  const gatingBps = gating?.['predictedBps'];
  if (gating && (typeof gatingBps === 'string' || typeof gatingBps === 'number')) {
    const normalized = {
      schemaVersion: 'prediction.apy.v0.submission.v1',
      generatedAt: raw['generatedAt'] ?? Date.now(),
      intent: raw['intent'],
      restorer: raw['restorer'],
      window: raw['window'],
      prediction: {
        predictedBps: String(gatingBps),
        submittedAt: Number(gating['submittedAt'] ?? 0),
        modelId: String(gating['modelId'] ?? ''),
      },
      signature: raw['signature'],
    };
    return PredictionApySubmissionManifestSchema.parse(normalized);
  }
  return PredictionApySubmissionManifestSchema.parse(raw);
}
