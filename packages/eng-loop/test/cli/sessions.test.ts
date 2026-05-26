import { describe, it, expect } from 'vitest';
import {
  encodeWorktreePathToProjectDir,
  lastAssistantText,
  lastTimestamp,
  parseIssueNumberFromWorktree,
  parseJsonlLines,
  prLinkRecord,
  truncate,
} from '../../src/cli/sessions.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIX_WITH_TEXT = [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-26T00:00:00.000Z' }),
  JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:01.000Z', message: { content: [{ type: 'text', text: 'hi' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:01:00.000Z', message: { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'first summary' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:02:00.000Z', message: { content: [{ type: 'text', text: 'latest summary' }] } }),
  '',
].join('\n');

const FIX_TOOL_USE_ONLY = [
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
  '',
].join('\n');

const FIX_WITH_PR_LINK = [
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:01:00.000Z', message: { content: [{ type: 'text', text: 'opened PR' }] } }),
  JSON.stringify({ type: 'pr-link', timestamp: '2026-05-26T00:02:00.000Z', prNumber: 612, prUrl: 'https://github.com/Jinn-Network/mono/pull/612' }),
  '',
].join('\n');

const FIX_BLANK_AND_GARBAGE = [
  '',
  'not json at all',
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:00.000Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
  '',
].join('\n');

describe('encodeWorktreePathToProjectDir', () => {
  it('encodes the live worktree path from this machine', () => {
    expect(
      encodeWorktreePathToProjectDir(
        "/Users/adrianobradley/life's-work/jinn-mono_worktrees/587",
      ),
    ).toBe('-Users-adrianobradley-life-s-work-jinn-mono-worktrees-587');
  });

  it('encodes a short absolute path', () => {
    expect(encodeWorktreePathToProjectDir('/tmp/foo')).toBe('-tmp-foo');
  });

  it('collapses apostrophe + underscore runs to a single dash', () => {
    expect(encodeWorktreePathToProjectDir("/Users/a/b'c_d/e")).toBe('-Users-a-b-c-d-e');
  });

  it('trims a trailing dash from a trailing-slash path', () => {
    expect(encodeWorktreePathToProjectDir('/Users/a/')).toBe('-Users-a');
  });
});

describe('parseIssueNumberFromWorktree', () => {
  it('returns the numeric leaf when worktreePath is a direct child of base', () => {
    expect(parseIssueNumberFromWorktree('/wt/587', '/wt')).toBe(587);
  });

  it('returns null when worktreePath is not under base', () => {
    expect(parseIssueNumberFromWorktree('/other/587', '/wt')).toBeNull();
  });

  it('returns null when the leaf is non-numeric', () => {
    expect(parseIssueNumberFromWorktree('/wt/feature-branch', '/wt')).toBeNull();
  });

  it('returns null for nested children (only direct children count)', () => {
    expect(parseIssueNumberFromWorktree('/wt/587/sub', '/wt')).toBeNull();
  });

  it('handles a trailing slash on base', () => {
    expect(parseIssueNumberFromWorktree('/wt/587', '/wt/')).toBe(587);
  });
});

describe('parseJsonlLines', () => {
  it('skips blank lines and non-JSON lines', () => {
    const records = parseJsonlLines(FIX_BLANK_AND_GARBAGE);
    expect(records).toHaveLength(1);
  });
});

describe('lastTimestamp', () => {
  it('returns the max ISO-8601 timestamp across records', () => {
    const records = parseJsonlLines(FIX_WITH_TEXT);
    expect(lastTimestamp(records)).toBe(Date.parse('2026-05-26T00:02:00.000Z'));
  });

  it('returns a finite number even when some lines are garbage', () => {
    const records = parseJsonlLines(FIX_BLANK_AND_GARBAGE);
    const ts = lastTimestamp(records);
    expect(ts).not.toBeNull();
    expect(Number.isFinite(ts)).toBe(true);
  });
});

describe('lastAssistantText', () => {
  it('returns the most recent text block from assistant records', () => {
    const records = parseJsonlLines(FIX_WITH_TEXT);
    expect(lastAssistantText(records)).toBe('latest summary');
  });

  it('returns null when the only assistant blocks are tool_use', () => {
    const records = parseJsonlLines(FIX_TOOL_USE_ONLY);
    expect(lastAssistantText(records)).toBeNull();
  });
});

describe('prLinkRecord', () => {
  it('returns the pr-link payload when present', () => {
    const records = parseJsonlLines(FIX_WITH_PR_LINK);
    expect(prLinkRecord(records)).toEqual({
      prNumber: 612,
      prUrl: 'https://github.com/Jinn-Network/mono/pull/612',
    });
  });

  it('returns null when no pr-link record is present', () => {
    const records = parseJsonlLines(FIX_WITH_TEXT);
    expect(prLinkRecord(records)).toBeNull();
  });
});

describe('truncate', () => {
  it('returns the input unchanged when shorter than the cap', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('truncates and appends ellipsis when longer than the cap', () => {
    const out = truncate('hello world', 5);
    expect(out).toBe('he...');
    expect(out).toHaveLength(5);
  });

  it('returns the input unchanged at exact cap', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('returns only the ellipsis when the cap is shorter than the input + ellipsis', () => {
    expect(truncate('abcd', 3)).toBe('...');
  });
});
