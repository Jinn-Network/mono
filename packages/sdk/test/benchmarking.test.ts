import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  ConfigV1Schema,
  validateConfigV1,
  type ConfigV1,
} from '../src/benchmarking.js';

const validConfigArtifact: ConfigV1 = {
  configId: 'cfg-baseline',
  solveProfile: {
    harness: 'prediction-v1-baseline',
    harnessVersionOrDigest: '1.0.0',
    model: 'claude-haiku-4-5-20251001',
  },
  loadout: {
    kind: 'artifact',
    ref: 'bafybeigdyr',
    sha256: `sha256:${'a'.repeat(64)}`,
  },
};

const validConfigNone: ConfigV1 = {
  configId: 'cfg-empty',
  solveProfile: {
    harness: 'prediction-v1-baseline',
    harnessVersionOrDigest: '1.0.0',
    model: 'claude-haiku-4-5-20251001',
  },
  loadout: { kind: 'none' },
};

describe('ConfigV1', () => {
  it('accepts artifact and none loadouts', () => {
    expect(ConfigV1Schema.parse(validConfigArtifact).configId).toBe('cfg-baseline');
    expect(ConfigV1Schema.parse(validConfigNone).loadout.kind).toBe('none');
    expect(validateConfigV1(validConfigArtifact).ok).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    const bad = { ...validConfigNone, extra: true };
    expect(ConfigV1Schema.safeParse(bad).success).toBe(false);
    const result = validateConfigV1(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed loadout sha256', () => {
    const bad = {
      ...validConfigArtifact,
      loadout: { kind: 'artifact', ref: 'bafy', sha256: 'not-a-digest' },
    };
    expect(ConfigV1Schema.safeParse(bad).success).toBe(false);
  });
});
