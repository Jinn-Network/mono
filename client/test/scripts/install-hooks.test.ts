import { describe, expect, it } from 'vitest';
import { patchClaudeCodeSettingsJson, removeClaudeCodeHookJson } from '../../src/cli/hook-installers/claude-code.js';
import { patchCodexConfigJson, removeCodexHookJson } from '../../src/cli/hook-installers/codex.js';
import { patchGeminiCliSettingsJson, removeGeminiCliHookJson } from '../../src/cli/hook-installers/gemini-cli.js';
import { patchCursorHooksJson, removeCursorHookJson } from '../../src/cli/hook-installers/cursor.js';

describe('stop-hook installers', () => {
  it('patches Claude Code settings idempotently without removing existing hooks', () => {
    const raw = JSON.stringify({
      hooks: { Stop: [{ command: 'operator-existing' }] },
      theme: 'dark',
    });
    const once = patchClaudeCodeSettingsJson(raw);
    const twice = patchClaudeCodeSettingsJson(once);
    const parsed = JSON.parse(twice) as { hooks: { Stop: Array<{ command: string }> }; theme: string };

    expect(parsed.theme).toBe('dark');
    expect(parsed.hooks.Stop.map((h) => h.command)).toEqual([
      'operator-existing',
      'jinn-stop-hook --tool claude-code',
    ]);
  });

  it('patches Codex stop hooks idempotently', () => {
    const parsed = JSON.parse(patchCodexConfigJson(patchCodexConfigJson('{"hooks":{"stop":["old"]}}'))) as {
      hooks: { stop: string[] };
    };
    expect(parsed.hooks.stop).toEqual(['old', 'jinn-stop-hook --tool codex']);
  });

  it('patches Gemini SessionEnd hooks idempotently', () => {
    const parsed = JSON.parse(patchGeminiCliSettingsJson(patchGeminiCliSettingsJson('{}'))) as {
      hooks: { SessionEnd: string[] };
    };
    expect(parsed.hooks.SessionEnd).toEqual(['jinn-stop-hook --tool gemini-cli']);
  });

  it('patches Cursor sessionEnd hooks idempotently', () => {
    const parsed = JSON.parse(patchCursorHooksJson(patchCursorHooksJson('{"sessionEnd":[{"command":"old"}]}'))) as {
      sessionEnd: Array<{ command: string }>;
    };
    expect(parsed.sessionEnd.map((entry) => entry.command)).toEqual([
      'old',
      'jinn-stop-hook --tool cursor',
    ]);
  });

  it('removes the Claude Code stop-hook entry without touching other hooks', () => {
    const withHook = patchClaudeCodeSettingsJson(JSON.stringify({ hooks: { Stop: [{ command: 'operator-existing' }] } }));
    const removed = JSON.parse(removeClaudeCodeHookJson(withHook)) as { hooks: { Stop: Array<{ command: string }> } };
    expect(removed.hooks.Stop.map((h) => h.command)).toEqual(['operator-existing']);
  });

  it('removes the Codex stop-hook entry idempotently', () => {
    const withHook = patchCodexConfigJson('{"hooks":{"stop":["old"]}}');
    const removed = JSON.parse(removeCodexHookJson(removeCodexHookJson(withHook))) as { hooks: { stop: string[] } };
    expect(removed.hooks.stop).toEqual(['old']);
  });

  it('removes the Gemini SessionEnd hook entry idempotently', () => {
    const withHook = patchGeminiCliSettingsJson('{}');
    const removed = JSON.parse(removeGeminiCliHookJson(removeGeminiCliHookJson(withHook))) as { hooks: { SessionEnd: string[] } };
    expect(removed.hooks.SessionEnd).toEqual([]);
  });

  it('removes the Cursor sessionEnd hook entry idempotently', () => {
    const withHook = patchCursorHooksJson('{"sessionEnd":[{"command":"old"}]}');
    const removed = JSON.parse(removeCursorHookJson(removeCursorHookJson(withHook))) as {
      sessionEnd: Array<{ command: string }>;
    };
    expect(removed.sessionEnd.map((entry) => entry.command)).toEqual(['old']);
  });
});
