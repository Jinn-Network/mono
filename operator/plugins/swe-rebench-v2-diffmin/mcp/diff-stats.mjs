/**
 * diff-stats library — parse a unified diff into per-file statistics.
 *
 * Pure function, no dependencies. Usable directly in tests and by the
 * diff-stats-server.mjs MCP server.
 */

/**
 * @typedef {{ hunks: number; filesTouched: number; addedLines: number; removedLines: number; hasRenames: boolean }} DiffStats
 */

/**
 * Parse a unified diff string and return statistics.
 *
 * @param {string} patch - A unified diff string (git-format or standard format).
 * @returns {DiffStats}
 * @throws {Error} if patch is empty.
 */
export function computeDiffStats(patch) {
  if (typeof patch !== 'string' || patch.trim().length === 0) {
    throw new Error('empty patch — pass a unified diff string');
  }

  const lines = patch.split('\n');
  let hunks = 0;
  let addedLines = 0;
  let removedLines = 0;
  let hasRenames = false;
  const files = new Set();

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      hunks++;
    } else if (line.startsWith('+++') && !line.startsWith('+++ /dev/null')) {
      // Match both `+++ b/path` (git format) and `+++ path` (standard format)
      const m = /^\+{3}\s+(?:b\/)?(.+)$/.exec(line);
      if (m) files.add(m[1].trim());
    } else if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      hasRenames = true;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines++;
    }
  }

  return { hunks, filesTouched: files.size, addedLines, removedLines, hasRenames };
}
