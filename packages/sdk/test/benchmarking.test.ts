import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  ConfigV1Schema,
  validateConfigV1,
  BenchmarkRunV1Schema,
  validateBenchmarkRunV1,
  hashBenchmarkRunV1,
  computeRunHash,
  hashCapsuleSet,
  type ConfigV1,
  type BenchmarkRunV1,
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

function digest(hexChar: string): `sha256:${string}` {
  return `sha256:${hexChar.repeat(64)}`;
}

function buildRunWithoutHashes(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: 'run-1',
    consumer: 'did:jinn:curator:alice',
    capsuleSet: {
      capsuleDigests: [digest('1'), digest('2')],
      admissionReceiptRefs: ['receipt:a', 'receipt:b'],
      setHash: digest('0'),
    },
    configs: [validConfigNone, { ...validConfigArtifact, configId: 'cfg-arm' }],
    replicates: 2,
    policy: {
      completenessFloor: 0.8,
      replacementPolicy: 'infra-lapse-only',
      eligibilityExclusions: [],
      cellWindow: '24h',
      selfEvaluation: false,
    },
    budget: {
      perCellFees: { solveWei: '1000000000000000', verdictWei: '500000000000000' },
      hardCapWei: '100000000000000000',
    },
    ...overrides,
  };
}

function makeValidRun(): BenchmarkRunV1 {
  const base = buildRunWithoutHashes();
  const capsuleSet = base.capsuleSet as {
    capsuleDigests: string[];
    admissionReceiptRefs: string[];
  };
  const setHash = hashCapsuleSet({
    capsuleDigests: capsuleSet.capsuleDigests,
    admissionReceiptRefs: capsuleSet.admissionReceiptRefs,
  });
  const withoutPre = {
    ...base,
    capsuleSet: { ...capsuleSet, setHash },
    preRegistrationHash: digest('f'),
  } as BenchmarkRunV1;
  return { ...withoutPre, preRegistrationHash: hashBenchmarkRunV1(withoutPre) };
}

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

describe('BenchmarkRunV1', () => {
  it('parses a valid run and validates hashes', () => {
    const run = makeValidRun();
    expect(validateBenchmarkRunV1(run)).toEqual({ ok: true, value: run });
  });

  it('preRegistrationHash excludes only itself; runHash equals it (AC2)', () => {
    const run = makeValidRun();
    const h1 = run.preRegistrationHash;
    expect(hashBenchmarkRunV1(run)).toBe(h1);
    expect(computeRunHash(run)).toBe(h1);
    expect(computeRunHash).toBe(hashBenchmarkRunV1);

    const reordered = {
      budget: run.budget,
      capsuleSet: run.capsuleSet,
      configs: run.configs,
      consumer: run.consumer,
      policy: run.policy,
      preRegistrationHash: run.preRegistrationHash,
      replicates: run.replicates,
      runId: run.runId,
    };
    expect(hashBenchmarkRunV1(reordered as BenchmarkRunV1)).toBe(h1);
  });

  it('rejects unsafe wei strings (AC3)', () => {
    const cases = ['1e18', '-1', '0x1', '1.5', ''];
    for (const solveWei of cases) {
      const raw = {
        ...buildRunWithoutHashes(),
        budget: {
          perCellFees: { solveWei, verdictWei: '1' },
          hardCapWei: '1',
        },
        preRegistrationHash: digest('f'),
      };
      expect(BenchmarkRunV1Schema.safeParse(raw).success).toBe(false);
    }
  });

  it('rejects duplicate configId (AC3)', () => {
    const raw = {
      ...buildRunWithoutHashes({
        configs: [validConfigNone, { ...validConfigNone }],
      }),
      preRegistrationHash: digest('f'),
    };
    const result = validateBenchmarkRunV1(raw);
    expect(result.ok).toBe(false);
  });

  it('rejects selfEvaluation true / missing / string (AC3)', () => {
    for (const selfEvaluation of [true, 'false', undefined] as unknown[]) {
      const policy = {
        completenessFloor: 0.8,
        replacementPolicy: 'x',
        eligibilityExclusions: [],
        cellWindow: '24h',
        ...(selfEvaluation === undefined ? {} : { selfEvaluation }),
      };
      const raw = {
        ...buildRunWithoutHashes(),
        policy,
        preRegistrationHash: digest('f'),
      };
      expect(BenchmarkRunV1Schema.safeParse(raw).success).toBe(false);
    }
  });

  it('rejects unknown top-level fields (AC3)', () => {
    const raw = {
      ...buildRunWithoutHashes(),
      preRegistrationHash: digest('f'),
      surprise: 1,
    };
    expect(BenchmarkRunV1Schema.safeParse(raw).success).toBe(false);
  });

  it('rejects preRegistrationHash / setHash tampering (AC3)', () => {
    const good = makeValidRun();
    expect(validateBenchmarkRunV1(good).ok).toBe(true);

    const badPre = { ...good, preRegistrationHash: digest('e') };
    const badPreResult = validateBenchmarkRunV1(badPre);
    expect(badPreResult.ok).toBe(false);
    if (!badPreResult.ok) {
      expect(badPreResult.issues.some((i) => i.message.includes('hash mismatch'))).toBe(true);
    }

    const badSet = {
      ...good,
      capsuleSet: { ...good.capsuleSet, setHash: digest('e') },
    };
    const badSetWithMatchingPre = {
      ...badSet,
      preRegistrationHash: hashBenchmarkRunV1(badSet as BenchmarkRunV1),
    };
    const badSetResult = validateBenchmarkRunV1(badSetWithMatchingPre);
    expect(badSetResult.ok).toBe(false);
    if (!badSetResult.ok) {
      expect(badSetResult.issues.some((i) => i.message.includes('hash mismatch'))).toBe(true);
    }
  });

  it('types selfEvaluation as literal false', () => {
    expectTypeOf<BenchmarkRunV1['policy']['selfEvaluation']>().toEqualTypeOf<false>();
  });
});
