/**
 * Layer 1 artifact vocabulary + trajectory↔artifact linkage checks.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.1 K9 (artifactType vocabulary) + K5 (trajectory↔artifact bidirectional linkage).
 *
 * Two checks:
 *   checkArtifactVocabulary  — required artifactType values present
 *   checkArtifactLinkage     — bidirectional span↔artifact linkage
 */

import type { Artifact } from '../../types/envelope.js';
import type { CheckResult, ConformanceContext } from '../types.js';

// ─── Vocabulary check ─────────────────────────────────────────────────────────

/**
 * Check id: `artifacts.vocabulary`
 * Layer: 1
 *
 * Required artifact types per scope §3.1 K9:
 *   - `output.<kind>` — always required for restoration role
 *   - `system_snapshot` — always required for restoration role
 *   - `trajectory` — required when envelope.trajectory is non-null
 *
 * Custom artifact types are permitted (vocabulary is extensible).
 * Verdict-role envelopes are skipped — no output artifact is expected.
 */
export function checkArtifactVocabulary(ctx: ConformanceContext): CheckResult {
  const id = 'artifacts.vocabulary';
  const layer = 1 as const;
  const env = ctx.envelope;

  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };

  // Verdict envelopes have no output artifacts — skip vocabulary check.
  if (env.role === 'verdict') {
    return { id, layer, passed: true, skipped: true, detail: 'verdict role — no output artifacts required' };
  }

  const types = new Set(env.artifacts.map((a: Artifact) => a.artifactType));
  const missing: string[] = [];

  // output.<kind> is always required for restoration
  const outputType = `output.${env.kind}`;
  if (!types.has(outputType)) missing.push(outputType);

  // system_snapshot required for restoration
  if (!types.has('system_snapshot')) missing.push('system_snapshot');

  // trajectory required when envelope.trajectory is non-null
  if (env.trajectory != null && !types.has('trajectory')) missing.push('trajectory');

  if (missing.length > 0) {
    return {
      id,
      layer,
      passed: false,
      detail: `missing required artifactTypes: ${missing.join(', ')}`,
    };
  }

  return { id, layer, passed: true };
}

// ─── Linkage check ────────────────────────────────────────────────────────────

type SpanLike = { spanId: string; attributes: Record<string, unknown> };
type TrajLike = { spans: SpanLike[] };

/**
 * Check id: `artifacts.linkage`
 * Layer: 1
 *
 * Bidirectional linkage per scope §3.1 K5:
 *   1. Every artifact with `metadata.producedBy.spanId` must reference a
 *      span id that exists in the trajectory.
 *   2. Every `jinn.artifact.emit` span's `jinn.artifact.cid` attribute must
 *      reference a CID that is present in `envelope.artifacts[]`.
 *
 * Skipped when no trajectory is present.
 */
export function checkArtifactLinkage(ctx: ConformanceContext): CheckResult {
  const id = 'artifacts.linkage';
  const layer = 1 as const;
  const env = ctx.envelope;
  const traj = ctx.trajectory as TrajLike | null | undefined;

  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };
  if (!traj) {
    return { id, layer, passed: true, skipped: true, detail: 'trajectory not present' };
  }

  const spanIds = new Set(traj.spans.map((s) => s.spanId));
  const artifactCids = new Set(env.artifacts.map((a: Artifact) => a.cid));
  const failures: string[] = [];

  // 1. Every artifact with producedBy.spanId must reference a real span.
  for (const art of env.artifacts) {
    const producedBy = (art as { metadata?: { producedBy?: { spanId?: string } } }).metadata
      ?.producedBy;
    if (producedBy?.spanId && !spanIds.has(producedBy.spanId)) {
      failures.push(
        `artifact ${art.cid} references nonexistent spanId=${producedBy.spanId}`,
      );
    }
  }

  // 2. Every jinn.artifact.emit span must reference a real artifact CID.
  for (const span of traj.spans) {
    if (span.attributes['jinn.span.kind'] === 'jinn.artifact.emit') {
      const cid = span.attributes['jinn.artifact.cid'] as string | undefined;
      if (!cid) {
        failures.push(
          `span ${span.spanId} (jinn.artifact.emit) has no jinn.artifact.cid attribute`,
        );
      } else if (!artifactCids.has(cid)) {
        failures.push(
          `span ${span.spanId} references artifact CID ${cid} not in envelope.artifacts`,
        );
      }
    }
  }

  if (failures.length === 0) return { id, layer, passed: true };

  return {
    id,
    layer,
    passed: false,
    detail: failures.slice(0, 5).join('; '),
  };
}
