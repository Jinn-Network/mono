import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  ConfigV1Schema,
  validateConfigV1,
  BenchmarkRunV1Schema,
  validateBenchmarkRunV1,
  hashBenchmarkRunV1,
  computeRunHash,
  hashCapsuleSet,
  BenchPreregistrationV1Schema,
  validateBenchPreregistrationV1,
  BenchMatrixV1Schema,
  validateBenchMatrixV1,
  hashBenchMatrixV1,
  type ConfigV1,
  type BenchmarkRunV1,
  type BenchPreregistrationV1,
  type BenchMatrixV1,
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

describe('BenchPreregistrationV1', () => {
  it('accepts a signed envelope with a valid nested run', () => {
    const run = makeValidRun();
    const envelope: BenchPreregistrationV1 = {
      schemaVersion: 'jinn.bench-preregistration.v1',
      run,
      signature: {
        alg: 'eip-191',
        signer: '0xabc',
        value: '0xdef',
      },
    };
    expect(BenchPreregistrationV1Schema.parse(envelope).schemaVersion).toBe(
      'jinn.bench-preregistration.v1',
    );
    expect(validateBenchPreregistrationV1(envelope).ok).toBe(true);
  });

  it('rejects when nested run hash is tampered', () => {
    const run = { ...makeValidRun(), preRegistrationHash: digest('e') };
    const envelope = {
      schemaVersion: 'jinn.bench-preregistration.v1',
      run,
      signature: { alg: 'eip-191', signer: '0xabc', value: '0xdef' },
    };
    expect(validateBenchPreregistrationV1(envelope).ok).toBe(false);
  });
});

function buildValidMatrix(run: BenchmarkRunV1): BenchMatrixV1 {
  const withoutHash = {
    schemaVersion: 'jinn.bench-matrix.v1' as const,
    runId: run.runId,
    preRegistration: run,
    closeBoundary: { timestamp: '2026-07-23T12:00:00.000Z' },
    cells: [
      {
        cellKey: 'cell-0',
        capsuleDigest: run.capsuleSet.capsuleDigests[0]!,
        configId: run.configs[0]!.configId,
        replicate: 0,
        outcome: 'judged' as const,
        verification: {
          loadout: 'match' as const,
          profile: 'match' as const,
          isolation: 'receipt:iso-1',
        },
        judgeIntegrityTier: 're-derivable' as const,
        solverId: 'solver-1',
        evaluatorId: 'eval-1',
        cost: { reported: '1000', source: 'harness' },
        latencyMs: 12,
      },
    ],
    exclusions: [],
    attrition: { perConfig: {}, perCapsule: {}, asymmetryFlags: [] },
    completeness: { achieved: 1, floor: 0.8, runOutcome: 'complete' as const },
    matrixHash: digest('f'),
  };
  return {
    ...withoutHash,
    matrixHash: hashBenchMatrixV1(withoutHash as BenchMatrixV1),
  };
}

describe('BenchMatrixV1', () => {
  it('parses a valid matrix and checks matrixHash (AC2)', () => {
    const run = makeValidRun();
    const matrix = buildValidMatrix(run);
    expect(validateBenchMatrixV1(matrix)).toEqual({ ok: true, value: matrix });
    expect(hashBenchMatrixV1(matrix)).toBe(matrix.matrixHash);
  });

  it('rejects matrixHash tampering (AC3)', () => {
    const matrix = { ...buildValidMatrix(makeValidRun()), matrixHash: digest('e') };
    const result = validateBenchMatrixV1(matrix);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('hash mismatch'))).toBe(true);
    }
  });

  it('rejects duplicate cellKey (AC3)', () => {
    const run = makeValidRun();
    const matrix = buildValidMatrix(run);
    const dup = {
      ...matrix,
      cells: [matrix.cells[0]!, { ...matrix.cells[0]!, replicate: 1 }],
    };
    const withHash = { ...dup, matrixHash: hashBenchMatrixV1(dup as BenchMatrixV1) };
    const result = validateBenchMatrixV1(withHash);
    expect(result.ok).toBe(false);
  });

  it('rejects runId mismatch against preRegistration.runId (#2067)', () => {
    const run = makeValidRun();
    const matrix = buildValidMatrix(run);
    const mismatched = { ...matrix, runId: 'a-different-run-id' };
    const withHash = {
      ...mismatched,
      matrixHash: hashBenchMatrixV1(mismatched as BenchMatrixV1),
    };
    const result = validateBenchMatrixV1(withHash);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('runId mismatch'))).toBe(true);
    }
  });

  for (const key of [
    'aggregate',
    'aggregates',
    'ranking',
    'rankings',
    'winner',
    'winners',
    'leaderboard',
    'leaderboards',
    'recommendation',
    'recommendations',
  ] as const) {
    it(`rejects forbidden matrix meaning field: ${key} (AC4)`, () => {
      // Must start from an otherwise-valid matrix — incomplete stubs fail for
      // missing required fields even without the forbidden key, which would
      // leave AC4 unpinned if .strict() regressed.
      const raw = { ...buildValidMatrix(makeValidRun()), [key]: {} };
      const parsed = BenchMatrixV1Schema.safeParse(raw);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some(
            (issue) =>
              issue.code === 'unrecognized_keys' &&
              'keys' in issue &&
              Array.isArray(issue.keys) &&
              issue.keys.includes(key),
          ),
        ).toBe(true);
      }
    });
  }
});
