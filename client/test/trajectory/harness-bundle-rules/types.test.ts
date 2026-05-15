import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerRule,
  getRule,
  clearRegistry,
  type SnapshotRule,
} from '../../../src/trajectory/harness-bundle-rules/types.js';

describe('SnapshotRule registry', () => {
  beforeEach(() => clearRegistry());

  it('registers and looks up a rule by tool', async () => {
    const rule: SnapshotRule = {
      tool: 'claude-code',
      candidatePaths: async () => ['/Users/anon/.claude/CLAUDE.md'],
    };
    registerRule(rule);
    const found = getRule('claude-code');
    expect(found).toBe(rule);
    expect(found.tool).toBe('claude-code');
    expect(await found.candidatePaths({ home: '/Users/anon' })).toEqual(['/Users/anon/.claude/CLAUDE.md']);
  });

  it('throws when looking up an unregistered tool', () => {
    expect(() => getRule('codex')).toThrow(/no snapshot rule registered/i);
  });

  it('replaces an existing registration when registerRule called twice', () => {
    const a: SnapshotRule = {
      tool: 'aider',
      candidatePaths: async () => ['/old'],
    };
    const b: SnapshotRule = {
      tool: 'aider',
      candidatePaths: async () => ['/new'],
    };
    registerRule(a);
    registerRule(b);
    expect(getRule('aider')).toBe(b);
  });

  it('clearRegistry empties the registry', () => {
    registerRule({ tool: 'continue', candidatePaths: async () => [] });
    clearRegistry();
    expect(() => getRule('continue')).toThrow();
  });

  it('SnapshotRule.candidatePaths receives home + repoRoot input', async () => {
    let captured: { home: string; repoRoot?: string } | null = null;
    const rule: SnapshotRule = {
      tool: 'cursor',
      candidatePaths: async (input) => {
        captured = input;
        return [];
      },
    };
    registerRule(rule);
    await getRule('cursor').candidatePaths({ home: '/Users/anon', repoRoot: '/Users/anon/repo' });
    expect(captured).toEqual({ home: '/Users/anon', repoRoot: '/Users/anon/repo' });
  });
});
