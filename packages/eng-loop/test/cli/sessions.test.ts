import { describe, it, expect } from 'vitest';
import { encodeWorktreePathToProjectDir } from '../../src/cli/sessions.js';

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
