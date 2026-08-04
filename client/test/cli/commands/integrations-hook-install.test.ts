/**
 * §14.1 — `jinn integrations install/remove` now wires the (previously
 * dead-code) stop-hook patchers into a real installer surface.
 *
 * `TARGETS`' `detect()` depends on the host machine (is `claude` on PATH,
 * does `~/.cursor` exist, ...) so it isn't exercised here — CI runners won't
 * have any of these tools installed. Instead this tests the exported
 * file-path resolvers + the generic install/remove-file helpers directly:
 * the exact functions each `PluginTarget`'s `installHook`/`removeHook`
 * delegate to, deterministic regardless of what's on the host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeCodeHookFilePath,
  codexHookFilePath,
  cursorHookFilePath,
  geminiCliHookFilePath,
  installHookFile,
  removeHookFile,
  isHookFileConfigured,
} from '../../../src/cli/commands/integrations.js';
import { patchClaudeCodeSettingsJson, removeClaudeCodeHookJson } from '../../../src/cli/hook-installers/claude-code.js';
import { patchCodexConfigJson, removeCodexHookJson } from '../../../src/cli/hook-installers/codex.js';
import { patchCursorHooksJson, removeCursorHookJson } from '../../../src/cli/hook-installers/cursor.js';
import { patchGeminiCliSettingsJson, removeGeminiCliHookJson } from '../../../src/cli/hook-installers/gemini-cli.js';
import { DEFAULT_STOP_HOOK_COMMAND } from '../../../src/cli/hook-installers/common.js';

let projectDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'jinn-integrations-hook-'));
  process.chdir(projectDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

describe('stop-hook installer wiring (project scope)', () => {
  it('writes the Claude Code stop-hook entry, and is idempotent', async () => {
    const filePath = claudeCodeHookFilePath('project');
    const command = `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`;
    expect(isHookFileConfigured(filePath, command)).toBe(false);

    const first = await installHookFile(filePath, command, patchClaudeCodeSettingsJson);
    expect(first.ok).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('jinn-stop-hook --tool claude-code');
    expect(isHookFileConfigured(filePath, command)).toBe(true);

    const second = await installHookFile(filePath, command, patchClaudeCodeSettingsJson);
    expect(second.detail).toMatch(/already configured/i);
    const parsedOnce = JSON.parse(readFileSync(filePath, 'utf-8')) as { hooks: { Stop: unknown[] } };
    expect(parsedOnce.hooks.Stop).toHaveLength(1);
  });

  it('removes the Claude Code stop-hook entry', async () => {
    const filePath = claudeCodeHookFilePath('project');
    const command = `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`;
    await installHookFile(filePath, command, patchClaudeCodeSettingsJson);
    expect(isHookFileConfigured(filePath, command)).toBe(true);

    const removed = await removeHookFile(filePath, command, removeClaudeCodeHookJson);
    expect(removed.ok).toBe(true);
    expect(isHookFileConfigured(filePath, command)).toBe(false);
  });

  it('writes the Codex stop-hook entry to a dedicated hooks.json', async () => {
    const filePath = codexHookFilePath('project');
    const command = `${DEFAULT_STOP_HOOK_COMMAND} --tool codex`;
    const result = await installHookFile(filePath, command, patchCodexConfigJson);
    expect(result.ok).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('jinn-stop-hook --tool codex');

    const removed = await removeHookFile(filePath, command, removeCodexHookJson);
    expect(removed.ok).toBe(true);
    expect(isHookFileConfigured(filePath, command)).toBe(false);
  });

  it('writes the Cursor stop-hook entry to a dedicated hooks.json', async () => {
    const filePath = cursorHookFilePath('project');
    const command = `${DEFAULT_STOP_HOOK_COMMAND} --tool cursor`;
    const result = await installHookFile(filePath, command, patchCursorHooksJson);
    expect(result.ok).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('jinn-stop-hook --tool cursor');

    const removed = await removeHookFile(filePath, command, removeCursorHookJson);
    expect(removed.ok).toBe(true);
    expect(isHookFileConfigured(filePath, command)).toBe(false);
  });

  it('writes the Gemini CLI stop-hook entry into settings.json alongside mcpServers', async () => {
    const filePath = geminiCliHookFilePath('project');
    const command = `${DEFAULT_STOP_HOOK_COMMAND} --tool gemini-cli`;
    // Simulate an MCP entry already present — the hook patch must preserve it.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ mcpServers: { jinn: { command: 'jinn', args: ['mcp'] } } }), 'utf-8');

    const result = await installHookFile(filePath, command, patchGeminiCliSettingsJson);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      mcpServers: { jinn: unknown };
      hooks: { SessionEnd: string[] };
    };
    expect(parsed.mcpServers.jinn).toBeDefined();
    expect(parsed.hooks.SessionEnd).toContain('jinn-stop-hook --tool gemini-cli');
  });
});
