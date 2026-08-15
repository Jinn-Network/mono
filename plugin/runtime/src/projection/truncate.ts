// SPDX-License-Identifier: Apache-2.0

export const TRUNCATION_TAIL = "\n[truncated]" as const;

function endsWithHighSurrogate(text: string): boolean {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
}

/**
 * Line-boundary-aware truncation ending in a neutral marker. Prefers to cut at a newline
 * so a partial command or diff hunk never reads as a whole one; falls back to a hard cut
 * when there is no boundary inside the budget. Returns empty when the budget cannot hold
 * both meaningful text and the complete marker — a lone marker is noise, not evidence.
 */
export function truncateLineBoundary(text: string, maxChars: number): string {
  const contentBudget = maxChars - TRUNCATION_TAIL.length;
  if (contentBudget <= 0) return "";
  if (text.length <= contentBudget) return text;

  let cut = text.slice(0, contentBudget);
  const atLineBoundary =
    cut.length === text.length || cut.endsWith("\n") || text[cut.length] === "\n";
  if (!atLineBoundary) {
    const lastNewline = cut.lastIndexOf("\n");
    if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  }
  if (endsWithHighSurrogate(cut)) cut = cut.slice(0, -1);
  if (cut.trim().length === 0) return "";
  return `${cut}${TRUNCATION_TAIL}`;
}
