/**
 * Narrow production adapter used by the harness-layer bridge.
 *
 * Schema parsing alone is not authentication: preserve the raw wire object for
 * the canonical hash check, then require the recovered signer to be the
 * participant EOA declared inside that same signed envelope.
 */
import { checkHashAndSignature } from './checks/hash-signature.js';
import { SignedEnvelopeSchema, type SignedEnvelope } from '../types/envelope.js';

export async function authenticateExecutionEnvelope(
  value: unknown,
  sourceName: string,
): Promise<SignedEnvelope> {
  const rawEnvelope =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  const parsed = SignedEnvelopeSchema.safeParse(value);
  if (!rawEnvelope || !parsed.success) {
    const detail = parsed.success
      ? 'expected an object'
      : parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
    throw new Error(`${sourceName} is not a valid signed execution envelope: ${detail}`);
  }

  const result = await checkHashAndSignature({
    envelopeCid: sourceName,
    rawEnvelope,
    envelope: parsed.data,
    options: {},
  });
  if (!result.passed) {
    throw new Error(`${sourceName} failed signature authentication: ${result.detail ?? 'unknown failure'}`);
  }

  if (
    parsed.data.signature.signer.toLowerCase()
    !== parsed.data.participant.agentEoa.toLowerCase()
  ) {
    throw new Error(
      `${sourceName} signature signer does not match participant.agentEoa`,
    );
  }

  return parsed.data;
}
