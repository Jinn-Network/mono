import { describe, expect, it } from 'vitest';

/**
 * Reverse architecture test for #1658 (AC2). The `exports` map in
 * package.json is the runtime enforcement: it declares exactly `.` and
 * `./testing`. Node's package self-referencing resolution rejects any other
 * subpath — this proves consumers cannot deep-import internal modules.
 */
describe('package exports boundary (#1658)', () => {
  it('rejects a deep import into src/', async () => {
    const specifier = ['@jinn-network/plugin', 'src', 'ports', 'corpus-port.js'].join('/');
    await expect(import(/* @vite-ignore */ specifier)).rejects.toThrow();
  });

  it('rejects a deep import into dist/', async () => {
    const specifier = ['@jinn-network/plugin', 'dist', 'ports', 'corpus-port.js'].join('/');
    await expect(import(/* @vite-ignore */ specifier)).rejects.toThrow();
  });

  it('resolves the "." entry', async () => {
    const mod = await import('@jinn-network/plugin');
    expect(typeof mod.createJinnPlugin).toBe('function');
    expect(typeof mod.ContributionCandidateV1Schema?.parse).toBe('function');
    expect(typeof mod.deriveContributionStatus).toBe('function');
    expect(mod.JINN_PLUGIN_CONTRACT_VERSION).toBe(1);
    const plugin = mod.createJinnPlugin;
    expect(typeof plugin).toBe('function');
  });

  it('resolves the "./testing" entry', async () => {
    const mod = await import('@jinn-network/plugin/testing');
    expect(typeof mod.InMemoryCorpusPort).toBe('function');
  });
});
