import { describe, expect, it } from 'vitest';
import { patchClaudeCodeSettingsJson, removeClaudeCodeHookJson } from '../../src/cli/hook-installers/claude-code.js';

// Claude Code's real hook schema — confirmed against the documented
// Stop-hook example: `Stop` is an array of hook GROUPS (each with a
// `hooks: [{type, command}]` array), not a flat array of `{command}`
// objects. A flat `{command}` entry never fires.
interface ClaudeCodeHookGroup { matcher?: string; hooks: Array<{ type: string; command: string }> }
interface ClaudeCodeSettings { hooks: { Stop: ClaudeCodeHookGroup[] }; theme?: string }

function allStopCommands(settings: ClaudeCodeSettings): string[] {
  return settings.hooks.Stop.flatMap((group) => group.hooks.map((h) => h.command));
}

describe('stop-hook installers', () => {
  it('patches Claude Code settings (real nested schema) idempotently without removing an existing hook group', () => {
    const raw = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'operator-existing' }] }],
      },
      theme: 'dark',
    });
    const once = patchClaudeCodeSettingsJson(raw);
    const twice = patchClaudeCodeSettingsJson(once);
    const parsed = JSON.parse(twice) as ClaudeCodeSettings;

    expect(parsed.theme).toBe('dark');
    expect(allStopCommands(parsed)).toEqual([
      'operator-existing',
      'jinn-stop-hook --tool claude-code',
    ]);
    // The new entry is a well-formed group — {type:"command", command} —
    // not a bare {command} object, which Claude Code silently ignores.
    expect(parsed.hooks.Stop[1]).toEqual({ hooks: [{ type: 'command', command: 'jinn-stop-hook --tool claude-code' }] });
  });

  it('patches Claude Code settings from scratch (no existing hooks key)', () => {
    const parsed = JSON.parse(patchClaudeCodeSettingsJson('{}')) as ClaudeCodeSettings;
    expect(parsed.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'jinn-stop-hook --tool claude-code' }] },
    ]);
  });

  it('removes the Claude Code stop-hook entry without touching an existing hook group', () => {
    const withHook = patchClaudeCodeSettingsJson(JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'operator-existing' }] }] },
    }));
    const removed = JSON.parse(removeClaudeCodeHookJson(withHook)) as ClaudeCodeSettings;
    expect(allStopCommands(removed)).toEqual(['operator-existing']);
  });

  it('removes the Claude Code stop-hook entry cleanly when it was the only entry in its group', () => {
    const withHook = patchClaudeCodeSettingsJson('{}');
    const removed = JSON.parse(removeClaudeCodeHookJson(withHook)) as ClaudeCodeSettings;
    expect(removed.hooks.Stop).toEqual([]);
  });
});
