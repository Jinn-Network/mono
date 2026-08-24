/**
 * §14.1 — `jinn integrations install/remove` wires the (previously
 * dead-code) stop-hook patcher into a real installer surface.
 *
 * Scope: claude-code ONLY. codex/cursor/gemini-cli hook file formats are
 * NOT independently verified against those tools' real hook schemas (the
 * claude-code shape was confirmed against Claude Code's documented
 * Stop-hook example — a real, wrong-schema bug was caught here in review).
 * Their pure patch/remove functions stay in `src/cli/hook-installers/` with
 * coverage in `test/scripts/install-hooks.test.ts`, but are not wired into
 * `integrations.ts` — see the follow-up issue for verifying and wiring them.
 *
 * `TARGETS`' `detect()` depends on the host machine (is `claude` on PATH)
 * so it isn't exercised here — CI runners won't have it. Instead this tests
 * the exported file-path resolver + the generic install/remove-file
 * helpers directly: the exact functions claude-code's `PluginTarget.installHook`
 * / `removeHook` delegate to, deterministic regardless of what's on the host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeCodeHookFilePath,
  installHookFile,
  removeHookFile,
  isHookFileConfigured,
  buildPlanEntries,
  type PluginTarget,
} from '../../../src/cli/commands/integrations.js';
import { patchClaudeCodeSettingsJson, removeClaudeCodeHookJson } from '../../../src/cli/hook-installers/claude-code.js';
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

describe('stop-hook installer wiring (project scope) — claude-code', () => {
  it('writes the Claude Code stop-hook entry (real nested schema), and is idempotent', async () => {
    const filePath = claudeCodeHookFilePath('project');
    const command = `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`;
    expect(isHookFileConfigured(filePath, command)).toBe(false);

    const first = await installHookFile(filePath, command, patchClaudeCodeSettingsJson);
    expect(first.ok).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('jinn-stop-hook --tool claude-code');
    expect(isHookFileConfigured(filePath, command)).toBe(true);

    const parsedOnce = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> };
    };
    // The real schema: a hook GROUP with a nested `hooks` array — not a
    // bare {command} object, which Claude Code silently ignores.
    expect(parsedOnce.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'jinn-stop-hook --tool claude-code' }] },
    ]);

    const second = await installHookFile(filePath, command, patchClaudeCodeSettingsJson);
    expect(second.detail).toMatch(/already configured/i);
    const parsedTwice = JSON.parse(readFileSync(filePath, 'utf-8')) as { hooks: { Stop: unknown[] } };
    expect(parsedTwice.hooks.Stop).toHaveLength(1);
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

  it('preserves an existing hook group untouched (e.g. a PostToolUse formatter) when installing Stop', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const filePath = claudeCodeHookFilePath('project');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Write(*.py)', hooks: [{ type: 'command', command: 'ruff check --fix $CLAUDE_FILE_PATHS' }] }],
      },
    }), 'utf-8');

    await installHookFile(filePath, `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`, patchClaudeCodeSettingsJson);

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      hooks: { PostToolUse: unknown[]; Stop: unknown[] };
    };
    expect(parsed.hooks.PostToolUse).toEqual([
      { matcher: 'Write(*.py)', hooks: [{ type: 'command', command: 'ruff check --fix $CLAUDE_FILE_PATHS' }] },
    ]);
    expect(parsed.hooks.Stop).toHaveLength(1);
  });
});

// F4: --dry-run must preview the hook write — it's the consent surface for
// writing into the operator's real ~/.claude/settings.json, same as MCP/skill.
describe('buildPlanEntries — hook axis (F4)', () => {
  function fakeClaudeCodeTarget(): PluginTarget {
    return {
      id: 'claude-code',
      name: 'Claude Code',
      detect: () => true,
      isMcpConfigured: () => true,
      isSkillConfigured: () => true,
      mcpFilePath: () => null,
      skillFilePath: () => null,
      installMcp: async () => ({ ok: true, detail: '' }),
      installSkill: async () => ({ ok: true, detail: '' }),
      removeMcp: async () => ({ ok: true, detail: '' }),
      removeSkill: async () => ({ ok: true, detail: '' }),
      hookFilePath: (scope) => claudeCodeHookFilePath(scope),
      isHookConfigured: (scope) => isHookFileConfigured(
        claudeCodeHookFilePath(scope),
        `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`,
      ),
    };
  }

  it('includes a kind:"hook" plan entry pointing at the real settings file when not yet configured', () => {
    const filePath = claudeCodeHookFilePath('project');
    const entries = buildPlanEntries([fakeClaudeCodeTarget()], 'project', '', false, false);

    const hookEntry = entries.find((e) => e.kind === 'hook');
    expect(hookEntry).toBeDefined();
    expect(hookEntry?.filePath).toBe(filePath);
    expect(hookEntry?.alreadyConfigured).toBe(false);
    expect(hookEntry?.patch).toContain('jinn-stop-hook --tool claude-code');
  });

  it('marks the plan entry alreadyConfigured once the hook is installed', async () => {
    const filePath = claudeCodeHookFilePath('project');
    await installHookFile(filePath, `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`, patchClaudeCodeSettingsJson);

    const entries = buildPlanEntries([fakeClaudeCodeTarget()], 'project', '', false, false);
    const hookEntry = entries.find((e) => e.kind === 'hook');
    expect(hookEntry?.alreadyConfigured).toBe(true);
    expect(hookEntry?.patch).toBe('(already present)');
  });
});

// F5: a hand-edited settings file with e.g. a trailing comma must produce an
// {ok:false} result, not throw a stack trace mid-loop after other targets
// have already been written.
describe('installHookFile / removeHookFile — malformed JSON (F5)', () => {
  it('returns {ok:false} instead of throwing when the settings file has a trailing comma', async () => {
    const filePath = claudeCodeHookFilePath('project');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{"hooks": {"Stop": [],},}', 'utf-8');

    const result = await installHookFile(filePath, `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`, patchClaudeCodeSettingsJson);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/failed to parse/i);
  });

  it('returns {ok:false} instead of throwing on removeHookFile with malformed JSON', async () => {
    const filePath = claudeCodeHookFilePath('project');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(filePath), { recursive: true });
    // Contains the command string (so isHookFileConfigured is true) but is invalid JSON.
    writeFileSync(filePath, '{"hooks": {"Stop": [{"hooks":[{"command":"jinn-stop-hook --tool claude-code"}]}],},}', 'utf-8');

    const result = await removeHookFile(filePath, `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`, removeClaudeCodeHookJson);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/failed to parse/i);
  });
});
