import { describe, expect, it } from 'vitest';
import { patchClaudeCodeSettingsJson } from '../../scripts/install-hooks/claude-code.js';
import { patchCodexConfigJson } from '../../scripts/install-hooks/codex.js';
import { patchGeminiCliSettingsJson } from '../../scripts/install-hooks/gemini-cli.js';
import { patchCursorHooksJson } from '../../scripts/install-hooks/cursor.js';

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
});
