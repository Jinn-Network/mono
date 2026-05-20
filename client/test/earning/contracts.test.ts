import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_TESTNET_ARTIFACTS,
  IDENTITY_REGISTRY_ADDRESSES,
  getChainConfig,
  loadJinnMviConfig,
} from '../../src/earning/contracts.js';

const BASE_SEPOLIA_TASK_CLAIM_EMITTER = '0xF60055534E377F4020eEA80356C0643E02f4f307';
const BASE_SEPOLIA_TASK_CLAIM_EMITTER_DEPLOY_BLOCK = 41761151;
const BASE_SEPOLIA_TASK_CLAIM_EMITTER_TX =
  '0x97524384c024a2bcfe11b3699bad53e8533bc25f43e64101ce1e0e4170491f9b';

describe('getChainConfig', () => {
  it('does not expose legacy claim coordination on Base Sepolia clean-break config', () => {
    const cfg = getChainConfig('base-sepolia');

    expect('claimRegistry' in cfg).toBe(false);
  });

  it('resolves Base Sepolia runtime to bundled Task-native router metadata', () => {
    const cfg = getChainConfig('base-sepolia');

    expect(cfg.jinnRouter).toBe('0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9');
    expect(cfg.mechMarketplace).toBe('0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7');
    expect(cfg.routerClaimDeliveryVersion).toBe('v3');
  });

  it('does not expose legacy claim coordination on Base mainnet clean-break config', () => {
    const cfg = getChainConfig('base');

    expect('claimRegistry' in cfg).toBe(false);
  });

  // ── ERC-8004 IdentityRegistry (jinn-mono-j07) ────────────────────────────
  it('exposes the canonical IdentityRegistry on Base mainnet', () => {
    const cfg = getChainConfig('base');
    // Vanity address from erc-8004/erc-8004-contracts/scripts/addresses.ts.
    expect(cfg.identityRegistry).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
  });

  it('exposes the canonical IdentityRegistry on Base Sepolia', () => {
    const cfg = getChainConfig('base-sepolia');
    expect(cfg.identityRegistry).toBe(
      '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    );
  });

  it('IDENTITY_REGISTRY_ADDRESSES is keyed by chainId for both Base + Sepolia variants', () => {
    expect(IDENTITY_REGISTRY_ADDRESSES[8453]).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
    expect(IDENTITY_REGISTRY_ADDRESSES[84532]).toBe(
      '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    );
  });

  it('resolves bundled Base Sepolia JINN MVI L2 artifact to TaskClaimEmitter', () => {
    const artifactPath = DEFAULT_TESTNET_ARTIFACTS.jinnMviL2;
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      deployBlock?: number;
      txHash?: string;
      contracts?: Record<string, string | undefined>;
    };

    expect(artifact.contracts?.TaskClaimEmitter).toBe(BASE_SEPOLIA_TASK_CLAIM_EMITTER);
    expect(artifact.deployBlock).toBe(BASE_SEPOLIA_TASK_CLAIM_EMITTER_DEPLOY_BLOCK);
    expect(artifact.txHash).toBe(BASE_SEPOLIA_TASK_CLAIM_EMITTER_TX);
    expect(artifact.contracts?.TaskActivityCheckerV3).toBe(
      '0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70',
    );
    expect(artifact.contracts?.ServiceRegistry).toBe(
      '0x31D3202d8744B16A120117A053459DDFAE93c855',
    );
    expect(artifact.contracts?.JinnClaimEmitter).toBeUndefined();
    expect(artifact.contracts?.RestorationActivityCheckerV2).toBeUndefined();

    expect(loadJinnMviConfig({ l2ArtifactPath: artifactPath }).claimEmitter).toBe(
      BASE_SEPOLIA_TASK_CLAIM_EMITTER,
    );
  });
});
