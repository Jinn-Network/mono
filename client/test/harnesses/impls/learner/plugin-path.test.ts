import { describe, it, expect, vi, afterEach } from 'vitest';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';

// Spy on existsSync so individual negative-path tests can override its
// behaviour without touching the real filesystem. The positive tests restore
// the original implementation so they still exercise the real plugin tree.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import { resolvePluginRoot } from '../../../../src/harnesses/impls/learner/plugin-path.js';

// Capture the real implementation once the mock module has been set up.
// vi.fn() wraps actual.existsSync, so calling mockRestore() returns to it.
const existsSync = nodeFs.existsSync;

describe('resolvePluginRoot', () => {
  afterEach(() => {
    vi.mocked(existsSync).mockRestore();
  });

  it('returns an existing directory containing the expected plugin layout', () => {
    // The mock wraps the real implementation by default; no override needed.
    const root = resolvePluginRoot();
    expect(nodeFs.existsSync(root)).toBe(true);
    expect(nodeFs.existsSync(join(root, 'skills', 'learn', 'SKILL.md'))).toBe(true);
    expect(nodeFs.existsSync(join(root, 'skills', 'learn', 'explorer-prompt.md'))).toBe(true);
    expect(nodeFs.existsSync(join(root, 'hooks', 'session-start'))).toBe(true);
    expect(nodeFs.existsSync(join(root, 'CLAUDE.md'))).toBe(true);
  });

  it('returns an absolute path', () => {
    const root = resolvePluginRoot();
    expect(root.startsWith('/')).toBe(true);
  });

  it('throws with an actionable message when hooks/session-start is missing', () => {
    // Simulate a stale plugin tree: pluginRoot exists, skills/learn/SKILL.md exists,
    // but hooks/session-start is absent.
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('hooks/session-start')) return false;
      return true;
    });
    expect(() => resolvePluginRoot()).toThrowError(
      /missing hooks\/session-start — plugin assets may be stale or incomplete; rebuild the plugin/,
    );
  });

  it('throws with an actionable message when hooks/post-tool-use-failure is missing', () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('hooks/post-tool-use-failure')) return false;
      return true;
    });
    expect(() => resolvePluginRoot()).toThrowError(
      /missing hooks\/post-tool-use-failure — plugin assets may be stale or incomplete; rebuild the plugin/,
    );
  });

  it('throws with an actionable message when hooks/hooks.json is missing', () => {
    // Simulate a stale plugin tree: pluginRoot exists, skills/learn/SKILL.md exists,
    // hooks/session-start exists, but hooks/hooks.json is absent.
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('hooks/hooks.json')) return false;
      return true;
    });
    expect(() => resolvePluginRoot()).toThrowError(
      /missing hooks\/hooks\.json — plugin assets may be stale or incomplete; rebuild the plugin/,
    );
  });

  it('throws with an actionable message when the plugin manifest is missing', () => {
    // Simulate a corrupted/partial plugin tree: pluginRoot exists, skills and
    // hooks exist, but .claude-plugin/plugin.json is absent. Without this guard
    // the learner harness would degrade to un-attributed envelopes (re-#1035).
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('.claude-plugin/plugin.json')) return false;
      return true;
    });
    expect(() => resolvePluginRoot()).toThrowError(
      /missing \.claude-plugin\/plugin\.json — plugin manifest missing; learner attribution would be silently dropped — rebuild the plugin/,
    );
  });

  it('resolves inside dist/plugins/learner when running from a compiled dist tree', () => {
    // When running from the compiled dist/, the impl file lives at
    // dist/harnesses/impls/learner/plugin-path.js. The build copies
    // plugins/learner → dist/plugins/learner. Verify the dist tree exists
    // (i.e. `yarn build` has been run) and contains the expected layout.
    const distPluginRoot = join(
      // Locate client package root: up four from this test file
      // (impls → harnesses → test → client)
      new URL('../../../../..', import.meta.url).pathname,
      'dist',
      'plugins',
      'learner',
    );
    if (!existsSync(distPluginRoot)) {
      // The dist tree has not been built yet — skip rather than fail so that
      // `yarn test` (no prior build) stays green. CI runs `yarn build` before
      // `yarn test` so this branch is covered in the full pipeline.
      return;
    }
    expect(existsSync(join(distPluginRoot, 'skills', 'learn', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(distPluginRoot, 'hooks', 'session-start'))).toBe(true);
    expect(existsSync(join(distPluginRoot, 'CLAUDE.md'))).toBe(true);
  });
});
