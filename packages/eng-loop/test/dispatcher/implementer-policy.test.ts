import { describe, it, expect } from 'vitest';
import { resolveImplementer } from '../../src/dispatcher/implementer-policy.js';
import type { ReadyIssue, DispatcherConfig } from '../../src/dispatcher/types.js';

type Issue = Pick<ReadyIssue, 'shape' | 'effort'>;
type Cfg = Pick<DispatcherConfig, 'implementerRules' | 'defaultImplementer'>;

describe('resolveImplementer', () => {
  it('empty rules → defaultImplementer', () => {
    const issue: Issue = { shape: 'feat', effort: 'High' };
    const cfg: Cfg = { implementerRules: [], defaultImplementer: 'claude' };
    expect(resolveImplementer(issue, cfg)).toBe('claude');
  });

  it('effort-only rule matches regardless of shape', () => {
    const cfg: Cfg = {
      implementerRules: [{ effort: 'High', implementer: 'codex' }],
      defaultImplementer: 'claude',
    };
    expect(resolveImplementer({ shape: 'feat', effort: 'High' }, cfg)).toBe('codex');
    expect(resolveImplementer({ shape: 'fix', effort: 'High' }, cfg)).toBe('codex');
  });

  it('effort-only rule falls through on effort mismatch', () => {
    const cfg: Cfg = {
      implementerRules: [{ effort: 'High', implementer: 'codex' }],
      defaultImplementer: 'claude',
    };
    expect(resolveImplementer({ shape: 'feat', effort: 'Low' }, cfg)).toBe('claude');
  });

  it('shape-only rule matches regardless of effort', () => {
    const cfg: Cfg = {
      implementerRules: [{ shape: 'docs', implementer: 'cursor' }],
      defaultImplementer: 'claude',
    };
    expect(resolveImplementer({ shape: 'docs', effort: 'Low' }, cfg)).toBe('cursor');
    expect(resolveImplementer({ shape: 'feat', effort: 'Low' }, cfg)).toBe('claude');
  });

  it('combined rule needs both predicates', () => {
    const cfg: Cfg = {
      implementerRules: [{ shape: 'feat', effort: 'High', implementer: 'codex' }],
      defaultImplementer: 'claude',
    };
    expect(resolveImplementer({ shape: 'feat', effort: 'High' }, cfg)).toBe('codex');
    // only shape holds
    expect(resolveImplementer({ shape: 'feat', effort: 'Low' }, cfg)).toBe('claude');
    // only effort holds
    expect(resolveImplementer({ shape: 'fix', effort: 'High' }, cfg)).toBe('claude');
  });

  it('first-match-wins over the ordered list', () => {
    const cfg: Cfg = {
      implementerRules: [
        { effort: 'High', implementer: 'codex' },
        { shape: 'feat', implementer: 'cursor' },
      ],
      defaultImplementer: 'claude',
    };
    // both rules would match; first wins
    expect(resolveImplementer({ shape: 'feat', effort: 'High' }, cfg)).toBe('codex');
  });

  it('no-match falls through to defaultImplementer', () => {
    const cfg: Cfg = {
      implementerRules: [{ shape: 'docs', effort: 'Low', implementer: 'codex' }],
      defaultImplementer: 'cursor',
    };
    expect(resolveImplementer({ shape: 'feat', effort: 'High' }, cfg)).toBe('cursor');
  });

  it('a rule with neither effort nor shape is a catch-all', () => {
    const cfg: Cfg = {
      implementerRules: [{ implementer: 'codex' }],
      defaultImplementer: 'claude',
    };
    expect(resolveImplementer({ shape: 'feat', effort: 'High' }, cfg)).toBe('codex');
    expect(resolveImplementer({ shape: 'docs', effort: 'Low' }, cfg)).toBe('codex');
  });
});
