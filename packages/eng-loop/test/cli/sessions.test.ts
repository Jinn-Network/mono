import { describe, it, expect } from 'vitest';
import {
  encodeWorktreePathToProjectDir,
  parseIssueNumberFromWorktree,
} from '../../src/cli/sessions.js';

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
