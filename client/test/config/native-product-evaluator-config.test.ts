import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { describe, expect, it } from 'vitest';
import { NativeProductFileSchema } from '../../src/daemon/native-product-config.js';

/**
 * Standalone `NativeProductConfig` (the `--native-config` structured file, issue #2378) evaluator
 * block: one-swap M4c threads `graderReportSources` and the map-form `evaluationMethodDigest`
 * through it, matching the fleet's `native-sections.ts` surface (already covered there). These pin
 * that the standalone surface accepts both, and refuses a non-`deployment-owned` grader binding.
 */
function evaluatorDoc(evaluator: Record<string, unknown>): Record<string, unknown> {
  return {
    network: 'testnet',
    rpcUrl: 'https://sepolia.base.org',
    operator: {
      verticalMode: 'native-v1',
      native: {
        role: 'evaluator',
        agent: 'urn:jinn:agent:evaluator',
        safeAddress: `0x${'12'.repeat(20)}`,
        marketplaceAgentAddress: `0x${'13'.repeat(20)}`,
        evmCustody: { keystorePath: '/evm.json', expectedOwnerAddress: `0x${'14'.repeat(20)}`, accountIndex: 1 },
        publicBaseUrl: 'https://evaluator.example.test',
        publicListen: { host: '127.0.0.1', port: 18533 },
        sources: [
          { role: 'requester', agent: 'did:web:requester', name: 'requester', baseUrl: 'https://requester.example.test' },
          { role: 'solver', agent: 'did:web:solver', name: 'solver', baseUrl: 'https://solver.example.test' },
        ],
        ipfs: { apiUrl: 'https://ipfs.example.test' },
        chainId: 84532,
        generation: 'today',
        contracts: {
          taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
          jinnRouter: BASE_SEPOLIA_TODAY.jinnRouter,
          mechMarketplace: BASE_SEPOLIA_TODAY.mechMarketplace,
          activityChecker: BASE_SEPOLIA_TODAY.activityChecker,
        },
        transactionCaps: {
          createTaskMaxWei: '1', claimMaxWei: '1', solutionSettlementMaxWei: '1',
          evaluationClaimMaxWei: '1', verdictSettlementMaxWei: '1', escrowMaxWei: '1',
        },
        stateDir: '/state', identityStores: { evaluator: '/identity' }, trustRootsPath: '/trust',
        trustPolicyGenesisDigest: `sha256:${'dd'.repeat(32)}`,
        runtime: { provider: 'first-party', nodeExecutableDigest: `sha256:${'ab'.repeat(32)}` },
        evaluator,
        finality: { confirmations: 12 }, liveClosureReceiptPath: '/missing-receipt.json',
      },
    },
  };
}

const MODULE = { deploymentModule: '/evaluator.mjs', moduleDigest: `sha256:${'bb'.repeat(32)}`, signerHandle: 'verdict' };

describe('NativeProductConfig evaluator block — M4c grader-source + map-digest threading', () => {
  it('accepts a single-string evaluationMethodDigest (prediction-only, unchanged shape)', () => {
    const parsed = NativeProductFileSchema.parse(evaluatorDoc({
      ...MODULE,
      evaluationMethodDigest: `sha256:${'cc'.repeat(32)}`,
    }));
    expect(parsed.operator.native.evaluator!.evaluationMethodDigest).toBe(`sha256:${'cc'.repeat(32)}`);
    expect(parsed.operator.native.evaluator!.graderReportSources).toBeUndefined();
  });

  it('accepts the per-registration map form of evaluationMethodDigest', () => {
    const parsed = NativeProductFileSchema.parse(evaluatorDoc({
      ...MODULE,
      evaluationMethodDigest: { 'prediction-market': `sha256:${'cc'.repeat(32)}`, 'swe-rebench-v2': `sha256:${'ee'.repeat(32)}` },
    }));
    expect(parsed.operator.native.evaluator!.evaluationMethodDigest).toEqual({
      'prediction-market': `sha256:${'cc'.repeat(32)}`,
      'swe-rebench-v2': `sha256:${'ee'.repeat(32)}`,
    });
  });

  it('accepts a deployment-owned grader binding keyed by registrationId', () => {
    const parsed = NativeProductFileSchema.parse(evaluatorDoc({
      ...MODULE,
      evaluationMethodDigest: `sha256:${'ee'.repeat(32)}`,
      graderReportSources: { 'swe-rebench-v2': 'deployment-owned' },
    }));
    expect(parsed.operator.native.evaluator!.graderReportSources).toEqual({ 'swe-rebench-v2': 'deployment-owned' });
  });

  it('refuses a grader binding that is not the deployment-owned literal', () => {
    expect(() => NativeProductFileSchema.parse(evaluatorDoc({
      ...MODULE,
      evaluationMethodDigest: `sha256:${'ee'.repeat(32)}`,
      graderReportSources: { 'swe-rebench-v2': 'host-owned' },
    }))).toThrow();
  });
});
