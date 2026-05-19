import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  goldPath,
  workspacePath,
  workspacesRoot,
  defaultSubstrateRoot,
} from '../../../scripts/release/substrate-paths';

describe('substrate-paths', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it('defaultSubstrateRoot resolves to ~/jinn-dev under HOME', () => {
    process.env.HOME = '/Users/test';
    expect(defaultSubstrateRoot()).toBe('/Users/test/jinn-dev');
  });

  it('goldPath composes correctly', () => {
    process.env.HOME = '/Users/test';
    expect(goldPath('op-a')).toBe('/Users/test/jinn-dev/operators/op-a');
    expect(goldPath('op-b')).toBe('/Users/test/jinn-dev/operators/op-b');
  });

  it('workspacePath composes correctly', () => {
    process.env.HOME = '/Users/test';
    expect(workspacePath('run-123', 'op-a')).toBe('/Users/test/jinn-dev/workspaces/run-123/op-a');
  });

  it('workspacesRoot returns the workspaces dir', () => {
    process.env.HOME = '/Users/test';
    expect(workspacesRoot()).toBe('/Users/test/jinn-dev/workspaces');
  });

  it('accepts a custom substrateRoot override', () => {
    expect(goldPath('op-a', '/custom/root')).toBe('/custom/root/operators/op-a');
    expect(workspacePath('run-1', 'op-a', '/custom/root')).toBe('/custom/root/workspaces/run-1/op-a');
  });

  it('falls back to os.homedir when HOME is empty', () => {
    process.env.HOME = '';
    // Should NOT produce a relative path like 'jinn-dev'
    const root = defaultSubstrateRoot();
    expect(root.startsWith('/')).toBe(true);
    expect(root.endsWith('/jinn-dev')).toBe(true);
  });
});
