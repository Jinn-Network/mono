import { describe, expect, it } from 'vitest';
import {
  SolverNetRegistry,
  loadSolverNets,
  registerJoinedNet,
  type JoinedSolverNetConfig,
} from '../../src/solver-nets/registry.js';

// A swe-rebench-v2 joined entry exercises the default-plugin seeding path
// (defaultRuntimePluginsForSolverType returns 'bundled:swe-rebench-v2-runtime').
const CID = 'bafytestcid1037';
const joined: JoinedSolverNetConfig = {
  manifestCid: CID,
  name: 'swe-isolated',
  contract: { id: 'swe-rebench-v2', version: 'v1' },
  roles: ['solver'],
  harness: 'codex',
  plugins: [],
  disabledDefaultPlugins: [],
};

describe('registerJoinedNet', () => {
  it('produces the same LoadedSolverNet as loadSolverNets for the same entry', async () => {
    const viaBoot = await loadSolverNets({ joinedSolverNets: { [CID]: joined } });
    const expected = viaBoot.list();

    const live = new SolverNetRegistry();
    await registerJoinedNet(live, CID, joined);

    expect(live.list()).toEqual(expected);
  });

  it('is a no-op when the joined entry has no resolvable contract', async () => {
    const live = new SolverNetRegistry();
    await registerJoinedNet(live, CID, { ...joined, contract: undefined });
    expect(live.list()).toEqual([]);
  });
});
