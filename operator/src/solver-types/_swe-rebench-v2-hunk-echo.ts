/**
 * Hunk-subset echo constructor. Spec §5.3.
 */

import { createHash } from 'node:crypto';

export interface PatchHunk {
  id: string;
  content: string;
}

export interface HunkSubsetEchoInput {
  sourceInstanceId: string;
  repo: string;
  solverPatch: string;
  hunk: PatchHunk;
  baseCommit: string;
}

export interface HunkSubsetEchoCandidate {
  instance_id: string;
  repo: string;
  base_commit: string;
  gold_patch: string;
  sourceLineageHash: string;
  sourceInstanceId: string;
}

export function lineageHash(sourceInstanceId: string, hunkId: string): string {
  return createHash('sha256').update(`${sourceInstanceId}:${hunkId}`).digest('hex');
}

export function hunkSubsetInstanceId(sourceInstanceId: string, hunkId: string): string {
  return `${sourceInstanceId}__hunk-${hunkId}`;
}

/** Split a unified diff into hunks (simplified — one @@ block each). */
export function splitPatchHunks(patch: string): PatchHunk[] {
  const parts = patch.split(/(?=^@@ )/m).filter((p) => p.trim().length > 0);
  return parts.map((content, i) => ({
    id: createHash('sha256').update(content).digest('hex').slice(0, 12),
    content,
  }));
}

export function buildHunkSubsetEcho(input: HunkSubsetEchoInput): HunkSubsetEchoCandidate {
  return {
    instance_id: hunkSubsetInstanceId(input.sourceInstanceId, input.hunk.id),
    repo: input.repo,
    base_commit: input.baseCommit,
    gold_patch: input.hunk.content,
    sourceLineageHash: lineageHash(input.sourceInstanceId, input.hunk.id),
    sourceInstanceId: input.sourceInstanceId,
  };
}

export function revertHunkSubsetPatch(solverPatch: string, hunk: PatchHunk): string {
  return solverPatch.replace(hunk.content, '');
}
