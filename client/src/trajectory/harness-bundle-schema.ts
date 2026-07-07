import { z } from 'zod/v3';

/**
 * harness-bundle.v1 — the operator's resolved harness configuration at
 * session capture time. The bundle's deterministic sha256 becomes
 * `executor.codeDigest` on the capture envelope (per spec §3.1).
 *
 * This artifact is what makes a capture replayable: third-party operators
 * can fetch the bundle CID, reconstitute the harness exactly, and either
 * reproduce the result or fork from it.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §3.1, §3.2.
 */
export const HARNESS_BUNDLE_ARTIFACT_TYPE = 'harness-bundle.v1' as const;

export const HarnessBundleManifestSchema = z.object({
  schemaVersion: z.literal('harness-bundle.v1'),
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
  capturePath: z.enum(['A', 'B', 'C', 'D']),
  tool: z.object({
    name: z.string(),
    version: z.string().optional(),
  }),
  /**
   * Per-file inventory of what's included in the bundle. Min 1 file when
   * the bundle artifact exists at all — an opted-out bundle (operator
   * disabled harness-bundle capture) is signalled by ABSENCE of the
   * artifact in the envelope's `artifacts[]`, not an empty manifest.
   */
  files: z.array(z.object({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
  })).min(1),
});

export type HarnessBundleManifest = z.infer<typeof HarnessBundleManifestSchema>;
