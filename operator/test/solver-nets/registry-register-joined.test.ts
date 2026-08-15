import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SolverNetRegistry,
  loadSolverNets,
  registerJoinedNet,
  registerWiringEntry,
  type JoinedSolverNetConfig,
} from '../../src/solver-nets/registry.js';
import type { ExecutionWiringConfigEntry } from '../../src/config/shape-v2.js';

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
  it('produces the same LoadedSolverNet as loadSolverNets for the same wiring row', async () => {
    const wiring: ExecutionWiringConfigEntry = {
      workKind: 'swe-rebench-v2.v1',
      harness: 'codex',
      model: 'claude-haiku-4-5-20251001',
      plugins: [],
      credentialRef: 'codex-default',
      isolationPolicy: 'process',
      legacyManifestDigest: CID,
    };
    const viaBoot = await loadSolverNets({ executionWiring: [wiring] });
    const live = new SolverNetRegistry();
    await registerWiringEntry(live, wiring);

    expect(live.list()).toEqual(viaBoot.list());
  });

  it('is a no-op when the joined entry has no resolvable contract', async () => {
    const live = new SolverNetRegistry();
    await registerJoinedNet(live, CID, { ...joined, contract: undefined });
    expect(live.list()).toEqual([]);
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
