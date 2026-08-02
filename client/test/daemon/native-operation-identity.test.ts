import { describe, expect, it } from 'vitest';
import {
  backendSubmissionOperationId,
  claimOperationId,
  engagementIdentityDocument,
  engagementId,
  evaluationId,
  evaluationClaimOperationId,
  evaluationBackendSubmissionOperationId,
  evaluationMarketplaceDeliveryOperationId,
  publicationKey,
  solutionSettlementId,
  verdictSettlementId,
} from '../../src/daemon/native-operation-identity.js';

const CHAIN = {
  chainId: 84532,
  coordinator: '0x8A34793e10595c89B7e41Cc7Ff0F76850F44AD98',
  taskId: 42n,
  operatorAgent: 'urn:jinn:operator:solver-a',
} as const;

describe('native operation identities', () => {
  it('derives a stable engagement from canonical values, not object order or address case', () => {
    const expected = engagementId(CHAIN);
    expect(engagementIdentityDocument(CHAIN)).toEqual({
      v: 1,
      chainId: '84532',
      coordinator: '0x8a34793e10595c89b7e41cc7ff0f76850f44ad98',
      taskId: '42',
      role: 'solver',
      agent: 'urn:jinn:operator:solver-a',
    });
    expect(expected).toBe('sha256:73cb260b4df398dce7d4f62f28256270b75ea8e08f67fcc373f5baf6c5ca5ce9');
    expect(engagementId({
      operatorAgent: CHAIN.operatorAgent,
      taskId: 42n,
      coordinator: CHAIN.coordinator.toLowerCase(),
      chainId: 84532,
    })).toBe(expected);
    expect(engagementId({ ...CHAIN, taskId: 43n })).not.toBe(expected);
  });

  it('derives each logical operation from its durable protocol identity', () => {
    const engagement = engagementId(CHAIN);
    const claim = claimOperationId(engagement);
    const backendSubmission = backendSubmissionOperationId({
      engagementId: engagement,
      attempt: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    });
    const solution = solutionSettlementId({
      attempt: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      deliveryDigest: `sha256:${'a'.repeat(64)}`,
    });
    const evaluation = evaluationId({
      subjectTaskDigest: `sha256:${'b'.repeat(64)}`,
      subjectDeliveryDigest: `sha256:${'c'.repeat(64)}`,
      evaluatorAgent: 'urn:jinn:evaluator:one',
    });
    const verdict = verdictSettlementId({
      evaluationAttempt: 'urn:uuid:22222222-2222-4222-8222-222222222222',
      evaluationDeliveryDigest: `sha256:${'d'.repeat(64)}`,
      verdictCode: 1,
    });
    const evaluationClaim = evaluationClaimOperationId(evaluation);
    const evaluationBackend = evaluationBackendSubmissionOperationId({
      evaluationId: evaluation,
      attempt: 'urn:uuid:22222222-2222-4222-8222-222222222222',
    });
    const evaluationDelivery = evaluationMarketplaceDeliveryOperationId({
      evaluationAttempt: 'urn:uuid:22222222-2222-4222-8222-222222222222',
      evaluationDeliveryDigest: `sha256:${'d'.repeat(64)}`,
    });
    expect(new Set([
      engagement, claim, backendSubmission, solution, evaluation, evaluationClaim,
      evaluationBackend, evaluationDelivery, verdict,
    ]).size).toBe(9);
    expect(claim).toBe('sha256:1238bc787b25ad43ab898dd26e5c4b17d644a121869d670203ae9c99cb03173a');
    expect(solution).toBe('sha256:f0f3118e3a3022d1463559d93c08ed4884b7d570d2a09195172a0392fd723468');
    expect(evaluation).toBe('sha256:6c371f84fe63c6fc0891be0317282fde3e330e11d9a6ed64106fb8788302c49f');
    expect(verdict).toBe('sha256:c7bc2469972973153f599ef664f4ab538037d93825b6ec5eac288db3b0c34943');
  });

  it('includes availability state in the publication key', () => {
    const available = publicationKey({
      sourceId: 'urn:jinn:source:solver',
      role: 'delivery',
      recordDigest: `sha256:${'e'.repeat(64)}`,
      availabilityState: 'available',
    });
    const withdrawn = publicationKey({
      sourceId: 'urn:jinn:source:solver',
      role: 'delivery',
      recordDigest: `sha256:${'e'.repeat(64)}`,
      availabilityState: 'withdrawn',
    });
    expect(available).not.toBe(withdrawn);
    expect(available).toBe('sha256:fef151e02620066e00eeac15712162daa722448d4dfef7d353e787f82af25bb1');
  });

  it('refuses unsafe or ambiguous marketplace identity values', () => {
    expect(() => engagementId({ ...CHAIN, chainId: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/u);
    expect(() => engagementId({ ...CHAIN, taskId: -1n })).toThrow(/non-negative/u);
    expect(() => engagementId({ ...CHAIN, coordinator: '0x1234' })).toThrow(/20-byte/u);
    expect(() => engagementId({ ...CHAIN, operatorAgent: '' })).toThrow(/must not be empty/u);
  });
});
