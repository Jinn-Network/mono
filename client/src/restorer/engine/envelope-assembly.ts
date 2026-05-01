/**
 * Envelope assembly + signing.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §4.2a mechanics:
 *   - envelopeHash = keccak256(JCS(envelope minus signature))
 *   - hash is what gets signed; also = evidenceHash on-chain
 *   - Signed envelope (with signature field populated) is uploaded to IPFS
 */

import type { Hex } from 'viem';
import { signCanonical } from './signing.js';
import { uploadToIpfs } from '../../adapters/mech/ipfs.js';
import type {
  Role,
  EvidenceTier,
  SignedEnvelope,
  Artifact,
} from '../../types/envelope.js';
import { validatePayload } from '../../types/payloads/index.js';
import { validateManifestForPublish } from './validate-manifest.js';

export interface EnvelopeInputs {
  kind: string;
  role: Role;
  intent: {
    cid: string;
    onchainCreationTx: string;
    onchainCreationBlock: number;
    requestId: string;
  };
  participant: { safeAddress: string; agentEoa: string };
  window: { startTs: number; endTs: number };
  executor: {
    implName: string;
    implVersion: string;
    clientGitSha: string;
    codeDigest: string;
    signingKey: { kind: 'agent-eoa' | 'enclave-bound'; pubkey: string };
    source?: {
      bundleCid: string;
      sha256: string;
      humanUrl?: string;
      buildRecipe: { kind: 'dockerfile' | 'nix' | 'bazel'; path: string };
      measurement: string;
    };
  };
  evidenceTier?: EvidenceTier;
  attestation?: SignedEnvelope['attestation'];
  trajectory?: SignedEnvelope['trajectory'];
  artifacts: Artifact[];
  payload: Record<string, unknown>;
  generatedAt?: number;
}

export interface AssembledEnvelope {
  envelope: SignedEnvelope;
  envelopeCid: string;
  envelopeHash: Hex;
}

export interface EnvelopeAssemblyDeps {
  ipfsRegistryUrl: string;
  agentEoaPrivateKey: Hex;
}

export async function assembleAndSignEnvelope(
  inputs: EnvelopeInputs,
  deps: EnvelopeAssemblyDeps,
): Promise<AssembledEnvelope> {
  const evidenceTier = inputs.evidenceTier ?? 'self-signed';
  const attestation = inputs.attestation ?? null;
  const trajectory = inputs.trajectory ?? null;
  const generatedAt = inputs.generatedAt ?? Date.now();

  // Validate the payload against the registry before building the envelope.
  validatePayload(inputs.kind, inputs.role, inputs.payload);

  const unsigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    kind: inputs.kind,
    role: inputs.role,
    generatedAt,
    intent: inputs.intent,
    participant: inputs.participant,
    window: inputs.window,
    executor: inputs.executor,
    evidenceTier,
    attestation,
    trajectory,
    artifacts: inputs.artifacts,
    payload: inputs.payload,
  };

  const signed = await signCanonical(
    unsigned,
    deps.agentEoaPrivateKey,
    inputs.participant.agentEoa as `0x${string}`,
  );
  const envelopeHash = signed.hash as Hex;

  const signedEnvelope: SignedEnvelope = {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: inputs.participant.agentEoa as `0x${string}`,
      hash: signed.hash,
      sig: signed.sig,
    },
  };

  // Pre-publish manifest validation hook (Phase A.1, jinn-mono-vy37.1.3).
  // Belt-and-suspenders that the artifact descriptors are fit for the corpus
  // before the envelope hits IPFS. Throws ManifestValidationError on a
  // missing/malformed access descriptor.
  validateManifestForPublish(signedEnvelope);

  const envelopeCid = await uploadToIpfs(deps.ipfsRegistryUrl, signedEnvelope);

  return { envelope: signedEnvelope, envelopeCid, envelopeHash };
}
