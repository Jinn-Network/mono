import { describe, expect, it } from 'vitest';
import {
  assertCursorRuntimeFiles,
  assertCursorRuntimeReady,
  cursorAgentArgs,
  cursorModelForEffort,
} from '../../src/dispatcher/cursor-runtime.js';

describe('cursorModelForEffort', () => {
  it.each([
    ['Low', 'composer-2.5'],
    ['Medium', 'cursor-grok-4.5-medium'],
    ['High', 'cursor-grok-4.5-high'],
    ['XHigh', 'cursor-grok-4.5-high'],
    ['Max', 'cursor-grok-4.5-high'],
  ] as const)('maps %s to %s', (effort, model) => {
    expect(cursorModelForEffort(effort)).toBe(model);
  });

  it('maps unset Effort to Grok high (same as XHigh)', () => {
    expect(cursorModelForEffort(null)).toBe('cursor-grok-4.5-high');
  });
});

describe('cursorAgentArgs', () => {
  it('builds a headless agent invocation with workspace and model', () => {
    expect(cursorAgentArgs('PROMPT', {
      model: 'composer-2.5',
      workspace: '/tmp/worktree',
    })).toEqual([
      '-p',
      '--force',
      '--trust',
      '--sandbox', 'disabled',
      '--approve-mcps',
      '--workspace', '/tmp/worktree',
      '--model', 'composer-2.5',
      '--output-format', 'text',
      'PROMPT',
    ]);
  });
});

describe('assertCursorRuntimeFiles', () => {
  it('fails loudly when an absolute binary path is missing', () => {
    expect(() => assertCursorRuntimeFiles('/missing/agent', () => false))
      .toThrow(/Cursor Agent CLI is missing/);
  });

  it('does not require exists() for a PATH-resolved command name', () => {
    expect(() => assertCursorRuntimeFiles('agent', () => false))
      .not.toThrow();
  });
});

describe('assertCursorRuntimeReady', () => {
  it('probes agent status', () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    assertCursorRuntimeReady('agent', {
      probe: (command, args) => {
        calls.push({ command, args: [...args] });
        return { status: 0, stderr: '' };
      },
    });

    expect(calls).toEqual([{ command: 'agent', args: ['status'] }]);
  });

  it('fails when status probe is nonzero', () => {
    expect(() => assertCursorRuntimeReady('/opt/agent', {
      exists: () => true,
      probe: () => ({
        status: 1,
        stderr: 'not logged in',
      }),
    })).toThrow(/not logged in.*agent login/i);
  });

  it('fails when probe cannot start', () => {
    expect(() => assertCursorRuntimeReady('/broken/agent', {
      exists: () => true,
      probe: () => ({
        status: null,
        stderr: '',
        error: new Error('spawn ENOENT'),
      }),
    })).toThrow(/spawn ENOENT.*agent login/i);
  });
});
