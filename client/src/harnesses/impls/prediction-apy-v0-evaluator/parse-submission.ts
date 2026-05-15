import { SignedEnvelopeSchema, normalizeEnvelopeRole } from '../../../types/envelope.js';
import type { SignedEnvelope } from '../../../types/envelope.js';
import { PredictionApyV0RestorationPayloadSchema } from '../../../types/payloads/prediction-apy-v0.js';
import type { PredictionApyV0RestorationPayload } from '../../../types/payloads/prediction-apy-v0.js';

/**
 * Parse a solution submission envelope for prediction.apy.v0.
 *
 * Solutions are published as jinn.execution.v1 SignedEnvelopes with
 * solverType='prediction.apy.v0' and role='solution'. The prediction payload
 * lives at envelope.payload per PredictionApyV0RestorationPayloadSchema.
 *
 * Returns both the envelope (for signature / task provenance) and the
 * typed payload (for prediction fields).
 */
export function parsePredictionApySubmissionEnvelope(manifestJson: string): {
  envelope: SignedEnvelope;
  payload: PredictionApyV0RestorationPayload;
} {
  const raw = JSON.parse(manifestJson) as Record<string, unknown>;
  const envelope = SignedEnvelopeSchema.parse(raw);
  if (
    envelope.solverType !== 'prediction.apy.v0' ||
    normalizeEnvelopeRole(envelope.role) !== 'solution'
  ) {
    throw new Error(
      `Unexpected envelope kind/role: ${envelope.solverType}/${envelope.role}; expected prediction.apy.v0/solution`,
    );
  }
  const payload = PredictionApyV0RestorationPayloadSchema.parse(envelope.payload);
  return { envelope, payload };
}
