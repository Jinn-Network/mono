import { describe, expect, it } from 'vitest';
import { RECORD_KINDS, assertRecordKindUri } from '@jinn-network/record-discovery-protocol';
import { RECORD_KINDS_SUBMISSION } from '@jinn-network/marketplace-pipeline';
import { REPOSITORY_WORK_PROFILE_URI } from '@jinn-network/task-execution-profiles';
import { synthesizeLegacyFactsCard, LEGACY_ENVELOPE_EXTENSION_KEY, signedEnvelopeJsonFromDeliveryOrRaw } from '../../src/daemon/bridge-legacy-delivery.js';
import {
  LEGACY_SUBMISSION_RECORD_KIND,
  mapAnnouncedSubmissionToFacts,
} from '../../src/daemon/native-submission-facts.js';

const ANCHORED_TASK = {
  taskId: 77n,
  manifestDigest: 'QmSolver',
  taskCidDigest: `0x${'a'.repeat(64)}` as const,
  taskBytes: new TextEncoder().encode(
    JSON.stringify({ protocol: 'https://jinn.network/profiles/task-execution/1.0' }),
  ),
  solutionBudgetWei: 1_000_000_000_000n,
};

// The equality test `facts-mapper-kinds.ts` promises. The frozen bridge-era kind is Phase C
// legacy behavior (spec 2026-08-03-phase-c-capability-boundaries.md §3, §5): it stays in
// lock-step with the pipeline's duplicated-by-value constant, is deliberately NOT the native
// `RECORD_KINDS.submission`, and is deliberately outside the record-kind grammar so it can
// never collide with a native record kind.
describe('bridge-era legacy record kind invariants', () => {
  it('stays frozen at the bridge-era value', () => {
    expect(LEGACY_SUBMISSION_RECORD_KIND).toBe(
      'https://jinn.network/records/task-execution/submission/1.0',
    );
  });

  it('stays in lock-step with the pipeline duplicated-by-value constant', () => {
    expect(RECORD_KINDS_SUBMISSION).toBe(LEGACY_SUBMISSION_RECORD_KIND);
  });

  it('is not the native submission record kind', () => {
    expect(LEGACY_SUBMISSION_RECORD_KIND).not.toBe(RECORD_KINDS.submission);
  });

  it('is deliberately outside the native record-kind grammar', () => {
    expect(() => assertRecordKindUri(LEGACY_SUBMISSION_RECORD_KIND)).toThrow();
  });

  it('the native submission and delivery kinds are grammar-valid', () => {
    expect(() => assertRecordKindUri(RECORD_KINDS.submission)).not.toThrow();
    expect(() => assertRecordKindUri(RECORD_KINDS.delivery)).not.toThrow();
  });
});

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

describe('signedEnvelopeJsonFromDeliveryOrRaw (E43)', () => {
  it('unwraps the nested bridge envelope from a sealed Delivery-shaped document', () => {
    const nested = { schemaVersion: 'jinn.execution.v1', solverType: 'prediction.v1', role: 'solution' };
    const delivery = {
      protocol: 'https://jinn.network/profiles/task-execution/1.0',
      [LEGACY_ENVELOPE_EXTENSION_KEY]: JSON.stringify(nested),
    };
    expect(signedEnvelopeJsonFromDeliveryOrRaw(delivery)).toEqual(nested);
  });

  it('passes through a bare SignedEnvelope (pre-bridge fixtures)', () => {
    const bare = { schemaVersion: 'jinn.execution.v1', solverType: 'prediction.v1' };
    expect(signedEnvelopeJsonFromDeliveryOrRaw(bare)).toBe(bare);
  });
});
