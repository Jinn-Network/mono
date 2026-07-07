/**
 * HarnessCheckpoint — a published, frozen, forkable Harness state.
 *
 * A checkpoint is the artifact-level entity that bridges the substrate's
 * flowing operator-harnesses and the frozen-artifact world that recruits,
 * comparisons, and downstream integrations live in. Operators publish
 * checkpoints via `jinn checkpoint publish`; other operators install them
 * via `jinn checkpoint install`.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §7
 */

import { z } from 'zod';

export const HarnessCheckpointManifestSchema = z.object({
  schemaVersion: z.literal('harness.checkpoint.v1'),
  name: z.string().regex(/^(@[^/]+\/)?[^/@]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  parentCheckpointCid: z.string().nullable(),
  harnessPackage: z.object({
    implName: z.string().min(1),
    implVersion: z.string().min(1),
    clientGitSha: z.string().regex(/^(0x)?[0-9a-f]+$/),
    sourceBundleCid: z.string().min(1),
  }),
  implStateDirCid: z.string().min(1),
  codeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  publisher: z.object({
    agentId: z.string().min(1),
    signingKey: z.string().regex(/^ed25519:[0-9a-f]{64}$/),
    safeAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  }),
  publishedAt: z.string().datetime(),
  registry: z.object({
    anchor: z.literal('IdentityRegistry.setMetadata'),
    metadataKey: z.string().min(1),
    txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    blockNumber: z.number().int().positive(),
  }),
  signature: z.string().min(1),
});

export type HarnessCheckpointManifest = z.infer<typeof HarnessCheckpointManifestSchema>;
