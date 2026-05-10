import { describe, expect, it } from 'vitest';
import { buildOperatorClientConfig } from '../../scripts/lib/acceptance-operator-config.mjs';

describe('acceptance operator config', () => {
  it('defaults isolated acceptance operators into testnet donation mode', () => {
    const config = buildOperatorClientConfig({
      rpcUrl: 'https://base-sepolia.example',
      clientHome: '/tmp/jinn-acceptance/.jinn-client',
      runIdSuffix: 'unit',
      env: {
        JINN_TESTNET_ACCEPTANCE_API_PORT: '7333',
        JINN_TESTNET_ACCEPTANCE_SUBGRAPH_URL: 'https://subgraph.example/graphql',
        JINN_TESTNET_ACCEPTANCE_IPFS_GATEWAY_URL: 'https://gateway.example/ipfs/',
        JINN_TESTNET_ACCEPTANCE_IPFS_REGISTRY_URL: 'https://registry.example',
      },
    });

    expect(config).toMatchObject({
      network: 'testnet',
      apiPort: 7333,
      subgraphUrl: 'https://subgraph.example/graphql',
      ipfsGatewayUrl: 'https://gateway.example/ipfs/',
      ipfsRegistryUrl: 'https://registry.example',
      operator: {
        publicEndpoint: 'http://localhost:7333',
        defaultPriceUsdc: '0',
        donation: { enabled: true },
      },
    });
  });
});
