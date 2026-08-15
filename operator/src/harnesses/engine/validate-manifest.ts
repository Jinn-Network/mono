/**
 * Pre-publish validation that the envelope is fit for the corpus.
 *
 * Belt-and-suspenders against code paths that could bypass the OUTPUTS.json /
 * config-driven access resolution and emit a manifest with under-populated
 * artifact descriptors. Phase A.1, jinn-mono-vy37.1.3.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §6.3.
 */

import type { SignedEnvelope } from '../../types/envelope.js';

export class ManifestValidationError extends Error {
  constructor(public readonly artifactIndex: number, message: string) {
    super(`artifacts[${artifactIndex}]: ${message}`);
    this.name = 'ManifestValidationError';
  }
}

/**
 * Throws `ManifestValidationError` if any artifact descriptor in the envelope
 * is missing required `access` fields, has a non-http(s) endpoint, or carries
 * a malformed sha256/priceUsdc. The Zod schema in `types/envelope.ts` already
 * enforces these at parse time; this validator runs the same checks against
 * already-typed values so the engine can fail fast with a clear, structured
 * error before publishing the envelope.
 */
export function validateManifestForPublish(env: SignedEnvelope): void {
  for (let i = 0; i < env.artifacts.length; i++) {
    const a = env.artifacts[i]!;
    if (!a.access || typeof a.access !== 'object') {
      throw new ManifestValidationError(i, 'access is required');
    }
    if (!a.access.endpoint || typeof a.access.endpoint !== 'string') {
      throw new ManifestValidationError(i, 'access.endpoint must be a non-empty string');
    }
    if (!/^https?:\/\//i.test(a.access.endpoint)) {
      throw new ManifestValidationError(i, 'access.endpoint must be an http(s) URL');
    }
    if (!a.access.priceUsdc || typeof a.access.priceUsdc !== 'string') {
      throw new ManifestValidationError(i, 'access.priceUsdc must be a non-empty string');
    }
    if (!/^\d+(\.\d+)?$/.test(a.access.priceUsdc)) {
      throw new ManifestValidationError(i, 'access.priceUsdc must be a decimal string');
    }
    if (!a.sha256 || !/^[0-9a-f]{64}$/.test(a.sha256)) {
      throw new ManifestValidationError(i, 'sha256 must be a 64-char hex string');
    }
    for (const source of a.sources ?? []) {
      if (source.kind !== 'ipfs') {
        throw new ManifestValidationError(i, 'sources[].kind must be ipfs');
      }
      if (!source.cid || typeof source.cid !== 'string') {
        throw new ManifestValidationError(i, 'sources[].cid must be a non-empty string');
      }
      if (source.encoding !== 'jinn.artifact.donation.v1') {
        throw new ManifestValidationError(i, 'sources[].encoding must be jinn.artifact.donation.v1');
      }
      if (source.sha256 !== a.sha256) {
        throw new ManifestValidationError(i, 'sources[].sha256 must match artifact sha256');
      }
    }
  }
}
