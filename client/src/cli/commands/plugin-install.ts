import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { platform, homedir } from 'node:os';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';

// ---------------------------------------------------------------------------
// Skill content resolution
// ---------------------------------------------------------------------------

const SKILL_DIR = fileURLToPath(new URL('../../../skills/jinn-operator', import.meta.url));

function loadSkillContent(): string {
  return readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8');
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n/);
  if (!match) return content;
  return content.slice(match[0].length).trimStart();
}

// ---------------------------------------------------------------------------
// Helpers — JSON MCP config
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function hasJsonMcpServer(filePath: string, rootKey: string): boolean {
  const data = readJsonFile(filePath);
  const section = data[rootKey] as Record<string, unknown> | undefined;
  return section !== undefined && 'jinn' in section;
}

function upsertJsonMcpServer(filePath: string, rootKey: string): { ok: boolean; detail: string } {
  const data = readJsonFile(filePath);
  const section = (data[rootKey] ?? {}) as Record<string, unknown>;
  if ('jinn' in section) {
    return { ok: true, detail: `Already configured in ${filePath}` };
  }
  section['jinn'] = { command: 'jinn-mcp' };
  data[rootKey] = section;
  writeJsonFile(filePath, data);
  return { ok: true, detail: `Wrote MCP entry to ${filePath}` };
}

function removeJsonMcpServer(filePath: string, rootKey: string): { ok: boolean; detail: string } {
  if (!existsSync(filePath)) {
    return { ok: true, detail: 'Config file does not exist' };
  }
  const data = readJsonFile(filePath);
  const section = (data[rootKey] ?? {}) as Record<string, unknown>;
  if (!('jinn' in section)) {
    return { ok: true, detail: 'Not configured' };
  }
  delete section['jinn'];
  data[rootKey] = section;
  writeJsonFile(filePath, data);
  return { ok: true, detail: `Removed MCP entry from ${filePath}` };
}

// ---------------------------------------------------------------------------
// Helpers — TOML MCP config (Codex)
// ---------------------------------------------------------------------------

const TOML_BLOCK = `[mcp_servers.jinn]\ncommand = "jinn-mcp"`;

function hasTomlMcpServer(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  return readFileSync(filePath, 'utf-8').includes('[mcp_servers.jinn]');
}

function upsertTomlMcpServer(filePath: string): { ok: boolean; detail: string } {
  if (hasTomlMcpServer(filePath)) {
    return { ok: true, detail: `Already configured in ${filePath}` };
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
  writeFileSync(filePath, existing + separator + TOML_BLOCK + '\n', 'utf-8');
  return { ok: true, detail: `Wrote MCP entry to ${filePath}` };
}

function removeTomlMcpServer(filePath: string): { ok: boolean; detail: string } {
  if (!existsSync(filePath)) {
    return { ok: true, detail: 'Config file does not exist' };
  }
  const content = readFileSync(filePath, 'utf-8');
  if (!content.includes('[mcp_servers.jinn]')) {
    return { ok: true, detail: 'Not configured' };
  }
  // Remove the block: header line + command line (and optional trailing blank line)
  const updated = content.replace(/\n?\[mcp_servers\.jinn\]\ncommand = "jinn-mcp"\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  writeFileSync(filePath, updated, 'utf-8');
  return { ok: true, detail: `Removed MCP entry from ${filePath}` };
}

// ---------------------------------------------------------------------------
// Helpers — Skill block (delimited append for VS Code, Gemini, Codex)
// ---------------------------------------------------------------------------

const BLOCK_START = '<!-- jinn-operator-start -->';
const BLOCK_END = '<!-- jinn-operator-end -->';

function hasSkillBlock(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  return readFileSync(filePath, 'utf-8').includes(BLOCK_START);
}

function upsertSkillBlock(filePath: string, content: string): { ok: boolean; detail: string } {
  mkdirSync(dirname(filePath), { recursive: true });
  const block = `${BLOCK_START}\n${content}\n${BLOCK_END}\n`;

  if (hasSkillBlock(filePath)) {
    // Replace existing block so `jinn plugin install` propagates updates
    const existing = readFileSync(filePath, 'utf-8');
    const re = new RegExp(
      BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '[\\s\\S]*?' +
      BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '\\n?',
    );
    writeFileSync(filePath, existing.replace(re, block), 'utf-8');
    return { ok: true, detail: `Updated skill block in ${filePath}` };
  }

  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
  writeFileSync(filePath, existing + separator + block, 'utf-8');
  return { ok: true, detail: `Appended skill block to ${filePath}` };
}

function removeSkillBlock(filePath: string): { ok: boolean; detail: string } {
  if (!existsSync(filePath)) {
    return { ok: true, detail: 'File does not exist' };
  }
  const content = readFileSync(filePath, 'utf-8');
  if (!content.includes(BLOCK_START)) {
    return { ok: true, detail: 'Skill block not present' };
  }
  const regex = new RegExp(`\\n?${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n?`, 'g');
  const updated = content.replace(regex, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  writeFileSync(filePath, updated, 'utf-8');
  return { ok: true, detail: `Removed skill block from ${filePath}` };
}

// ---------------------------------------------------------------------------
// Helpers — Claude skill directory (copy/delete)
// ---------------------------------------------------------------------------

function hasClaudeSkill(targetDir: string): boolean {
  return existsSync(join(targetDir, 'SKILL.md'));
}

function installClaudeSkill(targetDir: string): { ok: boolean; detail: string } {
  const verb = hasClaudeSkill(targetDir) ? 'Updated' : 'Copied';
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(SKILL_DIR, 'SKILL.md'), join(targetDir, 'SKILL.md'));
  return { ok: true, detail: `${verb} skill at ${targetDir}` };
}

function removeClaudeSkill(targetDir: string): { ok: boolean; detail: string } {
  if (!hasClaudeSkill(targetDir)) {
    return { ok: true, detail: 'Skill not installed' };
  }
  rmSync(targetDir, { recursive: true, force: true });
  return { ok: true, detail: `Removed skill from ${targetDir}` };
}

// ---------------------------------------------------------------------------
// Helpers — Cursor rule file
// ---------------------------------------------------------------------------

function hasCursorRule(targetPath: string): boolean {
  return existsSync(targetPath);
}

function installCursorRule(targetPath: string, content: string): { ok: boolean; detail: string } {
  const verb = hasCursorRule(targetPath) ? 'Updated' : 'Wrote';
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, 'utf-8');
  return { ok: true, detail: `${verb} rule at ${targetPath}` };
}

function removeCursorRule(targetPath: string): { ok: boolean; detail: string } {
  if (!hasCursorRule(targetPath)) {
    return { ok: true, detail: 'Rule not installed' };
  }
  rmSync(targetPath, { force: true });
  return { ok: true, detail: `Removed rule from ${targetPath}` };
}

// ---------------------------------------------------------------------------
// Helpers — command detection
// ---------------------------------------------------------------------------

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Platform paths
// ---------------------------------------------------------------------------

function claudeDesktopConfigDir(): string {
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude');
  }
  return join(homedir(), '.config', 'claude-desktop');
}

// ---------------------------------------------------------------------------
// Target definitions
// ---------------------------------------------------------------------------

interface TargetResult {
  ok: boolean;
  detail: string;
}

interface PluginTarget {
  id: string;
  name: string;
  detect(): boolean;
  isMcpConfigured(scope: 'user' | 'project'): boolean;
  isSkillConfigured(scope: 'user' | 'project'): boolean;
  installMcp(scope: 'user' | 'project'): Promise<TargetResult>;
  installSkill(scope: 'user' | 'project', skillContent: string): Promise<TargetResult>;
  removeMcp(scope: 'user' | 'project'): Promise<TargetResult>;
  removeSkill(scope: 'user' | 'project'): Promise<TargetResult>;
}

function claudeSkillDir(scope: 'user' | 'project'): string {
  if (scope === 'user') return join(homedir(), '.claude', 'skills', 'jinn-operator');
  return join(process.cwd(), '.claude', 'skills', 'jinn-operator');
}

const TARGETS: PluginTarget[] = [
  // ---- claude-code ----
  {
    id: 'claude-code',
    name: 'Claude Code',
    detect: () => commandExists('claude'),
    isMcpConfigured(scope) {
      // We can't easily check this without parsing claude's internal config.
      // Attempt to list MCP servers and check for jinn.
      try {
        const out = execSync(`claude mcp list --scope ${scope}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
        return out.includes('jinn');
      } catch {
        return false;
      }
    },
    isSkillConfigured(scope) {
      return hasClaudeSkill(claudeSkillDir(scope));
    },
    async installMcp(scope) {
      try {
        const out = execSync(`claude mcp list --scope ${scope}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
        if (out.includes('jinn')) {
          return { ok: true, detail: 'Already configured via claude CLI' };
        }
      } catch { /* proceed */ }
      try {
        execSync(`claude mcp add --scope ${scope} jinn -- jinn-mcp`, { stdio: 'ignore' });
        return { ok: true, detail: `Added jinn MCP via claude CLI (scope: ${scope})` };
      } catch (err) {
        return { ok: false, detail: `Failed to add MCP: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    async installSkill(scope) {
      return installClaudeSkill(claudeSkillDir(scope));
    },
    async removeMcp(scope) {
      try {
        execSync(`claude mcp remove --scope ${scope} jinn`, { stdio: 'ignore' });
        return { ok: true, detail: `Removed jinn MCP via claude CLI (scope: ${scope})` };
      } catch (err) {
        return { ok: false, detail: `Failed to remove MCP: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    async removeSkill(scope) {
      return removeClaudeSkill(claudeSkillDir(scope));
    },
  },

  // ---- claude-desktop ----
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    detect: () => existsSync(claudeDesktopConfigDir()),
    isMcpConfigured(_scope) {
      const cfgPath = join(claudeDesktopConfigDir(), 'claude_desktop_config.json');
      return hasJsonMcpServer(cfgPath, 'mcpServers');
    },
    isSkillConfigured(scope) {
      // Claude Desktop uses same skill directory as Claude Code (user scope always)
      return hasClaudeSkill(claudeSkillDir(scope === 'project' ? 'user' : scope));
    },
    async installMcp(_scope) {
      const cfgPath = join(claudeDesktopConfigDir(), 'claude_desktop_config.json');
      return upsertJsonMcpServer(cfgPath, 'mcpServers');
    },
    async installSkill(scope) {
      // Claude Desktop always uses user scope for skills
      return installClaudeSkill(claudeSkillDir(scope === 'project' ? 'user' : scope));
    },
    async removeMcp(_scope) {
      const cfgPath = join(claudeDesktopConfigDir(), 'claude_desktop_config.json');
      return removeJsonMcpServer(cfgPath, 'mcpServers');
    },
    async removeSkill(scope) {
      return removeClaudeSkill(claudeSkillDir(scope === 'project' ? 'user' : scope));
    },
  },

  // ---- cursor ----
  {
    id: 'cursor',
    name: 'Cursor',
    detect: () => existsSync(join(homedir(), '.cursor')),
    isMcpConfigured(scope) {
      const cfgPath = scope === 'user'
        ? join(homedir(), '.cursor', 'mcp.json')
        : join(process.cwd(), '.cursor', 'mcp.json');
      return hasJsonMcpServer(cfgPath, 'mcpServers');
    },
    isSkillConfigured(scope) {
      const rulePath = scope === 'user'
        ? join(homedir(), '.cursor', 'rules', 'jinn.md')
        : join(process.cwd(), '.cursor', 'rules', 'jinn.md');
      return hasCursorRule(rulePath);
    },
    async installMcp(scope) {
      const cfgPath = scope === 'user'
        ? join(homedir(), '.cursor', 'mcp.json')
        : join(process.cwd(), '.cursor', 'mcp.json');
      return upsertJsonMcpServer(cfgPath, 'mcpServers');
    },
    async installSkill(scope, skillContent) {
      const rulePath = scope === 'user'
        ? join(homedir(), '.cursor', 'rules', 'jinn.md')
        : join(process.cwd(), '.cursor', 'rules', 'jinn.md');
      return installCursorRule(rulePath, skillContent);
    },
    async removeMcp(scope) {
      const cfgPath = scope === 'user'
        ? join(homedir(), '.cursor', 'mcp.json')
        : join(process.cwd(), '.cursor', 'mcp.json');
      return removeJsonMcpServer(cfgPath, 'mcpServers');
    },
    async removeSkill(scope) {
      const rulePath = scope === 'user'
        ? join(homedir(), '.cursor', 'rules', 'jinn.md')
        : join(process.cwd(), '.cursor', 'rules', 'jinn.md');
      return removeCursorRule(rulePath);
    },
  },

  // ---- vscode ----
  {
    id: 'vscode',
    name: 'VS Code',
    detect: () => commandExists('code'),
    isMcpConfigured(scope) {
      if (scope === 'user') return false; // VS Code MCP is project-scoped only via .vscode/mcp.json
      const cfgPath = join(process.cwd(), '.vscode', 'mcp.json');
      return hasJsonMcpServer(cfgPath, 'servers');
    },
    isSkillConfigured(scope) {
      if (scope === 'user') return false;
      const instrPath = join(process.cwd(), '.github', 'copilot-instructions.md');
      return hasSkillBlock(instrPath);
    },
    async installMcp(scope) {
      if (scope === 'user') {
        return { ok: true, detail: 'VS Code MCP requires project scope (--scope project)' };
      }
      const cfgPath = join(process.cwd(), '.vscode', 'mcp.json');
      return upsertJsonMcpServer(cfgPath, 'servers');
    },
    async installSkill(scope, skillContent) {
      if (scope === 'user') {
        return { ok: true, detail: 'VS Code skill requires project scope (--scope project)' };
      }
      const instrPath = join(process.cwd(), '.github', 'copilot-instructions.md');
      return upsertSkillBlock(instrPath, stripFrontmatter(skillContent));
    },
    async removeMcp(scope) {
      if (scope === 'user') {
        return { ok: true, detail: 'Not configured at user scope' };
      }
      const cfgPath = join(process.cwd(), '.vscode', 'mcp.json');
      return removeJsonMcpServer(cfgPath, 'servers');
    },
    async removeSkill(scope) {
      if (scope === 'user') {
        return { ok: true, detail: 'Not configured at user scope' };
      }
      const instrPath = join(process.cwd(), '.github', 'copilot-instructions.md');
      return removeSkillBlock(instrPath);
    },
  },

  // ---- gemini-cli ----
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    detect: () => existsSync(join(homedir(), '.gemini')),
    isMcpConfigured(scope) {
      const cfgPath = scope === 'user'
        ? join(homedir(), '.gemini', 'settings.json')
        : join(process.cwd(), '.gemini', 'settings.json');
      return hasJsonMcpServer(cfgPath, 'mcpServers');
    },
    isSkillConfigured(scope) {
      const instrPath = scope === 'user'
        ? join(homedir(), '.gemini', 'GEMINI.md')
        : join(process.cwd(), 'GEMINI.md');
      return hasSkillBlock(instrPath);
    },
    async installMcp(scope) {
      const cfgPath = scope === 'user'
        ? join(homedir(), '.gemini', 'settings.json')
        : join(process.cwd(), '.gemini', 'settings.json');
      return upsertJsonMcpServer(cfgPath, 'mcpServers');
    },
    async installSkill(scope, skillContent) {
      const instrPath = scope === 'user'
        ? join(homedir(), '.gemini', 'GEMINI.md')
        : join(process.cwd(), 'GEMINI.md');
      return upsertSkillBlock(instrPath, stripFrontmatter(skillContent));
    },
    async removeMcp(scope) {
      const cfgPath = scope === 'user'
        ? join(homedir(), '.gemini', 'settings.json')
        : join(process.cwd(), '.gemini', 'settings.json');
      return removeJsonMcpServer(cfgPath, 'mcpServers');
    },
    async removeSkill(scope) {
      const instrPath = scope === 'user'
        ? join(homedir(), '.gemini', 'GEMINI.md')
        : join(process.cwd(), 'GEMINI.md');
      return removeSkillBlock(instrPath);
    },
  },

  // ---- antigravity ----
  {
    id: 'antigravity',
    name: 'Antigravity',
    detect: () => existsSync(join(homedir(), '.gemini', 'antigravity')),
    isMcpConfigured(_scope) {
      const cfgPath = join(homedir(), '.gemini', 'antigravity', 'mcp_config.json');
      return hasJsonMcpServer(cfgPath, 'mcpServers');
    },
    isSkillConfigured(_scope) {
      const instrPath = join(homedir(), '.gemini', 'GEMINI.md');
      return hasSkillBlock(instrPath);
    },
    async installMcp(_scope) {
      const cfgPath = join(homedir(), '.gemini', 'antigravity', 'mcp_config.json');
      return upsertJsonMcpServer(cfgPath, 'mcpServers');
    },
    async installSkill(_scope, skillContent) {
      const instrPath = join(homedir(), '.gemini', 'GEMINI.md');
      return upsertSkillBlock(instrPath, stripFrontmatter(skillContent));
    },
    async removeMcp(_scope) {
      const cfgPath = join(homedir(), '.gemini', 'antigravity', 'mcp_config.json');
      return removeJsonMcpServer(cfgPath, 'mcpServers');
    },
    async removeSkill(_scope) {
      const instrPath = join(homedir(), '.gemini', 'GEMINI.md');
      return removeSkillBlock(instrPath);
    },
  },

  // ---- codex ----
  {
    id: 'codex',
    name: 'Codex',
    detect: () => existsSync(join(homedir(), '.codex')),
    isMcpConfigured(scope) {
      const cfgPath = scope === 'user'
        ? join(homedir(), '.codex', 'config.toml')
        : join(process.cwd(), '.codex', 'config.toml');
      return hasTomlMcpServer(cfgPath);
    },
    isSkillConfigured(scope) {
      const instrPath = scope === 'user'
        ? join(homedir(), '.codex', 'AGENTS.md')
        : join(process.cwd(), 'AGENTS.md');
      return hasSkillBlock(instrPath);
    },
    async installMcp(scope) {
      const cfgPath = scope === 'user'
        ? join(homedir(), '.codex', 'config.toml')
        : join(process.cwd(), '.codex', 'config.toml');
      return upsertTomlMcpServer(cfgPath);
    },
    async installSkill(scope, skillContent) {
      const instrPath = scope === 'user'
        ? join(homedir(), '.codex', 'AGENTS.md')
        : join(process.cwd(), 'AGENTS.md');
      return upsertSkillBlock(instrPath, stripFrontmatter(skillContent));
    },
    async removeMcp(scope) {
      const cfgPath = scope === 'user'
        ? join(homedir(), '.codex', 'config.toml')
        : join(process.cwd(), '.codex', 'config.toml');
      return removeTomlMcpServer(cfgPath);
    },
    async removeSkill(scope) {
      const instrPath = scope === 'user'
        ? join(homedir(), '.codex', 'AGENTS.md')
        : join(process.cwd(), 'AGENTS.md');
      return removeSkillBlock(instrPath);
    },
  },
];

// ---------------------------------------------------------------------------
// Subverb: install
// ---------------------------------------------------------------------------

interface ResultEntry {
  target: string;
  mcp: { status: string; detail: string };
  skill: { status: string; detail: string };
}

async function runInstall(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        scope: { type: 'string', default: 'user' },
        target: { type: 'string' },
        json: { type: 'boolean', default: false },
        human: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn plugin install --scope user',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const scope = (parsed.values.scope as string) === 'project' ? 'project' as const : 'user' as const;
  const targetFilter = parsed.values.target as string | undefined;

  let skillContent: string;
  try {
    skillContent = loadSkillContent();
  } catch (err) {
    emitEnvelope(
      {
        code: 'fatal',
        message: `Failed to load skill content: ${err instanceof Error ? err.message : String(err)}`,
        details: { skillDir: SKILL_DIR },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const targets = targetFilter
    ? TARGETS.filter((t) => t.id === targetFilter)
    : TARGETS;

  if (targetFilter && targets.length === 0) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown target: ${targetFilter}`,
        exampleCli: 'jinn plugin list',
        details: { field: '--target', expected: TARGETS.map((t) => t.id).join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const results: ResultEntry[] = [];

  for (const target of targets) {
    if (!target.detect()) {
      if (targetFilter) {
        results.push({
          target: target.id,
          mcp: { status: 'not_found', detail: `${target.name} not detected` },
          skill: { status: 'not_found', detail: `${target.name} not detected` },
        });
      }
      continue;
    }

    let mcpResult: { status: string; detail: string };
    if (target.isMcpConfigured(scope)) {
      mcpResult = { status: 'skipped', detail: 'Already configured' };
    } else {
      const r = await target.installMcp(scope);
      mcpResult = { status: r.ok ? 'configured' : 'error', detail: r.detail };
    }

    // Always run installSkill — the helpers handle both fresh installs and
    // updates (replacing existing content), so skill changes propagate when
    // the package is upgraded and `jinn plugin install` is re-run.
    const sr = await target.installSkill(scope, skillContent);
    const skillResult = { status: sr.ok ? 'configured' : 'error', detail: sr.detail };

    results.push({ target: target.id, mcp: mcpResult, skill: skillResult });
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'plugin install',
      results,
    },
    (v) => {
      const data = v as { results: ResultEntry[] };
      if (data.results.length === 0) return 'No targets detected.';
      const maxLen = Math.max(...data.results.map((r) => r.target.length));
      return data.results
        .map((r) => `${r.target.padEnd(maxLen + 2)}MCP: ${r.mcp.status.padEnd(12)}Skill: ${r.skill.status}`)
        .join('\n');
    },
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

// ---------------------------------------------------------------------------
// Subverb: remove
// ---------------------------------------------------------------------------

async function runRemove(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        scope: { type: 'string', default: 'user' },
        target: { type: 'string' },
        json: { type: 'boolean', default: false },
        human: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn plugin remove --target claude-code',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const scope = (parsed.values.scope as string) === 'project' ? 'project' as const : 'user' as const;
  const targetFilter = parsed.values.target as string | undefined;

  const targets = targetFilter
    ? TARGETS.filter((t) => t.id === targetFilter)
    : TARGETS;

  if (targetFilter && targets.length === 0) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown target: ${targetFilter}`,
        exampleCli: 'jinn plugin list',
        details: { field: '--target', expected: TARGETS.map((t) => t.id).join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const results: ResultEntry[] = [];

  for (const target of targets) {
    if (!target.detect()) {
      if (targetFilter) {
        results.push({
          target: target.id,
          mcp: { status: 'not_found', detail: `${target.name} not detected` },
          skill: { status: 'not_found', detail: `${target.name} not detected` },
        });
      }
      continue;
    }

    let mcpResult: { status: string; detail: string };
    if (!target.isMcpConfigured(scope)) {
      mcpResult = { status: 'skipped', detail: 'Not configured' };
    } else {
      const r = await target.removeMcp(scope);
      mcpResult = { status: r.ok ? 'removed' : 'error', detail: r.detail };
    }

    let skillResult: { status: string; detail: string };
    if (!target.isSkillConfigured(scope)) {
      skillResult = { status: 'skipped', detail: 'Not configured' };
    } else {
      const r = await target.removeSkill(scope);
      skillResult = { status: r.ok ? 'removed' : 'error', detail: r.detail };
    }

    results.push({ target: target.id, mcp: mcpResult, skill: skillResult });
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'plugin remove',
      results,
    },
    (v) => {
      const data = v as { results: ResultEntry[] };
      if (data.results.length === 0) return 'No targets detected.';
      const maxLen = Math.max(...data.results.map((r) => r.target.length));
      return data.results
        .map((r) => `${r.target.padEnd(maxLen + 2)}MCP: ${r.mcp.status.padEnd(12)}Skill: ${r.skill.status}`)
        .join('\n');
    },
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

// ---------------------------------------------------------------------------
// Subverb: list
// ---------------------------------------------------------------------------

interface ListEntry {
  id: string;
  name: string;
  detected: boolean;
  mcpConfigured: boolean;
  skillConfigured: boolean;
}

async function runList(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        scope: { type: 'string', default: 'user' },
        json: { type: 'boolean', default: false },
        human: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn plugin list',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const scope = (parsed.values.scope as string) === 'project' ? 'project' as const : 'user' as const;

  const targets: ListEntry[] = TARGETS.map((t) => {
    const detected = t.detect();
    return {
      id: t.id,
      name: t.name,
      detected,
      mcpConfigured: detected ? t.isMcpConfigured(scope) : false,
      skillConfigured: detected ? t.isSkillConfigured(scope) : false,
    };
  });

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'plugin list',
      targets,
    },
    (v) => {
      const data = v as { targets: ListEntry[] };
      const maxLen = Math.max(...data.targets.map((t) => t.id.length));
      return data.targets
        .map((t) => {
          if (!t.detected) return `${t.id.padEnd(maxLen + 2)}not found`;
          return `${t.id.padEnd(maxLen + 2)}detected   MCP: ${t.mcpConfigured ? 'yes' : 'no'}    Skill: ${t.skillConfigured ? 'yes' : 'no'}`;
        })
        .join('\n');
    },
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

// ---------------------------------------------------------------------------
// Verb dispatcher
// ---------------------------------------------------------------------------

async function run(ctx: CommandContext): Promise<void> {
  const [subverb, ...rest] = ctx.argv;
  if (!subverb) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn plugin requires a subverb: install, remove, list',
        exampleCli: 'jinn plugin install',
        details: { field: 'subverb', expected: 'install|remove|list' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  switch (subverb) {
    case 'install':
      return runInstall(ctx, rest);
    case 'remove':
      return runRemove(ctx, rest);
    case 'list':
      return runList(ctx, rest);
    default:
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown plugin subverb: ${subverb}`,
          exampleCli: 'jinn plugin install',
          details: { field: 'subverb', expected: 'install|remove|list' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
  }
}

const command: CommandModule = {
  name: 'plugin',
  summary: 'Configure AI tools to use Jinn MCP server and operator skill',
  helpText: `Usage: jinn plugin <install|remove|list> [options]

Subcommands:
  install   Configure detected AI tools with Jinn MCP server and operator skill
  remove    Remove Jinn configuration from AI tools
  list      Show detected AI tools and their configuration status

Options:
  --scope <user|project>   Install scope (default: user)
  --target <id>            Configure only this target
  --json                   JSON output (default)
  --human                  Human-readable output

Supported targets:
  claude-code      Claude Code CLI
  claude-desktop   Claude Desktop app
  cursor           Cursor editor
  vscode           VS Code (Copilot)
  gemini-cli       Gemini CLI
  antigravity      Antigravity (Gemini)
  codex            OpenAI Codex CLI

Examples:
  jinn plugin list --human
  jinn plugin install --human
  jinn plugin install --target claude-code --human
  jinn plugin install --scope project --target cursor
  jinn plugin remove --target claude-code
`,
  run,
};

export default command;
