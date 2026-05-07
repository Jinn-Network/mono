// Stub `ManifestResolver` for engine tests that exercise the §14
// manifest → contract → schemas pipeline without standing up a real
// IdentityRegistry-backed registry client.
//
// See `spec/2026-05-05-solvernet-creation-and-launch.md` §14 + Task 27.

import { vi } from 'vitest';
import type { ManifestResolver } from '../../../src/harnesses/engine/engine.js';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';
import { TEST_PREDICTION_V1_MANIFEST_CID } from '../impls/prediction-v1-test-helpers.js';

/**
 * Build a SolverNetManifestV1 stub for the prediction.v1 contract. The
 * `schemas` slot is intentionally empty (`{}`) — the engine's day-1
 * compatibility path validates via the SDK template's Zod, looked up by
 * `{contract.id, contract.version}`. JSON-Schema-against-the-manifest is
 * the day-N path tracked as a follow-up.
 */
export function buildPredictionV1ManifestStub(
  overrides: Partial<SolverNetManifestV1> = {},
): SolverNetManifestV1 {
  const manifest: SolverNetManifestV1 = {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: 'prediction-v1-test',
    network: 'base-sepolia',
    name: 'Prediction (test)',
    description: 'Test manifest for the prediction.v1 contract.',
    launcher: {
      safeAddress: `0x${'a'.repeat(40)}`,
      agentEoa: `0x${'b'.repeat(40)}`,
      agentId: 'test-launcher-agent',
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: { task: {}, solution: {}, verdict: {} },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 25,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 30 * 60,
      },
      credentialRequirements: { creator: [], solver: [], evaluator: [] },
      evaluationFunction: {
        id: 'prediction.brier-loss.v1',
        deterministic: true,
        inputs: [],
        output: 'verdict',
        implementation: 'client/src/harnesses/impls/prediction-v1-evaluator',
      },
      aggregationFunction: {
        id: 'prediction.trailing-mean-brier-spread.v1',
        deterministic: true,
        inputs: [],
        output: 'aggregate',
      },
    },
    solutionPriceWei: '0',
    verdictPriceWei: '0',
    openRoles: ['solver', 'evaluator'],
    createdAt: '2026-05-02T00:00:00.000Z',
    launchedAt: '2026-05-02T00:00:00.000Z',
    signature: {
      alg: 'eip-191',
      signer: `0x${'c'.repeat(40)}`,
      value: `0x${'d'.repeat(64)}`,
    },
    ...overrides,
  };
  return manifest;
}

/**
 * A `ManifestResolver` that returns the prediction.v1 stub for the
 * canonical test CID and throws "manifest not found" for anything else.
 *
 * Pass `manifests` to seed additional `cid → manifest` mappings.
 */
export function makeStubManifestResolver(
  manifests: Record<string, SolverNetManifestV1> = {},
): ManifestResolver & { getManifest: ReturnType<typeof vi.fn> } {
  const seeded: Record<string, SolverNetManifestV1> = {
    [TEST_PREDICTION_V1_MANIFEST_CID]: buildPredictionV1ManifestStub(),
    ...manifests,
  };
  const getManifest = vi.fn(async ({ manifestCid }: { manifestCid: string }) => {
    const found = seeded[manifestCid];
    if (!found) {
      throw new Error(`manifest not found for cid '${manifestCid}'`);
    }
    return found;
  });
  return { getManifest };
}
