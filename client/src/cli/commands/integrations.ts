import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { platform, homedir } from 'node:os';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { DEFAULT_STOP_HOOK_COMMAND, fileContainsHookCommand } from '../hook-installers/common.js';
import { patchClaudeCodeSettingsJson, removeClaudeCodeHookJson } from '../hook-installers/claude-code.js';
import { patchCodexConfigJson, removeCodexHookJson } from '../hook-installers/codex.js';
import { patchCursorHooksJson, removeCursorHookJson } from '../hook-installers/cursor.js';
import { patchGeminiCliSettingsJson, removeGeminiCliHookJson } from '../hook-installers/gemini-cli.js';

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
  section['jinn'] = { command: 'jinn', args: ['mcp'] };
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

const TOML_BLOCK = `[mcp_servers.jinn]\ncommand = "jinn"\nargs = ["mcp"]`;

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
  const updated = content
    .replace(/\n?\[mcp_servers\.jinn\]\ncommand = "jinn"\nargs = \["mcp"\]\n?/g, '\n')
    .replace(/\n?\[mcp_servers\.jinn\]\ncommand = "jinn-mcp"\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
  writeFileSync(filePath, updated, 'utf-8');
  return { ok: true, detail: `Removed MCP entry from ${filePath}` };
}

// ---------------------------------------------------------------------------
// Helpers — stop-hook config (§14.1 of
// docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md)
//
// `scripts/install-hooks/*` (moved to `src/cli/hook-installers/` in this
// change so it can be imported here and shipped in `dist/`) had zero
// production callers — the patcher functions existed but nothing ever wrote
// a hook config file. This wires them into the real installer surface.
//
// File-path confidence varies by tool:
//   - claude-code: `.claude/settings.json` (`hooks.Stop`) — this repo's own
//     convention (see CLAUDE.md's `.claude/settings.json` references), high
//     confidence.
//   - gemini-cli: reuses the same `settings.json` MCP already writes to
//     (`hooks.SessionEnd` alongside `mcpServers`) — Gemini CLI's real
//     hooks-in-settings.json surface, high confidence.
//   - codex / cursor: dedicated `hooks.json` next to each tool's existing
//     config dir. codex's real MCP config is TOML (`config.toml`), which
//     can't hold the JSON `hooks.stop` shape the pre-existing patcher
//     assumed — a separate JSON file sidesteps the format clash. This
//     assumption is NOT independently verified against either tool's
//     current hook documentation; treat it as best-effort until an
//     operator confirms it's picked up.
// ---------------------------------------------------------------------------

export function claudeCodeHookFilePath(scope: 'user' | 'project'): string {
  return scope === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(process.cwd(), '.claude', 'settings.json');
}

export function geminiCliHookFilePath(scope: 'user' | 'project'): string {
  return scope === 'user'
    ? join(homedir(), '.gemini', 'settings.json')
    : join(process.cwd(), '.gemini', 'settings.json');
}

export function codexHookFilePath(scope: 'user' | 'project'): string {
  return scope === 'user'
    ? join(homedir(), '.codex', 'hooks.json')
    : join(process.cwd(), '.codex', 'hooks.json');
}

export function cursorHookFilePath(scope: 'user' | 'project'): string {
  return scope === 'user'
    ? join(homedir(), '.cursor', 'hooks.json')
    : join(process.cwd(), '.cursor', 'hooks.json');
}

export function isHookFileConfigured(filePath: string, command: string): boolean {
  if (!existsSync(filePath)) return false;
  return fileContainsHookCommand(readFileSync(filePath, 'utf-8'), command);
}

export function installHookFile(
  filePath: string,
  command: string,
  patchFn: (raw: string) => string,
): { ok: boolean; detail: string } {
  if (isHookFileConfigured(filePath, command)) {
    return { ok: true, detail: `Already configured in ${filePath}` };
  }
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, patchFn(raw), 'utf-8');
  return { ok: true, detail: `Wrote stop-hook entry to ${filePath}` };
}

export function removeHookFile(
  filePath: string,
  command: string,
  removeFn: (raw: string) => string,
): { ok: boolean; detail: string } {
  if (!isHookFileConfigured(filePath, command)) {
    return { ok: true, detail: existsSync(filePath) ? 'Not configured' : 'Config file does not exist' };
  }
  writeFileSync(filePath, removeFn(readFileSync(filePath, 'utf-8')), 'utf-8');
  return { ok: true, detail: `Removed stop-hook entry from ${filePath}` };
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
    // Replace existing block so `jinn integrations install` propagates updates
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

/** A single file change that would be made during install. */
export interface PlanEntry {
  target: string;
  kind: 'mcp' | 'skill';
  filePath: string;
  fileExists: boolean;
  /** Exact content that would be appended/written (not the full file). */
  patch: string;
  alreadyConfigured: boolean;
}

interface PluginTarget {
  id: string;
  name: string;
  detect(): boolean;
  isMcpConfigured(scope: 'user' | 'project'): boolean;
  isSkillConfigured(scope: 'user' | 'project'): boolean;
  /** Return the filesystem path that MCP config would be written to, or null if not applicable. */
  mcpFilePath?(scope: 'user' | 'project'): string | null;
  /** Return the filesystem path that skill content would be written to, or null if not applicable. */
  skillFilePath?(scope: 'user' | 'project'): string | null;
  installMcp(scope: 'user' | 'project'): Promise<TargetResult>;
  installSkill(scope: 'user' | 'project', skillContent: string): Promise<TargetResult>;
  removeMcp(scope: 'user' | 'project'): Promise<TargetResult>;
  removeSkill(scope: 'user' | 'project'): Promise<TargetResult>;
  /**
   * §14.1 stop-hook wiring. Optional — only defined for targets with a known
   * stop/session-end hook surface (claude-code, codex, cursor, gemini-cli).
   * Absent on claude-desktop / vscode / antigravity.
   */
  isHookConfigured?(scope: 'user' | 'project'): boolean;
  installHook?(scope: 'user' | 'project'): Promise<TargetResult>;
  removeHook?(scope: 'user' | 'project'): Promise<TargetResult>;
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
    mcpFilePath(_scope) { return null; /* managed via `claude mcp add` CLI, no direct file path */ },
    skillFilePath(scope) { return join(claudeSkillDir(scope), 'SKILL.md'); },
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
        execSync(`claude mcp add --scope ${scope} jinn -- jinn mcp`, { stdio: 'ignore' });
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
    isHookConfigured(scope) {
      return isHookFileConfigured(claudeCodeHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`);
    },
    async installHook(scope) {
      return installHookFile(claudeCodeHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`, patchClaudeCodeSettingsJson);
    },
    async removeHook(scope) {
      return removeHookFile(claudeCodeHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`, removeClaudeCodeHookJson);
    },
  },

  // ---- claude-desktop ----
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    detect: () => existsSync(claudeDesktopConfigDir()),
    mcpFilePath(_scope) { return join(claudeDesktopConfigDir(), 'claude_desktop_config.json'); },
    skillFilePath(scope) { return join(claudeSkillDir(scope === 'project' ? 'user' : scope), 'SKILL.md'); },
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
    mcpFilePath(scope) {
      return scope === 'user'
        ? join(homedir(), '.cursor', 'mcp.json')
        : join(process.cwd(), '.cursor', 'mcp.json');
    },
    skillFilePath(scope) {
      return scope === 'user'
        ? join(homedir(), '.cursor', 'rules', 'jinn.md')
        : join(process.cwd(), '.cursor', 'rules', 'jinn.md');
    },
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
    isHookConfigured(scope) {
      return isHookFileConfigured(cursorHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool cursor`);
    },
    async installHook(scope) {
      return installHookFile(cursorHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool cursor`, patchCursorHooksJson);
    },
    async removeHook(scope) {
      return removeHookFile(cursorHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool cursor`, removeCursorHookJson);
    },
  },

  // ---- vscode ----
  {
    id: 'vscode',
    name: 'VS Code',
    detect: () => commandExists('code'),
    mcpFilePath(scope) {
      if (scope === 'user') return null;
      return join(process.cwd(), '.vscode', 'mcp.json');
    },
    skillFilePath(scope) {
      if (scope === 'user') return null;
      return join(process.cwd(), '.github', 'copilot-instructions.md');
    },
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
    mcpFilePath(scope) {
      return scope === 'user'
        ? join(homedir(), '.gemini', 'settings.json')
        : join(process.cwd(), '.gemini', 'settings.json');
    },
    skillFilePath(scope) {
      return scope === 'user'
        ? join(homedir(), '.gemini', 'GEMINI.md')
        : join(process.cwd(), 'GEMINI.md');
    },
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
    isHookConfigured(scope) {
      return isHookFileConfigured(geminiCliHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool gemini-cli`);
    },
    async installHook(scope) {
      return installHookFile(geminiCliHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool gemini-cli`, patchGeminiCliSettingsJson);
    },
    async removeHook(scope) {
      return removeHookFile(geminiCliHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool gemini-cli`, removeGeminiCliHookJson);
    },
  },

  // ---- antigravity ----
  {
    id: 'antigravity',
    name: 'Antigravity',
    detect: () => existsSync(join(homedir(), '.gemini', 'antigravity')),
    mcpFilePath(_scope) { return join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'); },
    skillFilePath(_scope) { return join(homedir(), '.gemini', 'GEMINI.md'); },
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
    mcpFilePath(scope) {
      return scope === 'user'
        ? join(homedir(), '.codex', 'config.toml')
        : join(process.cwd(), '.codex', 'config.toml');
    },
    skillFilePath(scope) {
      return scope === 'user'
        ? join(homedir(), '.codex', 'AGENTS.md')
        : join(process.cwd(), 'AGENTS.md');
    },
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
    isHookConfigured(scope) {
      return isHookFileConfigured(codexHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool codex`);
    },
    async installHook(scope) {
      return installHookFile(codexHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool codex`, patchCodexConfigJson);
    },
    async removeHook(scope) {
      return removeHookFile(codexHookFilePath(scope), `${DEFAULT_STOP_HOOK_COMMAND} --tool codex`, removeCodexHookJson);
    },
  },
];

// ---------------------------------------------------------------------------
// Plan helpers — compute what would change without writing
// ---------------------------------------------------------------------------

/** Compute the content patch that `upsertTomlMcpServer` would append. */
function tomlMcpPatch(filePath: string): string {
  if (hasTomlMcpServer(filePath)) return '(already present)';
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
  return separator + TOML_BLOCK + '\n';
}

/** Compute the content patch that `upsertJsonMcpServer` would append. */
function jsonMcpPatch(filePath: string, rootKey: string): string {
  if (hasJsonMcpServer(filePath, rootKey)) return '(already present)';
  return JSON.stringify({ [rootKey]: { jinn: { command: 'jinn', args: ['mcp'] } } }, null, 2);
}

/** Compute the content patch that `upsertSkillBlock` would append/replace. */
function skillBlockPatch(filePath: string, content: string): string {
  if (hasSkillBlock(filePath)) return `(skill block already present — would update to current SKILL.md content)`;
  return `${BLOCK_START}\n${content}\n${BLOCK_END}\n`;
}

function buildPlanEntries(
  targets: PluginTarget[],
  scope: 'user' | 'project',
  skillContent: string,
  includeMcp: boolean,
  includeSkill: boolean,
): PlanEntry[] {
  const entries: PlanEntry[] = [];
  const strippedSkill = stripFrontmatter(skillContent);

  for (const target of targets) {
    if (!target.detect()) continue;

    if (includeMcp) {
      const fp = target.mcpFilePath?.(scope) ?? null;
      if (fp !== null) {
        // Determine the root key for JSON targets vs. TOML targets
        const isToml = fp.endsWith('.toml');
        let patch: string;
        if (isToml) {
          patch = tomlMcpPatch(fp);
        } else {
          // Determine the root key from the file path
          const rootKey = fp.includes('vscode') ? 'servers' : 'mcpServers';
          patch = jsonMcpPatch(fp, rootKey);
        }
        entries.push({
          target: target.id,
          kind: 'mcp',
          filePath: fp,
          fileExists: existsSync(fp),
          patch,
          alreadyConfigured: target.isMcpConfigured(scope),
        });
      } else {
        // claude-code uses CLI — note it in the plan
        entries.push({
          target: target.id,
          kind: 'mcp',
          filePath: '(managed via `claude mcp add` CLI)',
          fileExists: false,
          patch: target.isMcpConfigured(scope) ? '(already present)' : 'run: claude mcp add --scope ' + scope + ' jinn -- jinn mcp',
          alreadyConfigured: target.isMcpConfigured(scope),
        });
      }
    }

    if (includeSkill) {
      const fp = target.skillFilePath?.(scope) ?? null;
      if (fp !== null) {
        const isMd = fp.endsWith('.md');
        let patch: string;
        if (isMd && target.id !== 'cursor') {
          patch = skillBlockPatch(fp, strippedSkill);
        } else {
          // cursor writes full file; claude-code copies SKILL.md
          if (target.id === 'cursor') {
            patch = existsSync(fp) ? '(would overwrite with current SKILL.md content)' : strippedSkill;
          } else {
            // claude-code: copies SKILL.md into ~/.claude/skills/jinn-operator/SKILL.md
            patch = existsSync(fp) ? '(would update SKILL.md to current version)' : '(would copy SKILL.md)';
          }
        }
        entries.push({
          target: target.id,
          kind: 'skill',
          filePath: fp,
          fileExists: existsSync(fp),
          patch,
          alreadyConfigured: target.isSkillConfigured(scope),
        });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Subverb: install
// ---------------------------------------------------------------------------

interface ResultEntry {
  target: string;
  mcp: { status: string; detail: string };
  skill: { status: string; detail: string };
  hook: { status: string; detail: string };
}

async function runInstall(ctx: CommandContext, rest: string[], forceDryRun = false): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        scope: { type: 'string', default: 'user' },
        target: { type: 'string' },
        json: { type: 'boolean', default: false },
        human: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        'mcp-only': { type: 'boolean', default: false },
        'skill-only': { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn integrations install --scope user',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // Validate mutually exclusive flags
  if (parsed.values['mcp-only'] && parsed.values['skill-only']) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--mcp-only and --skill-only are mutually exclusive',
        exampleCli: 'jinn integrations install --mcp-only',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const scope = (parsed.values.scope as string) === 'project' ? 'project' as const : 'user' as const;
  const targetFilter = parsed.values.target as string | undefined;
  const isDryRun = forceDryRun || Boolean(parsed.values['dry-run']) || (!ctx.stdoutIsTty && !parsed.values.yes);
  const includeMcp = !Boolean(parsed.values['skill-only']);
  const includeSkill = !Boolean(parsed.values['mcp-only']);

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
        exampleCli: 'jinn integrations doctor',
        details: { field: '--target', expected: TARGETS.map((t) => t.id).join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // Dry-run mode emits the installation plan and returns without writing.
  if (isDryRun) {
    const plan = buildPlanEntries(targets, scope, skillContent, includeMcp, includeSkill);
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'integrations install',
        dryRun: true,
        scope,
        plan,
      },
      (v) => {
        const data = v as { plan: PlanEntry[] };
        if (data.plan.length === 0) return 'No targets detected — nothing to install.';
        return data.plan
          .map((e) => {
            const exists = e.fileExists ? 'exists' : 'new';
            const configured = e.alreadyConfigured ? ' [already configured]' : '';
            return `${e.target} (${e.kind})${configured}\n  file: ${e.filePath} [${exists}]\n  patch: ${e.patch.substring(0, 120).replace(/\n/g, '\\n')}${e.patch.length > 120 ? '...' : ''}`;
          })
          .join('\n\n') + '\n\nRe-run with --yes to apply.';
      },
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
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
          hook: { status: 'not_found', detail: `${target.name} not detected` },
        });
      }
      continue;
    }

    let mcpResult: { status: string; detail: string };
    if (!includeMcp) {
      mcpResult = { status: 'skipped', detail: 'Skipped (--skill-only)' };
    } else if (target.isMcpConfigured(scope)) {
      mcpResult = { status: 'skipped', detail: 'Already configured' };
    } else {
      const r = await target.installMcp(scope);
      mcpResult = { status: r.ok ? 'configured' : 'error', detail: r.detail };
    }

    let skillResult: { status: string; detail: string };
    if (!includeSkill) {
      skillResult = { status: 'skipped', detail: 'Skipped (--mcp-only)' };
    } else {
      // Always run installSkill — the helpers handle both fresh installs and
      // updates (replacing existing content), so skill changes propagate when
      // the package is upgraded and `jinn integrations install` is re-run.
      const sr = await target.installSkill(scope, skillContent);
      skillResult = { status: sr.ok ? 'configured' : 'error', detail: sr.detail };
    }

    // §14.1: wire the stop-hook installer in alongside MCP/skill. Not gated
    // by --mcp-only / --skill-only — it's its own concern, always attempted
    // when the target supports it.
    let hookResult: { status: string; detail: string };
    if (!target.installHook) {
      hookResult = { status: 'not_applicable', detail: 'No stop-hook surface for this target' };
    } else if (target.isHookConfigured?.(scope)) {
      hookResult = { status: 'skipped', detail: 'Already configured' };
    } else {
      const hr = await target.installHook(scope);
      hookResult = { status: hr.ok ? 'configured' : 'error', detail: hr.detail };
    }

    results.push({ target: target.id, mcp: mcpResult, skill: skillResult, hook: hookResult });
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'integrations install',
      results,
    },
    (v) => {
      const data = v as { results: ResultEntry[] };
      if (data.results.length === 0) return 'No targets detected.';
      const maxLen = Math.max(...data.results.map((r) => r.target.length));
      return data.results
        .map((r) => `${r.target.padEnd(maxLen + 2)}MCP: ${r.mcp.status.padEnd(12)}Skill: ${r.skill.status.padEnd(12)}Hook: ${r.hook.status}`)
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
        exampleCli: 'jinn integrations remove --target claude-code',
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
        exampleCli: 'jinn integrations doctor',
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
          hook: { status: 'not_found', detail: `${target.name} not detected` },
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

    let hookResult: { status: string; detail: string };
    if (!target.removeHook) {
      hookResult = { status: 'not_applicable', detail: 'No stop-hook surface for this target' };
    } else if (!target.isHookConfigured?.(scope)) {
      hookResult = { status: 'skipped', detail: 'Not configured' };
    } else {
      const r = await target.removeHook(scope);
      hookResult = { status: r.ok ? 'removed' : 'error', detail: r.detail };
    }

    results.push({ target: target.id, mcp: mcpResult, skill: skillResult, hook: hookResult });
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'integrations remove',
      results,
    },
    (v) => {
      const data = v as { results: ResultEntry[] };
      if (data.results.length === 0) return 'No targets detected.';
      const maxLen = Math.max(...data.results.map((r) => r.target.length));
      return data.results
        .map((r) => `${r.target.padEnd(maxLen + 2)}MCP: ${r.mcp.status.padEnd(12)}Skill: ${r.skill.status.padEnd(12)}Hook: ${r.hook.status}`)
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
        exampleCli: 'jinn integrations doctor',
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
      verb: 'integrations doctor',
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
        message: 'jinn integrations requires a subverb: install, remove, doctor',
        exampleCli: 'jinn integrations install',
        details: { field: 'subverb', expected: 'install|remove|doctor' },
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
    case 'doctor':
      return runList(ctx, rest);
    default:
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown integrations subverb: ${subverb}`,
          exampleCli: 'jinn integrations install',
          details: { field: 'subverb', expected: 'install|remove|doctor' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
  }
}

const command: CommandModule = {
  name: 'integrations',
  summary: 'Configure host AI tool integrations for Jinn',
  helpText: `Usage: jinn integrations <install|remove|doctor> [options]

Subcommands:
  install   Configure detected AI tools with Jinn MCP server and operator skill
  remove    Remove Jinn configuration from AI tools
  doctor    Show detected AI tools and their configuration status

Options:
  --scope <user|project>   Install scope (default: user)
  --target <id>            Configure only this target
  --dry-run                Show plan without writing files
  --yes                    Apply writes in non-interactive (non-TTY) mode
  --mcp-only               Only configure MCP server (skip skill/instruction files)
  --skill-only             Only configure skill/instruction files (skip MCP server)
  --json                   JSON output (default)
  --human                  Human-readable output

Safety: in non-TTY (agent/script) contexts, 'install' defaults to --dry-run.
Pass --yes to apply writes. Interactive TTY sessions prompt before writing.

Supported targets:
  claude-code      Claude Code CLI
  claude-desktop   Claude Desktop app
  cursor           Cursor editor
  vscode           VS Code (Copilot)
  gemini-cli       Gemini CLI
  antigravity      Antigravity (Gemini)
  codex            OpenAI Codex CLI

Examples:
  jinn integrations doctor --human
  jinn integrations install --dry-run --human
  jinn integrations install --yes --human
  jinn integrations install --yes --target claude-code --human
  jinn integrations install --yes --scope project --target cursor
  jinn integrations install --yes --mcp-only
  jinn integrations install --yes --skill-only --target codex
  jinn integrations remove --target claude-code
`,
  run,
};

export default command;
