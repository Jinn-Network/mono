import { describe, it, expect } from 'vitest';
import {
  SolverNetManifestV1Schema,
  validateSolverNetManifest,
  type SolverNetManifestV1,
} from '../../src/solvernets/manifest-schema.js';

function buildValidManifest(): SolverNetManifestV1 {
  return {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: 'prediction-2026-05-06',
    network: 'base-sepolia',
    name: 'Prediction',
    description: 'Calibrated probability forecasts for prediction-market events.',
    launcher: {
      safeAddress: '0xE64bAf0000000000000000000000000000000000',
      agentEoa: '0x1111111111111111111111111111111111111111',
      agentId: '5474',
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: {
        task: { type: 'object', properties: {}, required: [] },
        solution: { type: 'object', properties: {}, required: [] },
        verdict: { type: 'object', properties: {}, required: [] },
      },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 25,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 1800,
      },
      credentialRequirements: {
        creator: [
          {
            id: 'polymarket.public.market-data.read',
            kind: 'public-api',
            required: true,
            description: 'Read public Polymarket market metadata.',
          },
        ],
        solver: [],
        evaluator: [
          {
            id: 'polymarket.public.resolution.read',
            kind: 'public-api',
            required: true,
            description: 'Read public Polymarket/UMA final market state.',
          },
        ],
      },
      evaluationFunction: {
        id: 'prediction.brier-loss.v1',
        deterministic: true,
        inputs: ['task', 'solution', 'resolution'],
        output: 'verdict',
        implementation: 'operator/src/harnesses/impls/prediction-v1-evaluator',
      },
      aggregationFunction: {
        id: 'prediction.trailing-mean-brier-spread.v1',
        deterministic: true,
        inputs: ['SCORED Verdicts'],
        output: 'trailing mean brierSpread',
        windowDays: 84,
      },
    },
    solutionPriceWei: '1000000000000000',
    verdictPriceWei: '500000000000000',
    openRoles: ['solver', 'evaluator'],
    createdAt: '2026-05-06T00:00:00.000Z',
    launchedAt: '2026-05-06T00:00:00.000Z',
    signature: {
      alg: 'eip-191',
      signer: '0x1111111111111111111111111111111111111111',
      value: ('0x' + 'ab'.repeat(65)) as `0x${string}`,
    },
  };
}

describe('SolverNetManifestV1 schema (§7)', () => {
  it('accepts a fully valid manifest', () => {
    const manifest = buildValidManifest();
    const result = SolverNetManifestV1Schema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`expected success but got: ${JSON.stringify(result.error.issues)}`);
    }
  });

  it('accepts a manifest without optional registry block', () => {
    const manifest = buildValidManifest();
    delete (manifest as { registry?: unknown }).registry;
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(true);
  });

  it('accepts a manifest with optional registry block', () => {
    const manifest: SolverNetManifestV1 = {
      ...buildValidManifest(),
      registry: {
        manifestCid: 'bafybeigdyrztexample',
        registryUrl: 'https://example.invalid/manifests/bafy',
      },
    };
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(true);
  });

  it('accepts optional generatorConfig on a manifest', () => {
    const manifest: SolverNetManifestV1 = {
      ...buildValidManifest(),
      generatorConfig: {
        N_target_successes: 5,
        N_max_postings_per_task: 10,
        posting_window_ms: 24 * 60 * 60 * 1000,
        post_batch_size: 25,
        claimLeaseTtlSeconds: 60 * 60,
      },
    };
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(true);
  });

  it('rejects when schemaVersion is wrong', () => {
    const manifest = buildValidManifest() as unknown as Record<string, unknown>;
    manifest.schemaVersion = 'solvernet.manifest.v2';
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects when network is unsupported', () => {
    const manifest = { ...buildValidManifest(), network: 'mainnet-eth' as 'base-sepolia' };
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects when openRoles is empty', () => {
    const manifest = { ...buildValidManifest(), openRoles: [] as Array<'solver' | 'evaluator'> };
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects when openRoles contains an unknown role', () => {
    const manifest = {
      ...buildValidManifest(),
      openRoles: ['solver', 'creator'] as Array<'solver' | 'evaluator'>,
    };
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects when launcher.safeAddress is not 0x-prefixed', () => {
    const manifest = buildValidManifest();
    manifest.launcher.safeAddress = 'NOT_AN_ADDRESS' as `0x${string}`;
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects the bare "0x" sentinel for HexString fields', () => {
    // Without the `+` quantifier, "0x" with no hex digits would silently pass
    // and propagate into a corrupt manifest.
    const safeManifest = buildValidManifest();
    safeManifest.launcher.safeAddress = '0x' as `0x${string}`;
    expect(SolverNetManifestV1Schema.safeParse(safeManifest).success).toBe(false);

    const eoaManifest = buildValidManifest();
    eoaManifest.launcher.agentEoa = '0x' as `0x${string}`;
    expect(SolverNetManifestV1Schema.safeParse(eoaManifest).success).toBe(false);

    const sigSignerManifest = buildValidManifest();
    sigSignerManifest.signature.signer = '0x' as `0x${string}`;
    expect(SolverNetManifestV1Schema.safeParse(sigSignerManifest).success).toBe(false);

    const sigValueManifest = buildValidManifest();
    sigValueManifest.signature.value = '0x' as `0x${string}`;
    expect(SolverNetManifestV1Schema.safeParse(sigValueManifest).success).toBe(false);
  });

  it('rejects when solutionPriceWei is missing', () => {
    const manifest = buildValidManifest() as Record<string, unknown>;
    delete manifest.solutionPriceWei;
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects when verdictPriceWei is not a numeric string', () => {
    const manifest = { ...buildValidManifest(), verdictPriceWei: 'not-a-number' };
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects when claimPolicyDefaults.mode is invalid', () => {
    const manifest = buildValidManifest();
    manifest.contract.claimPolicyDefaults.mode = 'unknown-mode' as 'parallel';
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects when evaluationFunction.implementation is missing', () => {
    const manifest = buildValidManifest();
    delete (manifest.contract.evaluationFunction as { implementation?: string }).implementation;
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects when signature.alg is not eip-191', () => {
    const manifest = buildValidManifest();
    manifest.signature.alg = 'eip-712' as 'eip-191';
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects when there is an extra top-level field (strict)', () => {
    const manifest = { ...buildValidManifest(), economics: { totalBudgetWei: '0' } };
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects manifests that use fields removed from §7 (no recommendedHarnesses)', () => {
    const manifest = buildValidManifest() as Record<string, unknown>;
    (manifest.contract as Record<string, unknown>).recommendedHarnesses = ['foo'];
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('rejects manifests that include defaultRuntimePlugins (removed)', () => {
    const manifest = buildValidManifest() as Record<string, unknown>;
    (manifest.contract as Record<string, unknown>).defaultRuntimePlugins = [];
    expect(SolverNetManifestV1Schema.safeParse(manifest).success).toBe(false);
  });

  it('round-trips through JSON.stringify / JSON.parse', () => {
    const manifest = buildValidManifest();
    const reborn = JSON.parse(JSON.stringify(manifest)) as unknown;
    const parsed = SolverNetManifestV1Schema.safeParse(reborn);
    expect(parsed.success).toBe(true);
  });

  it('validateSolverNetManifest returns a typed manifest on success', () => {
    const manifest = buildValidManifest();
    const result = validateSolverNetManifest(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // type narrowed to SolverNetManifestV1
      expect(result.value.schemaVersion).toBe('solvernet.manifest.v1');
      expect(result.value.openRoles).toEqual(['solver', 'evaluator']);
    }
  });

  it('validateSolverNetManifest returns issue list on failure', () => {
    const manifest = buildValidManifest() as Record<string, unknown>;
    delete manifest.solutionPriceWei;
    const result = validateSolverNetManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.path.includes('solutionPriceWei'))).toBe(true);
    }
  });
});
