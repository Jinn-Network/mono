import { clampScore, type EvaluationSignal } from './signals.js';

export interface StructuralSimilarityInput {
  candidatePatch?: string | null;
  referencePatch?: string | null;
  weight?: number;
}

export function structuralSimilaritySignal(input: StructuralSimilarityInput): EvaluationSignal {
  const weight = input.weight ?? 0.3;
  if (!input.candidatePatch || !input.referencePatch) {
    return { present: false, score: 0, weight, reasoning: 'candidate or reference patch missing' };
  }
  const candidate = normalizedPatchLines(input.candidatePatch);
  const reference = normalizedPatchLines(input.referencePatch);
  if (candidate.length === 0 || reference.length === 0) {
    return { present: false, score: 0, weight, reasoning: 'patch has no comparable changed lines' };
  }
  const candidateSet = new Set(candidate);
  const referenceSet = new Set(reference);
  let overlap = 0;
  for (const line of candidateSet) {
    if (referenceSet.has(line)) overlap += 1;
  }
  const dice = (2 * overlap) / (candidateSet.size + referenceSet.size);
  return { present: true, score: clampScore(dice), weight };
}

function normalizedPatchLines(patch: string): string[] {
  return patch
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'));
}
