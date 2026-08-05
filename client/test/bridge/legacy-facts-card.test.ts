import { describe, expect, it } from 'vitest';
import { REPOSITORY_WORK_PROFILE_URI } from '@jinn-network/task-execution-profiles';
import { synthesizeLegacyFactsCard, LEGACY_ENVELOPE_EXTENSION_KEY, signedEnvelopeJsonFromDeliveryOrRaw } from '../../src/daemon/bridge-legacy-delivery.js';
import { mapAnnouncedSubmissionToFacts } from '../../src/daemon/native-submission-facts.js';

const ANCHORED_TASK = {
  taskId: 77n,
  manifestDigest: 'QmSolver',
  taskCidDigest: `0x${'a'.repeat(64)}` as const,
  taskBytes: new TextEncoder().encode(
    JSON.stringify({ protocol: 'https://spec.jinn.network/profiles/task-execution/v1' }),
  ),
  solutionBudgetWei: 1_000_000_000_000n,
};

describe('bridge-era legacy facts card', () => {
  it('synthesizes a submission card under the legacy derivation annotation', () => {
    const card = synthesizeLegacyFactsCard(ANCHORED_TASK);
    expect(card.derivationKind).toBe('legacy');
    expect(card.legacyManifestDigest).toBe('QmSolver');
    expect(card.record.kind).toBe(
      'https://spec.jinn.network/records/submission/v1',
    );
  });

  // E39 (diagnose→fix cycle 2): this used to hardcode a stale URI that no real backend's
  // `capabilities.taskProfiles` ever registers, so `verifyPreclaim` declined every legacy-bridged
  // card `profile-mismatch` regardless of backend capability. Must match the actual constant every
  // backend advertises, not a copy of the string.
  it('names the real repository-work profile URI every backend actually registers', () => {
    const card = synthesizeLegacyFactsCard(ANCHORED_TASK);
    expect(card.facts['taskProfileUri']).toBe(REPOSITORY_WORK_PROFILE_URI);
  });

  it('maps cleanly through the pipeline facts mapper with the bridge accepted', () => {
    const result = mapAnnouncedSubmissionToFacts(synthesizeLegacyFactsCard(ANCHORED_TASK), {
      estimateAiUnits: () => 1,
      acceptLegacyCards: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.facts.workKind).toBe('QmSolver');
    expect(result.facts.legacyManifestDigest).toBe('QmSolver');
    expect(result.facts.taskId).toBe(77n);
  });

  it('is refused once the bridge retires at stage 5', () => {
    expect(
      mapAnnouncedSubmissionToFacts(synthesizeLegacyFactsCard(ANCHORED_TASK), {
        estimateAiUnits: () => 1,
        acceptLegacyCards: false,
      }).ok,
    ).toBe(false);
  });
});

describe('signedEnvelopeJsonFromDeliveryOrRaw (E43)', () => {
  it('unwraps the nested bridge envelope from a sealed Delivery-shaped document', () => {
    const nested = { schemaVersion: 'jinn.execution.v1', solverType: 'prediction.v1', role: 'solution' };
    const delivery = {
      protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
      [LEGACY_ENVELOPE_EXTENSION_KEY]: JSON.stringify(nested),
    };
    expect(signedEnvelopeJsonFromDeliveryOrRaw(delivery)).toEqual(nested);
  });

  it('passes through a bare SignedEnvelope (pre-bridge fixtures)', () => {
    const bare = { schemaVersion: 'jinn.execution.v1', solverType: 'prediction.v1' };
    expect(signedEnvelopeJsonFromDeliveryOrRaw(bare)).toBe(bare);
  });
});
