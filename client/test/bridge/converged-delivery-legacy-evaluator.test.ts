import { describe, expect, it } from 'vitest';
import { sealDelivery } from '@jinn-network/task-execution-protocol';
import { SignedEnvelopeSchema } from '../../src/types/envelope.js';
import { legacyRestorationResultFromDelivery } from '../../src/daemon/bridge-legacy-delivery.js';

/** Exactly the shape `LocalTaskExecutionBackend` seals (assembly/src/backend.ts:1585). */
function convergedDelivery(legacyEnvelope: unknown): Uint8Array {
  return sealDelivery({
    protocol: 'https://jinn.network/profiles/task-execution/1.0',
    attempt: 'urn:uuid:11111111-2222-3333-4444-555555555555',
    task: `sha256:${'b'.repeat(64)}`,
    outputs: [
      {
        name: 'prediction.json',
        mediaType: 'application/json',
        digest: { sha256: 'c'.repeat(64) },
      },
    ],
    outcome: 'fulfilled',
    executionIds: ['urn:uuid:22222222-3333-4444-5555-666666666666'],
    evidenceRecords: [
      { repository: 'urn:jinn:evidence:repository:local', record: `sha256:${'d'.repeat(64)}` },
    ],
    createdAt: '2026-07-30T09:00:00.000Z',
    // Bridge annotation — namespaced extension, permitted by DeliveryRecordSchema's `.loose()`
    // and TEP §21.3. Task 15 makes the backend emit it.
    'https://jinn.network/bridge/legacy-execution-envelope/1.0': JSON.stringify(legacyEnvelope),
  } as never);
}

const LEGACY_ENVELOPE = {
  schemaVersion: 'jinn.execution.v1',
  solverType: 'prediction.v1',
  role: 'solution',
  generatedAt: '2026-07-30T09:00:00.000Z',
  participant: '0x1111111111111111111111111111111111111111',
  window: { start: '2026-07-30T08:00:00.000Z', end: '2026-07-30T09:00:00.000Z' },
  executor: { kind: 'harness', name: 'claude-code', version: '1.0.0' },
  evidenceTier: 'self-signed',
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: { prediction: 0.42 },
  signature: {
    algo: 'secp256k1',
    signer: '0x1111111111111111111111111111111111111111',
    hash: `0x${'e'.repeat(64)}`,
    sig: `0x${'f'.repeat(130)}`,
  },
};

describe('converged Delivery is parseable by the legacy evaluator path', () => {
  it('yields a restorationResult string the legacy evaluator schema accepts', () => {
    const restorationResult = legacyRestorationResultFromDelivery(
      convergedDelivery(LEGACY_ENVELOPE),
    );
    expect(typeof restorationResult).toBe('string');
    const parsed = SignedEnvelopeSchema.parse(JSON.parse(restorationResult!));
    expect(parsed.schemaVersion).toBe('jinn.execution.v1');
    expect(parsed.solverType).toBe('prediction.v1');
    expect(parsed.role).toBe('solution');
  });

  it('returns undefined for a Delivery carrying no bridge annotation', () => {
    const bare = sealDelivery({
      protocol: 'https://jinn.network/profiles/task-execution/1.0',
      attempt: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      task: `sha256:${'b'.repeat(64)}`,
      outputs: [],
      outcome: 'fulfilled',
      executionIds: ['urn:uuid:22222222-3333-4444-5555-666666666666'],
      evidenceRecords: [
        { repository: 'urn:jinn:evidence:repository:local', record: `sha256:${'d'.repeat(64)}` },
      ],
      createdAt: '2026-07-30T09:00:00.000Z',
    } as never);
    expect(legacyRestorationResultFromDelivery(bare)).toBeUndefined();
  });

  it('still passes the binding admission check with the bridge annotation present', async () => {
    const { inspectDelivery } = await import('@jinn-network/marketplace-binding');
    expect(() => inspectDelivery(convergedDelivery(LEGACY_ENVELOPE))).not.toThrow();
  });
});
