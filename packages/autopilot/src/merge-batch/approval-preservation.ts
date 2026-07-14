export type ApprovalPreservation =
  | { kind: 'preserved'; reason: string }
  | { kind: 'requires-review'; reason: string };

export function classifyApprovalPreservation(rangeDiffOutput: string): ApprovalPreservation {
  const lines = rangeDiffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.some((line) => line.includes('!'))) {
    return { kind: 'requires-review', reason: 'range-diff shows changed patch content' };
  }

  if (lines.some((line) => line.startsWith('-:') || line.includes('>'))) {
    return { kind: 'requires-review', reason: 'range-diff shows added or removed commits' };
  }

  return { kind: 'preserved', reason: 'range-diff shows patch-equivalent commits' };
}
