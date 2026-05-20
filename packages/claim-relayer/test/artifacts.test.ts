import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadArtifactAddresses } from '../src/artifacts.js';

const DISTRIBUTOR = '0x2222222222222222222222222222222222222222' as const;
const MESSENGER = '0x3333333333333333333333333333333333333333' as const;
const TASK_CLAIM_EMITTER = '0x4444444444444444444444444444444444444444' as const;
const LEGACY_EMITTER = '0x5555555555555555555555555555555555555555' as const;

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

describe('deployment artifacts', () => {
  it('does not fall back to legacy JinnClaimEmitter artifacts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jinn-claim-relayer-artifacts-'));
    const l1Path = path.join(dir, 'l1.json');
    const l2Path = path.join(dir, 'l2.json');
    writeJson(l1Path, {
      contracts: {
        JinnDistributor: DISTRIBUTOR,
        MockMessenger: MESSENGER,
      },
    });
    writeJson(l2Path, {
      contracts: {
        JinnClaimEmitter: LEGACY_EMITTER,
      },
    });

    expect(() => loadArtifactAddresses({
      l1ArtifactPath: l1Path,
      l2ArtifactPath: l2Path,
    })).toThrow('TaskClaimEmitter');
  });

  it('allows explicit address fixtures without reading missing artifacts', () => {
    const addresses = loadArtifactAddresses({
      l1ArtifactPath: '/tmp/missing-l1.json',
      l2ArtifactPath: '/tmp/missing-l2.json',
      distributorAddress: DISTRIBUTOR,
      messengerAddress: MESSENGER,
      claimEmitterAddress: TASK_CLAIM_EMITTER,
    });

    expect(addresses.distributor).toBe(DISTRIBUTOR);
    expect(addresses.messenger).toBe(MESSENGER);
    expect(addresses.claimEmitter).toBe(TASK_CLAIM_EMITTER);
  });
});
