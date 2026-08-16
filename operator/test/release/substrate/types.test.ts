import { describe, it, expect } from 'vitest';
import { ManifestSchema, type Manifest } from '../../../scripts/release/types';

describe('ManifestSchema', () => {
  const validManifest = {
    substrateVersion: '1',
    createdAt: '2026-05-19T14:47:19Z',
    adoptedFrom: '~/.jinn-client/',
    name: 'op-a',
    shape: 'current' as const,
    role: 'launcher' as const,
    network: 'base-sepolia' as const,
    operator: {
      masterAddress: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
      fleetAgentId: '5474',
      fleetSafeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
      fleetStage: 'stage1_and_2',
      serviceId: 46,
      serviceStep: 'complete',
      agentEoa: '0x63192d38350b796856cF002caC25c377D9A0DB5A',
      safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
      mechAddress: '0x9c415369D0597e4867F419d256BD61D16a8C47b5',
      stakingAddress: '0x24e34E5037956a5Feca1AAAfaA30297084C228B8',
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    },
    config: {
      apiPort: 7332,
      rpcUrl: 'https://base-sepolia.gateway.tenderly.co/abc',
      joinedSolverNets: ['bafkrei123'],
    },
  };

  it('parses a valid manifest', () => {
    const parsed = ManifestSchema.parse(validManifest);
    expect(parsed.name).toBe('op-a');
    expect(parsed.operator.fleetAgentId).toBe('5474');
  });

  it('rejects missing required field', () => {
    const invalid = { ...validManifest, name: undefined };
    expect(() => ManifestSchema.parse(invalid)).toThrow();
  });

  it('rejects invalid network value', () => {
    const invalid = { ...validManifest, network: 'mainnet-pro' };
    expect(() => ManifestSchema.parse(invalid)).toThrow();
  });

  it('accepts pre-fleet shape with null fleet fields', () => {
    const preFleet: Manifest = {
      ...validManifest,
      name: 'op-c-legacy',
      shape: 'pre-fleet',
      role: 'legacy-backup',
      operator: {
        ...validManifest.operator,
        fleetAgentId: null,
        fleetSafeAddress: null,
        fleetStage: null,
      },
    };
    expect(() => ManifestSchema.parse(preFleet)).not.toThrow();
  });
});
