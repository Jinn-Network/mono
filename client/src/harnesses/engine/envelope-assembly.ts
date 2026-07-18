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
  LegacyEnvelopeRole,
  EvidenceTier,
  SignedEnvelope,
  Artifact,
  GeneratorModel,
} from '../../types/envelope.js';
import { normalizeEnvelopeRole } from '../../types/envelope.js';
import { deriveDistributionClass } from './generator-model.js';
import { validatePayload } from '../../types/payloads/index.js';
import { validateManifestForPublish } from './validate-manifest.js';

export interface EnvelopeInputs {
  solverType: string;
  role: Role | LegacyEnvelopeRole;
  task: {
    cid: string;
    onchainCreationTx: string;
    onchainCreationBlock: number;
    requestId: string;
    /** Unix-seconds block timestamp; absent on RPC failure (never "now"). See #1827. */
    createdAt?: number;
    /** Copied from the parsed task doc's spec; absent for solver types without repo identity. */
    instanceId?: string;
    repo?: string;
    baseCommit?: string;
  };
  participant: { safeAddress: string; agentEoa: string };
  window: { startTs: number; endTs: number };
  executor: {
    implName: string;
    implVersion: string;
    clientGitSha: string;
    codeDigest: string;
    runtimeBundleDigest: string;
    plugins: Array<{ name: string; version: string; cid?: string; sha256: string }>;
    signingKey: { kind: 'agent-eoa' | 'enclave-bound'; pubkey: string };
    source?: {
      bundleCid: string;
      sha256: string;
      humanUrl?: string;
      buildRecipe: { kind: 'dockerfile' | 'nix' | 'bazel'; path: string };
      measurement: string;
    };
    mode?: 'train' | 'frozen';
    /**
     * Underlying LLM model identifier this attempt was run against (e.g.
     * 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6'). When present,
     * stamped directly into the envelope's executor.model field (jinn-mono-gbut).
     */
    model?: string;
    /** Stream-sourced (or config-fallback) generator model provenance. See #1827. */
    generatorModel?: GeneratorModel;
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
  const role = normalizeEnvelopeRole(inputs.role);

  // Validate the payload against the registry before building the envelope.
  validatePayload(inputs.solverType, role, inputs.payload);

  const unsigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    solverType: inputs.solverType,
    role,
    generatedAt,
    task: inputs.task,
    participant: inputs.participant,
    window: inputs.window,
    executor: { ...inputs.executor, mode: inputs.executor.mode ?? 'train' },
    evidenceTier,
    attestation,
    trajectory,
    artifacts: inputs.artifacts,
    payload: inputs.payload,
    // Derived, not caller-supplied (#1827, design trade-off (c)): stamping
    // here — rather than at read time — means the signed record itself
    // carries the class, and it can never drift from the executor's actual
    // generatorModel because it's computed from that same input.
    distributionClass: deriveDistributionClass(inputs.executor.generatorModel),
  };

  // Pre-publish manifest validation: reject malformed envelopes before wasting
  // signature CPU; closes the seam against direct callers that bypass the
  // OUTPUTS.json / config-driven access resolution. Throws ManifestValidationError
  // on a missing/malformed access descriptor (Phase A.1, jinn-mono-vy37.1.3).
  validateManifestForPublish({ ...unsigned, signature: { algo: 'secp256k1', signer: inputs.participant.agentEoa as `0x${string}`, hash: '0x', sig: '0x' } });

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
