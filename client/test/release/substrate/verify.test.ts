import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { verifySubstrate } from '../../../scripts/release/substrate-verify';
import { serializeVerifyResult, type Manifest } from '../../../scripts/release/types';
import { spawnAnvilFork, type AnvilForkHandle } from './helpers/anvil-fork';

describe('substrate-verify (manifest only)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-verify-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const validManifest: Manifest = {
    substrateVersion: '1',
    createdAt: '2026-05-19T14:47:19Z',
    adoptedFrom: '~/.jinn-client/',
    name: 'op-a',
    shape: 'current',
    role: 'launcher',
    network: 'base-sepolia',
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
      rpcUrl: 'https://base-sepolia.example/x',
      joinedSolverNets: ['bafkrei1'],
    },
  };

  async function seedOp(name: string, manifest: Manifest | null): Promise<void> {
    const opDir = path.join(tmpRoot, 'operators', name);
    await fs.mkdir(opDir, { recursive: true });
    if (manifest !== null) {
      await fs.writeFile(path.join(opDir, 'manifest.json'), JSON.stringify(manifest));
    }
  }

  it('reports ok when manifest is valid and skipOnChain=true', async () => {
    await seedOp('op-a', validManifest);
    const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: true });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('reports failure when manifest is missing', async () => {
    await seedOp('op-a', null);
    const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: true });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('manifest.json'))).toBe(true);
  });

  it('reports failure when manifest fails schema validation', async () => {
    await fs.mkdir(path.join(tmpRoot, 'operators', 'op-a'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'operators', 'op-a', 'manifest.json'), '{"substrateVersion": "1"}');
    const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: true });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.toLowerCase().includes('schema'))).toBe(true);
  });
});

describe('substrate-verify (on-chain check)', () => {
  let tmpRoot: string;
  let anvil: AnvilForkHandle;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-verify-onchain-'));
    anvil = await spawnAnvilFork();
  });

  afterEach(async () => {
    await anvil.stop();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reports failure when master EOA has zero ETH balance', async () => {
    const opDir = path.join(tmpRoot, 'operators', 'op-a');
    await fs.mkdir(path.join(opDir, '.jinn-client'), { recursive: true });
    const manifest: Manifest = {
      substrateVersion: '1',
      createdAt: '2026-05-19T14:47:19Z',
      adoptedFrom: '~/.jinn-client/',
      name: 'op-a',
      shape: 'current',
      role: 'launcher',
      network: 'base-sepolia',
      operator: {
        masterAddress: '0x1234567890123456789012345678901234567890',
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
      config: { apiPort: 7332, rpcUrl: anvil.rpcUrl, joinedSolverNets: [] },
    };
    await fs.writeFile(path.join(opDir, 'manifest.json'), JSON.stringify(manifest));

    const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: false });

    expect(result.onChain).not.toBeNull();
    expect(result.onChain!.ethBalanceWei).toBe(0n);
    expect(result.failures.some((f) => f.toLowerCase().includes('eth balance'))).toBe(true);

    const printable = serializeVerifyResult(result);
    expect(() => JSON.stringify(printable)).not.toThrow();
    expect(typeof printable.onChain!.ethBalanceWei).toBe('string');
  });
});
