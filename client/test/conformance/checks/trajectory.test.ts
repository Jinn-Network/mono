import { describe, it, expect } from 'vitest';
import { checkTrajectorySchema } from '../../../src/conformance/checks/trajectory-schema.js';
import { checkHashChainIntegrity } from '../../../src/conformance/checks/trajectory-chain.js';
import { checkSpanProfile } from '../../../src/conformance/checks/trajectory-profile.js';
import {
  buildGoodTrajectoryFixture,
  FIXTURE_ARTIFACT_CID,
} from '../fixtures/good-trajectory.js';
import type { ConformanceContext } from '../../../src/conformance/types.js';

// Helpers to build a minimal context
function trajCtx(
  intentCid: string,
  trajectoryOverride?: unknown,
  envelopeOverride?: unknown,
): Pick<ConformanceContext, 'trajectory' | 'envelope' | 'envelopeCid' | 'options'> {
  const traj =
    trajectoryOverride === undefined
      ? buildGoodTrajectoryFixture(intentCid)
      : trajectoryOverride;
  const env = envelopeOverride ?? {
    trajectory: { cid: 'bafy-traj', sha256: 'a'.repeat(64) },
    intent: { cid: intentCid },
  };
  return {
    trajectory: traj as unknown,
    envelope: env as any,
    envelopeCid: 'bafy-test',
    options: {},
  };
}

// ────────────────────────────────────────────────────────────────────────────
// checkTrajectorySchema
// ────────────────────────────────────────────────────────────────────────────

describe('checkTrajectorySchema', () => {
  it('passes on a schema-valid trajectory', () => {
    const ctx = trajCtx('bafy-intent');
    const result = checkTrajectorySchema(ctx as ConformanceContext);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('trajectory.schema');
    expect(result.layer).toBe(1);
  });

  it('fails when spans is missing', () => {
    const bad = { schemaVersion: 'jinn.trajectory.v1' };
    const ctx = trajCtx('bafy-intent', bad);
    const result = checkTrajectorySchema(ctx as ConformanceContext);
    expect(result.passed).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it('fails when schemaVersion is wrong', () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    const bad = { ...traj, schemaVersion: 'jinn.trajectory.v2' };
    const ctx = trajCtx('bafy-intent', bad);
    const result = checkTrajectorySchema(ctx as ConformanceContext);
    expect(result.passed).toBe(false);
  });

  it('skips when envelope.trajectory is null and ctx.trajectory is null', () => {
    const ctx: ConformanceContext = {
      trajectory: null as unknown,
      envelope: { trajectory: null } as any,
      envelopeCid: 'bafy-test',
      options: {},
    };
    const result = checkTrajectorySchema(ctx);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// checkHashChainIntegrity
// ────────────────────────────────────────────────────────────────────────────

describe('checkHashChainIntegrity', () => {
  it('passes when every span.jinn.prevSpanHash matches keccak256(JCS(prev span))', () => {
    const ctx = trajCtx('bafy-intent');
    const result = checkHashChainIntegrity(ctx as ConformanceContext);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('trajectory.hash-chain');
  });

  it('skips when trajectory is absent', () => {
    const ctx: ConformanceContext = {
      trajectory: null as unknown,
      envelope: { trajectory: null, intent: { cid: 'bafy-intent' } } as any,
      envelopeCid: 'bafy-test',
      options: {},
    };
    const result = checkHashChainIntegrity(ctx);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails when a later span has wrong prevSpanHash', () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    // Corrupt span[2]'s prevSpanHash
    traj.spans[2].attributes['jinn.prevSpanHash'] = '0x' + 'de'.repeat(32);
    const ctx = trajCtx('bafy-intent', traj);
    const result = checkHashChainIntegrity(ctx as ConformanceContext);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/span\[2\]/);
  });

  it("fails when first span's prevSpanHash doesn't match genesis(envelope.intent.cid)", () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    traj.spans[0].attributes['jinn.prevSpanHash'] = '0x' + 'ab'.repeat(32);
    const ctx = trajCtx('bafy-intent', traj);
    const result = checkHashChainIntegrity(ctx as ConformanceContext);
    expect(result.passed).toBe(false);
    // Should mention span[0] and/or genesis
    expect(result.detail).toMatch(/genesis|span\[0\]/);
  });

  it('fails when envelope.intent.cid is missing', () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    const ctx: ConformanceContext = {
      trajectory: traj as unknown,
      envelope: { trajectory: { cid: 'bafy-traj', sha256: 'a'.repeat(64) } } as any,
      envelopeCid: 'bafy-test',
      options: {},
    };
    const result = checkHashChainIntegrity(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/intent\.cid/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// checkSpanProfile
// ────────────────────────────────────────────────────────────────────────────

describe('checkSpanProfile', () => {
  it('passes when every span has its kind-required attributes', () => {
    const ctx = trajCtx('bafy-intent');
    const result = checkSpanProfile(ctx as ConformanceContext);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('trajectory.span-profile');
  });

  it('skips when trajectory is absent', () => {
    const ctx: ConformanceContext = {
      trajectory: null as unknown,
      envelope: { trajectory: null } as any,
      envelopeCid: 'bafy-test',
      options: {},
    };
    const result = checkSpanProfile(ctx);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("fails when a jinn.llm_call span is missing 'gen_ai.system'", () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    const llmSpan = traj.spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.llm_call');
    expect(llmSpan).toBeDefined();
    delete (llmSpan!.attributes as Record<string, unknown>)['gen_ai.system'];
    const ctx = trajCtx('bafy-intent', traj);
    const result = checkSpanProfile(ctx as ConformanceContext);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/gen_ai\.system/);
  });

  it('fails when a span has an unknown jinn.span.kind', () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    traj.spans[0].attributes['jinn.span.kind'] = 'jinn.unknown_kind';
    const ctx = trajCtx('bafy-intent', traj);
    const result = checkSpanProfile(ctx as ConformanceContext);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/unknown/i);
  });
});
