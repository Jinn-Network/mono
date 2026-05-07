import { describe, it, expect, vi } from 'vitest';
import { checkpointInstallCommand } from '../../src/cli/commands/checkpoint.js';

const fakeManifest = {
  schemaVersion: 'harness.checkpoint.v1',
  name: '@team/x',
  version: '0.1.0',
  parentCheckpointCid: null,
  harnessPackage: {
    implName: 'x',
    implVersion: '0.1.0',
    clientGitSha: '0xabc',
    sourceBundleCid: 'bafy_src',
  },
  implStateDirCid: 'bafy_state',
  codeDigest: 'sha256:' + 'a'.repeat(64),
  publisher: {
    agentId: 'did:jinn:eth:0x1234',
    signingKey: 'ed25519:' + 'b'.repeat(64),
    safeAddress: '0x' + 'c'.repeat(40),
  },
  publishedAt: '2026-05-15T12:00:00Z',
  registry: {
    anchor: 'IdentityRegistry.setMetadata',
    metadataKey: 'harness.checkpoint:bafy_pin',
    txHash: '0x' + 'd'.repeat(64),
    blockNumber: 100,
  },
  signature: 'ed25519-sig-stub',
};

describe('jinn checkpoint install', () => {
  it('fetches a checkpoint manifest, verifies signature, stages implStateDir', async () => {
    const deps = {
      fetchFromIpfs: vi.fn().mockResolvedValue(JSON.stringify(fakeManifest)),
      verifySignature: vi.fn().mockResolvedValue(true),
      fetchImplStateDirToLocal: vi.fn().mockResolvedValue('/tmp/staged'),
      stageAsHarnessState: vi.fn().mockResolvedValue(undefined),
    };
    const result = await checkpointInstallCommand({ cid: 'bafy_checkpoint_cid', deps });
    expect(result.installed).toBe(true);
    expect(deps.verifySignature).toHaveBeenCalled();
    expect(deps.stageAsHarnessState).toHaveBeenCalled();
  });

  it('rejects manifest with invalid signature', async () => {
    const deps = {
      fetchFromIpfs: vi.fn().mockResolvedValue(JSON.stringify(fakeManifest)),
      verifySignature: vi.fn().mockResolvedValue(false),
      fetchImplStateDirToLocal: vi.fn(),
      stageAsHarnessState: vi.fn(),
    };
    await expect(checkpointInstallCommand({ cid: 'bafy', deps })).rejects.toThrow(/signature/);
  });
});
