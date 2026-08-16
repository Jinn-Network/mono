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
        JINN_TESTNET_ACCEPTANCE_IPFS_GATEWAY_URL: 'https://gateway.example/ipfs/',
        JINN_TESTNET_ACCEPTANCE_IPFS_REGISTRY_URL: 'https://registry.example',
      },
    });

    expect(config).toMatchObject({
      network: 'testnet',
      apiPort: 7333,
      ipfsGatewayUrl: 'https://gateway.example/ipfs/',
      ipfsRegistryUrl: 'https://registry.example',
      operator: {
        publicEndpoint: 'http://localhost:7333',
        defaultPriceUsdc: '0',
        donation: { enabled: true },
      },
    });
    // Discovery is not pinned by default — the daemon's config loader supplies
    // the testnet Ponder indexer + on-chain fallback (see operator/src/config.ts).
    expect('discovery' in config).toBe(false);
    expect('subgraphUrl' in config).toBe(false);
  });

  it('writes a discovery block only when explicitly overridden', () => {
    const config = buildOperatorClientConfig({
      rpcUrl: 'https://base-sepolia.example',
      clientHome: '/tmp/jinn-acceptance/.jinn-client',
      runIdSuffix: 'unit',
      env: {
        JINN_TESTNET_ACCEPTANCE_DISCOVERY_URL: 'https://my-indexer.example/graphql',
        JINN_TESTNET_ACCEPTANCE_DISCOVERY_MODE: 'http',
      },
    });

    expect(config.discovery).toEqual({
      mode: 'http',
      url: 'https://my-indexer.example/graphql',
    });
  });

  it('defaults the mode to http when only a discovery URL is overridden', () => {
    const config = buildOperatorClientConfig({
      rpcUrl: 'https://base-sepolia.example',
      clientHome: '/tmp/jinn-acceptance/.jinn-client',
      runIdSuffix: 'unit',
      env: {
        JINN_TESTNET_ACCEPTANCE_DISCOVERY_URL: 'https://my-indexer.example/graphql',
      },
    });

    // A URL with no mode would otherwise be clobbered by the daemon's default
    // URL — pin mode: 'http' so the override survives the config loader.
    expect(config.discovery).toEqual({
      mode: 'http',
      url: 'https://my-indexer.example/graphql',
    });
  });

  it('pins the on-chain floor when only the mode is overridden', () => {
    const config = buildOperatorClientConfig({
      rpcUrl: 'https://base-sepolia.example',
      clientHome: '/tmp/jinn-acceptance/.jinn-client',
      runIdSuffix: 'unit',
      env: {
        JINN_TESTNET_ACCEPTANCE_DISCOVERY_MODE: 'onchain',
      },
    });

    expect(config.discovery).toEqual({ mode: 'onchain' });
  });
});
