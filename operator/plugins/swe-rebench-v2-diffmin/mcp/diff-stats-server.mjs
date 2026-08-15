#!/usr/bin/env node
/**
 * diff-stats MCP server — exposes one tool, diff_stats(patch: string),
 * that parses a unified diff and returns hunk/line/file/rename statistics.
 *
 * Designed to be invoked as a stdio MCP server by Claude Code or any other
 * MCP-compatible host. No runtime dependencies beyond @modelcontextprotocol/sdk
 * (already present in @jinn-network/client's node_modules).
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { computeDiffStats } from './diff-stats.mjs';

const DiffArgsShape = {
  patch: z.string().min(1).describe(
    'A unified diff string (git-format or standard format). ' +
    'Pass the complete diff including --- and +++ headers and @@ hunk markers.',
  ),
};

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function toolErr(code, message) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: true, code, message }) }],
    isError: true,
  };
}

export function createDiffStatsServer() {
  const server = new McpServer({ name: 'diff-stats', version: '0.1.0' });

  server.tool(
    'diff_stats',
    'Parse a unified diff and return statistics: hunks, filesTouched, addedLines, removedLines, hasRenames. ' +
    'Call this before submitting a patch to verify it meets minimal-diff discipline (hunks <= 3, filesTouched <= 2, hasRenames === false).',
    DiffArgsShape,
    async (args) => {
      try {
        const stats = computeDiffStats(args.patch);
        return ok(stats);
      } catch (err) {
        return toolErr('DIFF_PARSE_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

export async function startMcpServer() {
  const server = createDiffStatsServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise((resolve) => {
    process.stdin.on('close', resolve);
    process.stdin.on('end', resolve);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
