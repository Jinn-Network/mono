import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginRoot } from '../../../../src/restorer/impls/default-learner/plugin-path.js';

describe('resolvePluginRoot', () => {
  it('returns an existing directory containing the expected plugin layout', () => {
    const root = resolvePluginRoot();
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, 'skills', 'coordinator', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, 'agents', 'explorer.md'))).toBe(true);
    expect(existsSync(join(root, 'hooks', 'session-start'))).toBe(true);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
  });

  it('returns an absolute path', () => {
    const root = resolvePluginRoot();
    expect(root.startsWith('/')).toBe(true);
  });
});
