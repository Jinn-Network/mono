/**
 * skill-generate.ts
 *
 * Regenerates the command-table and MCP-tool-table sections of
 * operator/skills/jinn-operator/SKILL.md from the live CLI and MCP registries.
 *
 * Run:  yarn skill:generate
 * Check (CI):  yarn skill:check   -- diffs generated vs committed; exits 1 on drift
 *
 * The script rewrites two fenced regions in SKILL.md delimited by HTML comments:
 *
 *   <!-- skill:cli-table:start -->
 *   ...generated markdown table...
 *   <!-- skill:cli-table:end -->
 *
 *   <!-- skill:mcp-table:start -->
 *   ...generated markdown table...
 *   <!-- skill:mcp-table:end -->
 *
 * Everything outside those regions is left untouched.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const skillPath = join(clientRoot, 'skills', 'jinn-operator', 'SKILL.md');

// ── 1. Collect CLI commands ───────────────────────────────────────────────────

const { CLI_COMMANDS } = await import('../src/cli/index.js');

// ── 2. Collect MCP tools ──────────────────────────────────────────────────────

const { createOperatorServer } = await import('../src/mcp/operator-server.js');

// _registeredTools is private but accessible at runtime; we cast to access it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const server = createOperatorServer() as any;
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
const mcpTools: Array<{ name: string; description: string }> = Object.entries(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  server._registeredTools as Record<string, { description: string }>,
).map(([name, tool]) => ({ name, description: tool.description }));

// ── 3. Build replacement tables ───────────────────────────────────────────────

function cliTable(commands: typeof CLI_COMMANDS): string {
  const rows = commands.map((c) => `| \`jinn ${c.name}\` | ${c.summary} |`).join('\n');
  return `| Verb | What it does |\n|------|--------------|\n${rows}`;
}

function mcpTable(tools: typeof mcpTools): string {
  const rows = tools.map((t) => `| \`${t.name}\` | ${t.description} |`).join('\n');
  return `| Tool | What it does |\n|------|--------------|\n${rows}`;
}

// ── 4. Splice into SKILL.md ───────────────────────────────────────────────────

function spliceRegion(src: string, tag: string, newContent: string): string {
  const startMarker = `<!-- skill:${tag}:start -->`;
  const endMarker = `<!-- skill:${tag}:end -->`;
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Region markers for '${tag}' not found in SKILL.md`);
  }
  return (
    src.slice(0, startIdx + startMarker.length) +
    '\n' +
    newContent +
    '\n' +
    src.slice(endIdx)
  );
}

let skill = readFileSync(skillPath, 'utf8');
skill = spliceRegion(skill, 'cli-table', cliTable(CLI_COMMANDS));
skill = spliceRegion(skill, 'mcp-table', mcpTable(mcpTools));
writeFileSync(skillPath, skill, 'utf8');

console.log(`Updated ${skillPath}`);
console.log(`  CLI commands: ${CLI_COMMANDS.length}`);
console.log(`  MCP tools:    ${mcpTools.length}`);
