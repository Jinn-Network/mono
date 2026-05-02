/**
 * Pre-publish manifest validation (Phase A.1, jinn-mono-vy37.1.3).
 */

import { describe, it, expect } from 'vitest';
import { validateManifestForPublish } from '../../../src/harnesses/engine/validate-manifest.js';
import type { SignedEnvelope } from '../../../src/types/envelope.js';

const baseEnvelope: SignedEnvelope = JSON.parse(
  JSON.stringify({
    schemaVersion: 'jinn.execution.v1',
    kind: 'prediction.v0',
    role: 'restoration',
    generatedAt: 1745978400,
task: {
      cid: 'bafy',
      onchainCreationTx: '0x' + 'a'.repeat(64),
      onchainCreationBlock: 1,
      requestId: '0x' + 'b'.repeat(64),
    },
    participant: {
      safeAddress: '0x' + '1'.repeat(40),
      agentEoa: '0x' + '2'.repeat(40),
    },
    window: { startMs: 0, endMs: 1000 },
    executor: {
      implName: 'test',
      implVersion: '0.1.0',
      clientGitSha: 'abc',
      codeDigest: 'sha256:' + 'c'.repeat(64),
      signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: {},
    signature: {
      algo: 'secp256k1',
      signer: '0x' + '2'.repeat(40),
      hash: '0x' + 'e'.repeat(64),
      sig: '0x' + 'f'.repeat(130),
    },
  }),
);

describe('validateManifestForPublish', () => {
  it('passes for an empty artifact list', () => {
    expect(() => validateManifestForPublish(baseEnvelope)).not.toThrow();
  });

  it('passes when every artifact has access.endpoint and access.priceUsdc', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [
        {
          artifactType: 'design_document',
          sha256: 'a'.repeat(64),
          access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
        },
      ],
    } as SignedEnvelope;
    expect(() => validateManifestForPublish(env)).not.toThrow();
  });

  it('throws if any artifact is missing access.endpoint', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [
        {
          artifactType: 'design_document',
          sha256: 'a'.repeat(64),
          access: { endpoint: '', priceUsdc: '0' },
        },
      ],
    } as SignedEnvelope;
    expect(() => validateManifestForPublish(env)).toThrow(/access\.endpoint/);
  });

  it('throws if access.endpoint is not http(s)', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [
        {
          artifactType: 'design_document',
          sha256: 'a'.repeat(64),
          access: { endpoint: 'ipfs://bafy', priceUsdc: '0' },
        },
      ],
    } as SignedEnvelope;
    expect(() => validateManifestForPublish(env)).toThrow(/http\(s\)/);
  });

  it('throws if any artifact is missing access.priceUsdc', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [
        {
          artifactType: 'design_document',
          sha256: 'a'.repeat(64),
          access: { endpoint: 'https://op.example.com', priceUsdc: '' },
        },
      ],
    } as SignedEnvelope;
    expect(() => validateManifestForPublish(env)).toThrow(/priceUsdc/);
  });

  it('throws if priceUsdc is not a decimal string', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [
        {
          artifactType: 'design_document',
          sha256: 'a'.repeat(64),
          access: { endpoint: 'https://op.example.com', priceUsdc: 'free' },
        },
      ],
    } as SignedEnvelope;
    expect(() => validateManifestForPublish(env)).toThrow(/priceUsdc/);
  });

  it('throws if sha256 is malformed', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [
        {
          artifactType: 'design_document',
          sha256: 'nothex',
          access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
        },
      ],
    } as SignedEnvelope;
    expect(() => validateManifestForPublish(env)).toThrow(/sha256/);
  });
});
