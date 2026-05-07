import { describe, it, expect } from 'vitest';
import { HarnessCheckpointManifestSchema } from '../src/checkpoint.js';

const validManifest = {
  schemaVersion: 'harness.checkpoint.v1',
  name: '@some-team/claude-code-learner-fork',
  version: '2.1.4',
  parentCheckpointCid: 'bafybeigwoof...',
  harnessPackage: {
    implName: 'claude-code-learner-fork',
    implVersion: '2.1.4',
    clientGitSha: '0xabc1234567890',
    sourceBundleCid: 'bafybeisource...',
  },
  implStateDirCid: 'bafybeistate...',
  codeDigest: 'sha256:' + 'a'.repeat(64),
  publisher: {
    agentId: 'did:jinn:eth:0x1234',
    signingKey: 'ed25519:' + 'b'.repeat(64),
    safeAddress: '0x' + 'c'.repeat(40),
  },
  publishedAt: '2026-05-15T12:00:00Z',
  registry: {
    anchor: 'IdentityRegistry.setMetadata',
    metadataKey: 'harness.checkpoint:bafybeicheckpoint...',
    txHash: '0x' + 'd'.repeat(64),
    blockNumber: 12345678,
  },
  signature: 'ed25519-sig-' + 'e'.repeat(128),
};

describe('HarnessCheckpointManifestSchema', () => {
  it('accepts a valid manifest', () => {
    expect(() => HarnessCheckpointManifestSchema.parse(validManifest)).not.toThrow();
  });

  it('parentCheckpointCid is optional (null allowed for root checkpoints)', () => {
    const manifest = { ...validManifest, parentCheckpointCid: null };
    expect(() => HarnessCheckpointManifestSchema.parse(manifest)).not.toThrow();
  });

  it('rejects manifests missing required fields', () => {
    const bad = { ...validManifest, codeDigest: undefined };
    expect(() => HarnessCheckpointManifestSchema.parse(bad)).toThrow();
  });

  it('rejects malformed codeDigest', () => {
    const bad = { ...validManifest, codeDigest: 'not-a-sha256' };
    expect(() => HarnessCheckpointManifestSchema.parse(bad)).toThrow();
  });
});
