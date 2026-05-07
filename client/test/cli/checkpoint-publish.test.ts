import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointPublishCommand } from '../../src/cli/commands/checkpoint.js';
import type { CheckpointPublishDeps } from '../../src/cli/commands/checkpoint.js';

describe('jinn checkpoint publish', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'checkpoint-pub-'));
    await writeFile(join(stateDir, 'state.json'), '{"a": 1}');
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('produces a HarnessCheckpoint manifest, pins to IPFS, anchors via setMetadata', async () => {
    const deps: CheckpointPublishDeps = {
      pinToIpfs: vi.fn().mockResolvedValue('bafy_pinned_cid'),
      callSetMetadata: vi.fn().mockResolvedValue({ txHash: '0x' + 'a'.repeat(64), blockNumber: 100 }),
      hashImplStateDir: vi.fn().mockResolvedValue('a'.repeat(64)),
      sign: vi.fn().mockResolvedValue('ed25519-sig-stub'),
      getSigningIdentity: vi.fn().mockResolvedValue({
        agentId: 'did:jinn:eth:0x1234',
        signingKey: 'ed25519:' + 'b'.repeat(64),
        safeAddress: '0x' + 'c'.repeat(40),
      }),
    };
    const result = await checkpointPublishCommand({
      name: '@team/my-fork',
      version: '0.1.0',
      implStateDir: stateDir,
      sourceBundleCid: 'bafy_src',
      implName: 'my-fork',
      implVersion: '0.1.0',
      clientGitSha: '0xdeadbeef',
      deps,
    });
    expect(result.checkpointCid).toBe('bafy_pinned_cid');
    expect(deps.pinToIpfs).toHaveBeenCalled();
    expect(deps.callSetMetadata).toHaveBeenCalled();
  });
});
