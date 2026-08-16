import { describe, expect, it } from 'vitest';
import {
  CONFIG_SHAPE_VERSION,
  ClaimPolicyConfigSchema,
  ExecutionWiringConfigEntrySchema,
  PostingConfigEntrySchema,
  toPipelineWiring,
} from '../../src/config/shape-v2.js';

describe('config shape v2', () => {
  it('pins the shape version at 2', () => {
    expect(CONFIG_SHAPE_VERSION).toBe(2);
  });

  it('parses a claim policy with a decimal-string spend cap', () => {
    const parsed = ClaimPolicyConfigSchema.parse({
      mode: 'match-legacy-manifest-digest',
      spendCapWei: '2500000000000000',
      aiUnitCap: 30,
    });
    expect(parsed.spendCapWei).toBe('2500000000000000');
    expect(BigInt(parsed.spendCapWei as string)).toBe(2500000000000000n);
  });

  it('rejects a non-decimal spend cap', () => {
    expect(() =>
      ClaimPolicyConfigSchema.parse({ mode: 'claim-nothing', spendCapWei: '0x10', aiUnitCap: 1 }),
    ).toThrow();
  });

  // Amendment (coordinator amendment 1): spendCapWei/aiUnitCap are OPTIONAL.
  // A configured operator with no per-claim caps parses cleanly and yields
  // `undefined` for both — the host's USD rolling-window gates remain the
  // operative spend bound (spec §9 "behavior-identical on day one").
  it('parses a claim policy with no cap fields set', () => {
    const parsed = ClaimPolicyConfigSchema.parse({
      mode: 'every-runnable',
    });
    expect(parsed.spendCapWei).toBeUndefined();
    expect(parsed.aiUnitCap).toBeUndefined();
  });

  it('defaults plugins to an empty array on a wiring entry', () => {
    const parsed = ExecutionWiringConfigEntrySchema.parse({
      workKind: 'prediction.v1',
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      credentialRef: 'anthropic-default',
      isolationPolicy: 'process',
    });
    expect(parsed.plugins).toEqual([]);
    expect(parsed.legacyManifestDigest).toBeUndefined();
  });

  it('parses a posting entry', () => {
    const parsed = PostingConfigEntrySchema.parse({
      workKind: 'prediction.v1',
      launchedRecordPath: '/home/op/.jinn-client/solvernets/launched/QmAbc.json',
      generatorEnabled: true,
      legacyManifestDigest: 'QmAbc',
    });
    expect(parsed.generatorEnabled).toBe(true);
  });

  it('maps operator wiring onto the pipeline entry type', () => {
    const [entry] = toPipelineWiring([
      {
        workKind: 'prediction.v1',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: ['learner'],
        credentialRef: 'anthropic-default',
        isolationPolicy: 'process',
        legacyManifestDigest: 'QmAbc',
      },
    ]);
    expect(entry).toEqual({
      workKind: 'prediction.v1',
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['learner'],
      credentialRef: 'anthropic-default',
      isolationPolicy: 'process',
      legacyManifestDigest: 'QmAbc',
    });
  });
});
