import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';

/**
 * A minimal, schema-valid `NativeProductFileSchema` document (solver role).
 * Shared across the config-collision / native-config-path / run-native-config
 * regression suites for issue #2378 so the giant literal lives in one place.
 */
export function validNativeProductFileContent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: 'testnet',
    rpcUrl: 'https://sepolia.base.org',
    operator: {
      verticalMode: 'native-v1',
      native: {
        role: 'solver',
        agent: 'urn:jinn:agent:solver',
        safeAddress: `0x${'12'.repeat(20)}`,
        marketplaceAgentAddress: `0x${'13'.repeat(20)}`,
        evmCustody: { keystorePath: '/evm.json', expectedOwnerAddress: `0x${'14'.repeat(20)}`, accountIndex: 1 },
        publicBaseUrl: 'https://solver.example.test',
        publicListen: { host: '127.0.0.1', port: 18533 },
        sources: [{ role: 'requester', agent: 'did:web:requester', name: 'requester', baseUrl: 'https://requester.example.test' }],
        ipfs: { apiUrl: 'https://ipfs.example.test' },
        chainId: 84532,
        generation: 'today',
        // NativeOperatorConfigSchema's `contracts` is `.strict()` on exactly these four
        // addresses — BASE_SEPOLIA_TODAY also carries `chainId`/`generation`, which would
        // otherwise leak in as unrecognized keys at this nesting level.
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
        stateDir: '/state', identityStores: { solver: '/identity' }, trustRootsPath: '/trust',
        trustPolicyGenesisDigest: `sha256:${'dd'.repeat(32)}`,
        runtime: { provider: 'first-party', nodeExecutableDigest: `sha256:${'ab'.repeat(32)}` },
        evaluator: {
          deploymentModule: '/evaluator.mjs', moduleDigest: `sha256:${'bb'.repeat(32)}`,
          signerHandle: 'verdict', evaluationMethodDigest: `sha256:${'cc'.repeat(32)}`,
        },
        finality: { confirmations: 12 }, liveClosureReceiptPath: '/missing-receipt.json',
      },
    },
    ...extra,
  };
}
