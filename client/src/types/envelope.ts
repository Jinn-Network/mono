/**
 * jinn.execution.v1 — generic signed envelope.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.1 (D5 + K1 knowledge tree), §3.2 (K3 executor provenance), §3.4 migration.
 *
 * One envelope shape covers restoration manifests (role='restoration') and
 * verdict manifests (role='verdict'). Payload is typed per (solverType, role) via
 * the registry in `./payloads/`.
 */

import { z } from 'zod';
import { WindowSchema } from './window.js';
import { SessionProvenanceSchema } from './session-provenance.js';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const EvidenceTierSchema = z.enum([
  'self-signed',
  'committed',
  'attested',
]);
export type EvidenceTier = z.infer<typeof EvidenceTierSchema>;

export const RoleSchema = z.enum(['restoration', 'verdict', 'capture']);
export type Role = z.infer<typeof RoleSchema>;

const TaskProvenanceSchema = z.object({
  cid: z.string().min(1),
  onchainCreationTx: HexStringSchema,
  onchainCreationBlock: z.number().int(),
  requestId: HexStringSchema,
});

const ParticipantSchema = z.object({
  safeAddress: HexStringSchema,
  agentEoa: HexStringSchema,
});

const SigningKeySchema = z.object({
  kind: z.enum(['agent-eoa', 'enclave-bound']),
  pubkey: HexStringSchema,
});

const SourceBundleSchema = z.object({
  bundleCid: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  humanUrl: z.string().optional(),
  buildRecipe: z.object({
    kind: z.enum(['dockerfile', 'nix', 'bazel']),
    path: z.string(),
  }),
  measurement: HexStringSchema,
});

const ExecutorSchema = z.object({
  implName: z.string().min(1),
  implVersion: z.string().min(1),
  clientGitSha: z.string().min(1),
  codeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  runtimeBundleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  plugins: z.array(z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    cid: z.string().min(1).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })),
  signingKey: SigningKeySchema,
  source: SourceBundleSchema.optional(),
  /**
   * Harness execution mode. Optional in v1 envelope schema for back-compat with
   * envelopes produced before this field was introduced. 'train' means the harness was running
   * with state writes enabled (Improve + Memory phases active in
   * claude-code-learner); 'frozen' means writes were disabled and the
   * implStateDir hash was preserved across the Task. See
   * docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.
   *
   * New envelopes always populate this field at assembly time. Readers should
   * treat undefined as 'train' (the legacy behaviour).
   */
  mode: z.enum(['train', 'frozen']).optional(),
});

const AttestationSchema = z.object({
  profile: z.string().min(1),
  quote: z.string(),
  reportData: HexStringSchema,
  measurement: HexStringSchema,
});

const TrajectoryRefSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  access: z.object({
    endpoint: z.string().url(),
    priceUsdc: z.string().regex(/^\d+(\.\d+)?$/),
  }),
});

export const ArtifactSourceSchema = z.object({
  kind: z.literal('ipfs'),
  cid: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  encoding: z.literal('jinn.artifact.donation.v1'),
});

const ArtifactSchema = z.object({
  artifactType: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  metadata: z
    .object({
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      producedBy: z
        .object({
          spanId: z.string(),
          trajectoryCid: z.string(),
        })
        .optional(),
    })
    .optional(),
  access: z.object({
    endpoint: z.string().url(),
    priceUsdc: z.string().regex(/^\d+(\.\d+)?$/),
  }),
  sources: z.array(ArtifactSourceSchema).optional(),
});

export type ArtifactSource = z.infer<typeof ArtifactSourceSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;

const SignatureSchema = z.object({
  algo: z.literal('secp256k1'),
  signer: HexStringSchema,
  hash: HexStringSchema,
  sig: HexStringSchema,
});

const BaseEnvelopeFields = {
  schemaVersion: z.literal('jinn.execution.v1'),
  solverType: z.string().min(1),
  role: RoleSchema,
  generatedAt: z.number().int(),
  task: TaskProvenanceSchema.optional(),
  sessionProvenance: SessionProvenanceSchema.optional(),
  participant: ParticipantSchema,
  window: WindowSchema,
  executor: ExecutorSchema,
  evidenceTier: EvidenceTierSchema,
  attestation: AttestationSchema.nullable(),
  trajectory: TrajectoryRefSchema.nullable(),
  artifacts: z.array(ArtifactSchema),
  payload: z.record(z.unknown()),
};

export const UnsignedEnvelopeSchema = z
  .object(BaseEnvelopeFields)
  .refine(
    (e) => e.evidenceTier !== 'attested' || e.executor.source !== undefined,
    { message: 'attested tier requires executor.source', path: ['executor', 'source'] },
  )
  .refine(
    (e) => e.evidenceTier !== 'attested' || e.attestation !== null,
    { message: 'attested tier requires attestation', path: ['attestation'] },
  )
  .refine(
    (e) => (e.role === 'capture'
      ? e.sessionProvenance !== undefined && e.task === undefined
      : e.task !== undefined && e.sessionProvenance === undefined),
    { message: 'role=capture requires sessionProvenance and no task; other roles require task and no sessionProvenance' },
  );

export type UnsignedEnvelope = z.infer<typeof UnsignedEnvelopeSchema>;

export const SignedEnvelopeSchema = z
  .object({ ...BaseEnvelopeFields, signature: SignatureSchema })
  .refine(
    (e) => e.evidenceTier !== 'attested' || e.executor.source !== undefined,
    { message: 'attested tier requires executor.source', path: ['executor', 'source'] },
  )
  .refine(
    (e) => e.evidenceTier !== 'attested' || e.attestation !== null,
    { message: 'attested tier requires attestation', path: ['attestation'] },
  )
  .refine(
    (e) => (e.role === 'capture'
      ? e.sessionProvenance !== undefined && e.task === undefined
      : e.task !== undefined && e.sessionProvenance === undefined),
    { message: 'role=capture requires sessionProvenance and no task; other roles require task and no sessionProvenance' },
  );

export type SignedEnvelope = z.infer<typeof SignedEnvelopeSchema>;
