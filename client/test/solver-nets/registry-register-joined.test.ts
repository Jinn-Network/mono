import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const semanticJoined: JoinedSolverNetConfig = {
  manifestCid: 'bafkreihvpooczub6s7c3yuraotwe43xbu4dliowmnkymegct66ddgrlaoa',
  name: 'autopilot-dual-role',
  contract: { id: 'jinn-repo', version: 'v1' },
  roles: ['solver', 'evaluator'],
  harness: 'claude-code',
  model: 'anthropic/claude-opus-4.7',
  provider: 'openrouter',
  semanticEvaluator: {
    runtime: 'codex',
    model: 'gpt-5.4-mini',
    auth: 'chatgpt-oauth-only',
  },
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

  it('retains semantic metadata without changing restoration routing', async () => {
    const live = new SolverNetRegistry();
    await registerJoinedNet(live, semanticJoined.manifestCid, semanticJoined);

    expect(live.list()).toEqual([
      expect.objectContaining({
        manifestCid: semanticJoined.manifestCid,
        roles: ['solving', 'evaluating'],
        harness: 'claude-code',
        model: 'anthropic/claude-opus-4.7',
        provider: 'openrouter',
        semanticEvaluator: {
          runtime: 'codex',
          model: 'gpt-5.4-mini',
          auth: 'chatgpt-oauth-only',
        },
      }),
    ]);
  });

  it('omits semantic metadata for a legacy joined entry', async () => {
    const live = new SolverNetRegistry();
    await registerJoinedNet(live, CID, joined);

    expect(live.list()[0]).not.toHaveProperty('semanticEvaluator');
  });

  describe('diagnostic warnings on silent skip', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('warns (missing contract field) and does not register when contract is absent', async () => {
      const live = new SolverNetRegistry();
      await registerJoinedNet(live, CID, { ...joined, contract: undefined });

      expect(live.list()).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0][0]);
      expect(msg).toMatch(/missing contract field/);
      expect(msg).toContain(CID);
    });

    it('warns (did not resolve) and does not register when contract is unknown', async () => {
      const live = new SolverNetRegistry();
      await registerJoinedNet(live, CID, {
        ...joined,
        contract: { id: 'not-a-real-solvernet', version: 'v99' },
      });

      expect(live.list()).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0][0]);
      expect(msg).toMatch(/did not resolve/);
      expect(msg).toContain(CID);
    });

    it('does not warn on the happy path with a resolvable contract', async () => {
      const live = new SolverNetRegistry();
      await registerJoinedNet(live, CID, joined);

      expect(live.list().length).toBeGreaterThan(0);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
