import { describe, it, expect, vi } from 'vitest';
import { parseOwnedPrefixes, touchesCodeOwnedPath } from '../../src/dispatcher/code-owned.js';

const CODEOWNERS = `
# Load-bearing human surfaces (DR-2026-06-03)
/SPEC.md       @oaksprout @ritsukai
/client/src/dashboard/spa/src/pages/      @oaksprout @ritsukai
/client/src/dashboard/spa/src/App.tsx     @oaksprout @ritsukai
`;

describe('parseOwnedPrefixes', () => {
  it('keeps the path token, strips leading/trailing slashes, ignores comments + blanks', () => {
    const owned = parseOwnedPrefixes(CODEOWNERS);
    expect(owned.prefixes).toEqual([
      'SPEC.md',
      'client/src/dashboard/spa/src/pages',
      'client/src/dashboard/spa/src/App.tsx',
    ]);
    expect(owned.hasUnsupportedPattern).toBe(false);
  });

  it('flags a glob pattern as unsupported (cannot be represented precisely)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const owned = parseOwnedPrefixes('/SPEC.md @o\n*.md @o\n/docs/ @o\n');
    expect(owned.hasUnsupportedPattern).toBe(true);
    // The non-glob rules are still parsed precisely.
    expect(owned.prefixes).toEqual(['SPEC.md', 'docs']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('flags a bare "/" (owns everything) as unsupported', () => {
    const owned = parseOwnedPrefixes('/ @o\n');
    expect(owned.hasUnsupportedPattern).toBe(true);
    expect(owned.prefixes).toEqual([]);
  });
});

describe('touchesCodeOwnedPath', () => {
  const owned = parseOwnedPrefixes(CODEOWNERS);

  it('matches an exact owned file', () => {
    expect(touchesCodeOwnedPath(['SPEC.md'], owned)).toBe(true);
  });

  it('matches a file under an owned directory', () => {
    expect(touchesCodeOwnedPath(['client/src/dashboard/spa/src/pages/Tasks.tsx'], owned)).toBe(true);
  });

  it('does not match a sibling that only shares a prefix substring (boundary)', () => {
    expect(touchesCodeOwnedPath(['SPEC.md.bak'], owned)).toBe(false);
    expect(touchesCodeOwnedPath(['client/src/dashboard/spa/src/pages-legacy/X.tsx'], owned)).toBe(false);
  });

  it('returns false when no changed file is owned', () => {
    expect(touchesCodeOwnedPath(['packages/autopilot/src/dispatcher/loop.ts'], owned)).toBe(false);
  });

  it('returns true if ANY changed file is owned (mixed changeset)', () => {
    expect(touchesCodeOwnedPath(['packages/autopilot/src/x.ts', 'SPEC.md'], owned)).toBe(true);
  });

  it('returns false for an empty changeset', () => {
    expect(touchesCodeOwnedPath([], owned)).toBe(false);
  });

  it('FAILS SAFE: an unsupported pattern marks every PR human-surface, even a non-owned file', () => {
    const unsupported = { prefixes: ['SPEC.md'], hasUnsupportedPattern: true };
    expect(touchesCodeOwnedPath(['packages/autopilot/src/x.ts'], unsupported)).toBe(true);
    expect(touchesCodeOwnedPath([], unsupported)).toBe(true);
  });
});
