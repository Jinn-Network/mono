import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
} from '@jinn-network/task-execution-protocol';
import { recordPath } from '@jinn-network/record-discovery-protocol';
import { dssePreAuthEncoding } from '@jinn-network/trust-core';
import { buildNativeSolutionVerification } from '../../src/daemon/native-solution-verification.js';
import { buildNativeEvaluationSpecResolver } from '../../src/daemon/native-assembly.js';

const PAYLOAD_TYPE = 'application/vnd.jinn.marketplace.executor-binding.v1+json';
const ATTEMPT = 'urn:uuid:11111111-1111-4111-8111-111111111111' as const;
const SUBMISSION = 'urn:uuid:22222222-2222-4222-8222-222222222222' as const;
const EVALUATION_SPEC = new TextEncoder().encode('{"evaluation":"spec"}');
const OUTPUT = new TextEncoder().encode('{"probability":0.62}');
const EVIDENCE = new TextEncoder().encode('{"execution":"evidence"}');

function fixture(
  binding = { ok: true as const, bindingDigest: `sha256:${'9'.repeat(64)}` },
  resolveEvaluationSpecOverride?: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>,
) {
  const keys = generateKeyPairSync('ed25519');
  const keyId = 'did:key:z6MksolverDelivery';
  const evaluationDigest = documentDigest(EVALUATION_SPEC);
  const taskBytes = sealTask({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    profile: { uri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0', digest: { sha256: '1'.repeat(64) } },
    instructions: 'Predict.',
    outputs: [{ name: 'prediction', mediaType: 'application/json', required: true }],
    evaluation: { name: 'evaluation', digest: { sha256: evaluationDigest.slice(7) } },
  });
  const submissionBytes = sealSubmission({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    submission: SUBMISSION,
    task: { digest: { sha256: documentDigest(taskBytes).slice(7) } },
    requester: 'urn:uuid:33333333-3333-4333-8333-333333333333',
    idempotencyKey: 'verification-test',
    nonce: 'verification-nonce',
    deadline: '2099-01-01T00:00:00Z',
  });
  const dispatchContextBytes = serializeCanonicalJson({
    taskDigest: documentDigest(taskBytes),
    submission: SUBMISSION,
    nonce: 'verification-nonce',
    attempt: ATTEMPT,
  });
  const deliveryBytes = sealDelivery({
    protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
    attempt: ATTEMPT,
    task: documentDigest(taskBytes),
    outputs: [{ name: 'prediction', mediaType: 'application/json', digest: { sha256: documentDigest(OUTPUT).slice(7) } }],
    executionIds: ['urn:uuid:44444444-4444-4444-8444-444444444444'],
    evidenceRecords: [{ family: 'execution-evidence', digest: documentDigest(EVIDENCE) }],
    outcome: 'fulfilled',
    createdAt: '2026-08-02T00:05:00.000Z',
  });
  const signature = cryptoSign(null, dssePreAuthEncoding(PAYLOAD_TYPE, deliveryBytes), keys.privateKey);
  const deliveryEnvelopeBytes = new TextEncoder().encode(JSON.stringify({
    payloadType: PAYLOAD_TYPE,
    payload: Buffer.from(deliveryBytes).toString('base64'),
    signatures: [{ keyid: keyId, sig: signature.toString('base64') }],
  }));
  const resolveEffective = vi.fn(async () => binding);
  const resolveEvaluationSpec = vi.fn(
    resolveEvaluationSpecOverride ?? (async (): Promise<Uint8Array | undefined> => EVALUATION_SPEC),
  );
  const verification = buildNativeSolutionVerification({
    identities: {
      agent: 'urn:jinn:operator:solver-a',
      get: () => ({ role: 'solver-delivery' as const, keyId, publicKey: keys.publicKey, sign: () => new Uint8Array() }),
      resolveEffective,
    },
    resolveEvaluationSpec,
  });
  return {
    verification,
    resolveEffective,
    resolveEvaluationSpec,
    input: {
      engagement: {
        engagementId: `sha256:${'a'.repeat(64)}` as const,
        chainId: 84532,
        coordinator: '0x8a34793e10595c89b7e41Cc7Ff0F76850F44AD98',
        taskId: 7n,
        role: 'solver' as const,
        operatorAgent: 'urn:jinn:operator:solver-a',
        taskDigest: documentDigest(taskBytes),
        submissionUri: SUBMISSION,
        submissionDigest: documentDigest(submissionBytes),
        state: 'executing' as const,
        attemptIndex: 0,
        attemptUri: ATTEMPT,
        requestId: `0x${'b'.repeat(64)}`,
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      effectiveTime: '2026-08-02T00:05:00.000Z',
      taskBytes,
      submissionBytes,
      dispatchContextBytes,
      delivery: JSON.parse(new TextDecoder().decode(deliveryBytes)),
      deliveryBytes,
      deliveryEnvelopeBytes,
      outputs: [{
        engagementId: `sha256:${'a'.repeat(64)}` as const,
        role: 'output' as const,
        family: 'application/json',
        mediaType: 'application/json',
        name: 'prediction',
        digest: documentDigest(OUTPUT),
        bytes: OUTPUT,
        createdAt: '2026-08-02T00:05:00.000Z',
      }],
      evidence: [{
        engagementId: `sha256:${'a'.repeat(64)}` as const,
        role: 'evidence' as const,
        family: 'execution-evidence',
        mediaType: 'application/vnd.jinn.execution-evidence.v1+json',
        name: null,
        digest: documentDigest(EVIDENCE),
        bytes: EVIDENCE,
        createdAt: '2026-08-02T00:05:00.000Z',
      }],
    },
  };
}

describe('native solution verification', () => {
  it('verifies exact DSSE, dispatch, artifact graph, EvaluationSpec, and delivery-time binding', async () => {
    const subject = fixture();

    await expect(subject.verification.verify(subject.input)).resolves.toEqual({ ok: true });
    expect(subject.resolveEffective).toHaveBeenCalledWith('solver-delivery', '2026-08-02T00:05:00.000Z');
    expect(subject.resolveEvaluationSpec).toHaveBeenCalledWith(documentDigest(EVALUATION_SPEC));
  });

  it('fails when the effective-time resolver reports a revoked delivery key', async () => {
    const subject = fixture({ ok: false as const, reason: 'revoked' as const });
    await expect(subject.verification.verify(subject.input)).resolves.toEqual({
      ok: false,
      reason: 'delivery-binding-revoked',
    });
  });

  it('fails when the Task evaluation specification cannot be resolved exactly', async () => {
    const subject = fixture();
    subject.resolveEvaluationSpec.mockResolvedValueOnce(undefined);
    await expect(subject.verification.verify(subject.input)).resolves.toEqual({
      ok: false,
      reason: 'evaluation-spec-unavailable',
    });
  });

  // CP5 gate regression (#2461): the EvaluationSpec is a native record served ONLY over the
  // requester's HTTP plane and never pushed to IPFS. Before the HTTP-locator fallback the
  // production resolver (`buildNativeEvaluationSpecResolver`) tried IPFS only, so the solver's own
  // delivery self-verification aborted with `evaluation-spec-unavailable` and never published.
  const REQUESTER_BASE = 'https://requester.example.test';

  it('resolves the EvaluationSpec via the requester HTTP serving plane when IPFS misses', async () => {
    const evaluationDigest = documentDigest(EVALUATION_SPEC);
    const byDigest = vi.fn(async (): Promise<Uint8Array> => { throw new Error('ipfs block/get: not found'); });
    const byLocation = vi.fn(async (url: string): Promise<Uint8Array> => {
      if (url === `${REQUESTER_BASE}${recordPath(evaluationDigest)}`) return EVALUATION_SPEC;
      throw new Error(`unexpected serving-plane URL ${url}`);
    });
    const subject = fixture(
      undefined,
      buildNativeEvaluationSpecResolver({ byDigest, byLocation }, [REQUESTER_BASE]),
    );

    await expect(subject.verification.verify(subject.input)).resolves.toEqual({ ok: true });
    expect(byDigest).toHaveBeenCalledWith(evaluationDigest);
    expect(byLocation).toHaveBeenCalledWith(`${REQUESTER_BASE}${recordPath(evaluationDigest)}`);
  });

  it('fails closed when the HTTP serving plane returns wrong bytes for the EvaluationSpec digest', async () => {
    const byDigest = vi.fn(async (): Promise<Uint8Array> => { throw new Error('ipfs block/get: not found'); });
    const byLocation = vi.fn(async (): Promise<Uint8Array> => new TextEncoder().encode('{"evaluation":"tampered"}'));
    const subject = fixture(
      undefined,
      buildNativeEvaluationSpecResolver({ byDigest, byLocation }, [REQUESTER_BASE]),
    );

    await expect(subject.verification.verify(subject.input)).resolves.toEqual({
      ok: false,
      reason: 'evaluation-spec-unavailable',
    });
  });
});
