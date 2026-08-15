/**
 * skill-check.ts
 *
 * CI drift check for operator/skills/jinn-operator/SKILL.md.
 * Reads the committed SKILL.md, runs the generator logic in-memory,
 * and exits 1 if the result differs from what is on disk.
 *
 * Run:  yarn skill:check
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const skillPath = join(clientRoot, 'skills', 'jinn-operator', 'SKILL.md');

// ── 1. Collect CLI commands ───────────────────────────────────────────────────

const { CLI_COMMANDS } = await import('../src/cli/index.js');

// ── 2. Collect MCP tools ──────────────────────────────────────────────────────

const { createOperatorServer } = await import('../src/mcp/operator-server.js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const server = createOperatorServer() as any;
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
const mcpTools: Array<{ name: string; description: string }> = Object.entries(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  server._registeredTools as Record<string, { description: string }>,
).map(([name, tool]) => ({ name, description: tool.description }));

// ── 3. Build tables ───────────────────────────────────────────────────────────

function cliTable(commands: typeof CLI_COMMANDS): string {
  const rows = commands.map((c) => `| \`jinn ${c.name}\` | ${c.summary} |`).join('\n');
  return `| Verb | What it does |\n|------|--------------|\n${rows}`;
}

function mcpTable(tools: typeof mcpTools): string {
  const rows = tools.map((t) => `| \`${t.name}\` | ${t.description} |`).join('\n');
  return `| Tool | What it does |\n|------|--------------|\n${rows}`;
}

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

// ── 4. Compare ────────────────────────────────────────────────────────────────

const committed = readFileSync(skillPath, 'utf8');
let expected = committed;
expected = spliceRegion(expected, 'cli-table', cliTable(CLI_COMMANDS));
expected = spliceRegion(expected, 'mcp-table', mcpTable(mcpTools));

if (committed === expected) {
  console.log('skill:check passed — SKILL.md is up to date');
  process.exit(0);
}

// Show a minimal diff: which lines differ
const committedLines = committed.split('\n');
const expectedLines = expected.split('\n');
const diffLines: string[] = [];
const maxLen = Math.max(committedLines.length, expectedLines.length);
for (let i = 0; i < maxLen; i++) {
  const a = committedLines[i] ?? '(missing)';
  const b = expectedLines[i] ?? '(missing)';
  if (a !== b) {
    diffLines.push(`line ${i + 1}:`);
    diffLines.push(`  committed: ${a}`);
    diffLines.push(`  expected:  ${b}`);
  }
}

console.error('skill:check FAILED — SKILL.md is out of sync with CLI/MCP registries');
console.error('Run `yarn skill:generate` to regenerate the tables, then commit.');
console.error('');
console.error(diffLines.slice(0, 40).join('\n'));
if (diffLines.length > 40) {
  console.error(`... and ${diffLines.length - 40} more differing lines`);
}
process.exit(1);
