import { describe, it, expect } from 'vitest';
import {
  scopeTestsForChangedFiles,
  CLIENT_PACKAGE,
  SDK_PACKAGE,
  KNOWN_LIVE_EVAL_PACKAGES,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/scope-tests.js';

function scopeFor(pkg: ReturnType<typeof scopeTestsForChangedFiles>, root: string) {
  return pkg.find((s) => s.pkg.root === root);
}

describe('scopeTestsForChangedFiles — mirror convention', () => {
  it('mirrors a client/src/*.ts file to its client/test/*.test.ts path', () => {
    const scopes = scopeTestsForChangedFiles(['client/src/adapters/mech/safe.ts']);
    expect(scopeFor(scopes, 'client')?.candidateTestFiles).toEqual([
      'client/test/adapters/mech/safe.test.ts',
    ]);
  });

  it('mirrors a .tsx file to a .test.tsx path', () => {
    const scopes = scopeTestsForChangedFiles(['client/src/dashboard/spa/src/Widget.tsx']);
    expect(scopeFor(scopes, 'client')?.candidateTestFiles).toEqual([
      'client/test/dashboard/spa/src/Widget.test.tsx',
    ]);
  });

  it('passes an already-a-test-file through unchanged, never double-mirroring', () => {
    const scopes = scopeTestsForChangedFiles(['client/test/adapters/mech/safe.test.ts']);
    expect(scopeFor(scopes, 'client')?.candidateTestFiles).toEqual([
      'client/test/adapters/mech/safe.test.ts',
    ]);
  });

  it('passes a co-located src/ test file through as-is (dashboard SPA does not use the src<->test split)', () => {
    const scopes = scopeTestsForChangedFiles([
      'client/src/dashboard/spa/src/App.routing.test.tsx',
    ]);
    expect(scopeFor(scopes, 'client')?.candidateTestFiles).toEqual([
      'client/src/dashboard/spa/src/App.routing.test.tsx',
    ]);
  });

  it('dedupes repeated mirrored paths from multiple changed files', () => {
    const scopes = scopeTestsForChangedFiles([
      'client/src/foo/bar.ts',
      'client/test/foo/bar.test.ts',
    ]);
    // Both changed files mirror/pass-through to the same test path.
    expect(scopeFor(scopes, 'client')?.candidateTestFiles).toEqual(['client/test/foo/bar.test.ts']);
  });
});

describe('scopeTestsForChangedFiles — fallback triggers', () => {
  it('marks a package touched with an empty candidate list for a non-source file (package.json)', () => {
    const scopes = scopeTestsForChangedFiles(['client/package.json']);
    const client = scopeFor(scopes, 'client');
    expect(client).toBeDefined();
    expect(client?.candidateTestFiles).toEqual([]);
  });

  it('ignores files outside every known package root', () => {
    const scopes = scopeTestsForChangedFiles(['docs/some-doc.md', '.claude/settings.json']);
    expect(scopes).toEqual([]);
  });
});

describe('scopeTestsForChangedFiles — multi-package', () => {
  it('returns one PackageScope per touched package, each independently mirrored', () => {
    const scopes = scopeTestsForChangedFiles([
      'client/src/foo.ts',
      'packages/sdk/src/payloads/jinn-repo.ts',
    ]);
    expect(scopes).toHaveLength(2);
    expect(scopeFor(scopes, 'client')?.candidateTestFiles).toEqual(['client/test/foo.test.ts']);
    expect(scopeFor(scopes, 'packages/sdk')?.candidateTestFiles).toEqual([
      'packages/sdk/test/payloads/jinn-repo.test.ts',
    ]);
  });

  it('a patch touching only packages/sdk does not touch client', () => {
    const scopes = scopeTestsForChangedFiles(['packages/sdk/src/jinn-repo.ts']);
    expect(scopes).toHaveLength(1);
    expect(scopeFor(scopes, 'client')).toBeUndefined();
  });

  it('includes the complete jinn-mono.v1 verification surface', () => {
    expect(KNOWN_LIVE_EVAL_PACKAGES.map(({ root }) => root)).toEqual([
      'packages/plugin',
      'packages/core',
      'packages/sdk',
      'packages/indexer',
      'packages/indexer-enrichment',
      'packages/layer',
      'client',
      'contracts',
      'packages/autopilot',
      'apps/broadcast-bot',
    ]);
    expect(KNOWN_LIVE_EVAL_PACKAGES).toContain(SDK_PACKAGE);
    expect(KNOWN_LIVE_EVAL_PACKAGES).toContain(CLIENT_PACKAGE);
  });

  it('accepts a custom package list, ignoring files outside it', () => {
    const scopes = scopeTestsForChangedFiles(['packages/sdk/src/foo.ts'], [CLIENT_PACKAGE]);
    expect(scopes).toEqual([]);
  });
});
