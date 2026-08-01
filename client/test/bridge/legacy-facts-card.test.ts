import { describe, expect, it } from 'vitest';
import { mapAnnouncedSubmissionToFacts } from '@jinn-network/marketplace-pipeline';
import { REPOSITORY_WORK_PROFILE_URI } from '@jinn-network/task-execution-profiles';
import { synthesizeLegacyFactsCard } from '../../src/daemon/bridge-legacy-delivery.js';

const ANCHORED_TASK = {
  taskId: 77n,
  manifestDigest: 'QmSolver',
  taskCidDigest: `0x${'a'.repeat(64)}` as const,
  taskBytes: new TextEncoder().encode(
    JSON.stringify({ protocol: 'https://jinn.network/profiles/task-execution/1.0' }),
  ),
  solutionBudgetWei: 1_000_000_000_000n,
};

describe('bridge-era legacy facts card', () => {
  it('synthesizes a submission card under the legacy derivation annotation', () => {
    const card = synthesizeLegacyFactsCard(ANCHORED_TASK);
    expect(card.derivationKind).toBe('legacy');
    expect(card.legacyManifestDigest).toBe('QmSolver');
    expect(card.record.kind).toBe(
      'https://jinn.network/records/task-execution/submission/1.0',
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
