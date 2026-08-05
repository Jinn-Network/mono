import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { keccakEvidenceHash } from '@jinn-network/marketplace-binding';
import { canonicalJson } from '../../src/harnesses/engine/canonical-json.js';
import {
  LEGACY_ENVELOPE_EXTENSION_KEY,
  deliveryClaimEvidenceHash,
  isBridgedTepDeliveryBytes,
} from '../../src/daemon/bridge-legacy-delivery.js';

describe('deliveryClaimEvidenceHash (E46)', () => {
  it('uses keccakEvidenceHash on exact bridged TEP Delivery bytes', () => {
    const nestedEnvelope = {
      schemaVersion: 'jinn.execution.v1',
      solverType: 'prediction.v1',
      role: 'solution',
      signature: {
        algo: 'secp256k1',
        signer: '0x1111111111111111111111111111111111111111',
        hash: `0x${'aa'.repeat(32)}`,
        sig: `0x${'bb'.repeat(65)}`,
      },
    };
    const sealed = new TextEncoder().encode(JSON.stringify({
      protocol: 'https://spec.jinn.network/profiles/task-execution/v1',
      attempt: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      [LEGACY_ENVELOPE_EXTENSION_KEY]: JSON.stringify(nestedEnvelope),
    }));
    expect(isBridgedTepDeliveryBytes(sealed)).toBe(true);
    expect(deliveryClaimEvidenceHash(sealed)).toBe(keccakEvidenceHash(sealed));
  });

  it('uses envelope JCS keccak for bare SignedEnvelope IPFS payloads', () => {
    const unsigned = {
      schemaVersion: 'jinn.execution.v1' as const,
      solverType: 'prediction.v1',
      role: 'solution' as const,
      generatedAt: 1_000,
      task: {
        cid: `sha256:${'0'.repeat(64)}`,
        onchainCreationTx: `0x${'1'.repeat(64)}`,
        onchainCreationBlock: 1,
        requestId: `0x${'2'.repeat(64)}`,
      },
      participant: {
        safeAddress: `0x${'3'.repeat(40)}`,
        agentEoa: `0x${'4'.repeat(40)}`,
      },
      window: { startTs: 1, endTs: 2 },
      executor: {
        implName: 'prediction-v1-baseline',
        implVersion: '1.0.0',
        clientGitSha: 'dev',
        codeDigest: `sha256:${'5'.repeat(64)}`,
        runtimeBundleDigest: `sha256:${'6'.repeat(64)}`,
        plugins: [],
        signingKey: { kind: 'agent-eoa' as const, pubkey: `0x${'4'.repeat(40)}` },
        mode: 'train' as const,
      },
      evidenceTier: 'self-signed' as const,
      attestation: null,
      trajectory: null,
      artifacts: [],
      payload: { ok: true },
    };
    const hash = keccak256(new TextEncoder().encode(canonicalJson(unsigned)));
    const bare = {
      ...unsigned,
      signature: {
        algo: 'secp256k1',
        signer: `0x${'4'.repeat(40)}`,
        hash,
        sig: `0x${'cc'.repeat(65)}`,
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(bare));
    expect(isBridgedTepDeliveryBytes(bytes)).toBe(false);
    expect(deliveryClaimEvidenceHash(bytes)).toBe(hash);
  });
});
