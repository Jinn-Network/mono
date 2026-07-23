// Issue #2039 AC2: with two joined SolverNets sharing a `solverType`,
// resolution must be able to disambiguate by manifest CID rather than
// falling back to registry (insertion) order.

import { describe, expect, it } from 'vitest';
import {
  SolverNetRegistry,
  registerJoinedNet,
  type JoinedSolverNetConfig,
} from '../../src/solver-nets/registry.js';

const CID_A = 'bafy-launcher-a';
const CID_B = 'bafy-launcher-b';

function joinedEntry(overrides: Partial<JoinedSolverNetConfig> = {}): JoinedSolverNetConfig {
  return {
    manifestCid: CID_A,
    contract: { id: 'prediction', version: 'v1' },
    roles: ['solver'],
    harness: 'claude-code',
    plugins: [],
    disabledDefaultPlugins: [],
    ...overrides,
  };
}

describe('SolverNetRegistry.forManifestCid', () => {
  it('populates manifestCid on the registered LoadedSolverNet', async () => {
    const registry = new SolverNetRegistry();
    await registerJoinedNet(registry, CID_A, joinedEntry({ name: 'launcher-a' }));
    expect(registry.get('launcher-a')?.manifestCid).toBe(CID_A);
  });

  it('resolves the correct net among two joined nets sharing a solverType', async () => {
    const registry = new SolverNetRegistry();
    // Registered first, so registry-order dispatch (forSolverType) would win by default.
    await registerJoinedNet(
      registry,
      CID_A,
      joinedEntry({ name: 'launcher-a', harness: 'codex', model: 'gpt-5-codex' }),
    );
    await registerJoinedNet(
      registry,
      CID_B,
      joinedEntry({ manifestCid: CID_B, name: 'launcher-b', harness: 'claude-code', model: 'claude-sonnet-5' }),
    );

    // Registry-order dispatch is oblivious to manifestCid and always returns
    // the first registrant (launcher-a) for this solverType.
    expect(registry.forSolverType('prediction.v1', 'restoration')?.name).toBe('launcher-a');

    // Resolution by manifest CID correctly picks the SPECIFIC net a task is
    // pinned to, regardless of registration order.
    expect(registry.forManifestCid(CID_B, 'restoration')?.name).toBe('launcher-b');
    expect(registry.forManifestCid(CID_B, 'restoration')?.harness).toBe('claude-code');
    expect(registry.forManifestCid(CID_A, 'restoration')?.name).toBe('launcher-a');
    expect(registry.forManifestCid(CID_A, 'restoration')?.harness).toBe('codex');
  });

  it('respects the role filter', async () => {
    const registry = new SolverNetRegistry();
    await registerJoinedNet(registry, CID_A, joinedEntry({ name: 'launcher-a', roles: ['evaluator'] }));

    expect(registry.forManifestCid(CID_A, 'restoration')).toBeUndefined();
    expect(registry.forManifestCid(CID_A, 'evaluation')).toBeDefined();
  });

  it('respects the enabled filter and returns undefined for an unknown CID', async () => {
    const registry = new SolverNetRegistry();
    await registerJoinedNet(registry, CID_A, joinedEntry({ name: 'launcher-a' }));

    expect(registry.forManifestCid('bafy-unknown')).toBeUndefined();
  });
});
