import { describe, expect, it } from 'vitest';
import {
  buildPhaseBClosureManifest,
  parseValidatedPhaseBClosureManifest,
} from '../../src/daemon/phase-b-closure-manifest.js';
import { phaseBClosureFixture } from '../_support/phase-b-closure-fixture.js';

describe('Phase B closure artifact manifest', () => {
  it('canonicalizes and validates the exact public closure graph', () => {
    const bytes = buildPhaseBClosureManifest(phaseBClosureFixture());
    const validated = parseValidatedPhaseBClosureManifest(bytes);
    expect(validated.manifest.liveRun).toBe(true);
    expect(validated.manifest.publicRoles).toHaveLength(7);
    expect(validated.manifest.recordRoots).toHaveLength(15);
    expect(validated.manifest.recoveryReports).toHaveLength(6);
    expect(validated.manifest.acceptanceCriteria).toHaveLength(62);
    expect(validated.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('rejects duplicate authority, private paths, and settlement aliasing', () => {
    const duplicate = phaseBClosureFixture();
    duplicate.publicRoles[1]!.keyId = duplicate.publicRoles[0]!.keyId;
    expect(() => buildPhaseBClosureManifest(duplicate)).toThrow(/duplicate authority/u);

    const privatePath = phaseBClosureFixture() as unknown as Record<string, unknown>;
    privatePath['producerPath'] = '/var/lib/jinn/private';
    expect(() => buildPhaseBClosureManifest(privatePath as never)).toThrow(/forbidden field/u);

    const aliased = phaseBClosureFixture();
    aliased.settlements.verdict.operationId = aliased.settlements.solution.operationId;
    const bytes = buildPhaseBClosureManifest(aliased);
    expect(() => parseValidatedPhaseBClosureManifest(bytes)).toThrow(/independent/u);
  });

  it('rejects a missing exact root role and a BaseScan URL that names another transaction', () => {
    const missing = phaseBClosureFixture();
    missing.recordRoots.pop();
    expect(() => buildPhaseBClosureManifest(missing)).toThrow(/exact Phase B closure set/u);

    const wrongUrl = phaseBClosureFixture();
    wrongUrl.settlements.solution.baseScanUrl = wrongUrl.settlements.verdict.baseScanUrl;
    expect(() => buildPhaseBClosureManifest(wrongUrl)).toThrow(/does not bind transactionHash/u);
  });

  it('requires one evidenced passing result for every numbered Phase B acceptance criterion', () => {
    const missing = phaseBClosureFixture();
    missing.acceptanceCriteria.pop();
    expect(() => buildPhaseBClosureManifest(missing)).toThrow(/62 acceptance criteria/u);

    const duplicated = phaseBClosureFixture();
    duplicated.acceptanceCriteria[61]!.id = 61;
    expect(() => buildPhaseBClosureManifest(duplicated)).toThrow(/62 acceptance criteria/u);
  });
});
