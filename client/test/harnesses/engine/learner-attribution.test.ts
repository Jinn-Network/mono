/**
 * Regression test for #1035 — claude-code-learner attribution.
 *
 * A learner run's signed envelope must carry the learner plugin in
 * executor.plugins alongside the SolverNet's baseline runtime plugins, in the
 * same {name, version, sha256} shape. A harness that does NOT implement
 * attributionPlugins() must NOT inject any extra plugin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  type TaskEngineOptions,
  type SolverNetRegistryLike,
} from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { Harness, RuntimePlugin, Solution } from '../../../src/harnesses/types.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(('0x' + 'de'.repeat(32)) as `0x${string}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
// `legacy.v0` has a passthrough payload schema (z.record(z.unknown())), so the
// stub Solution's portfolio-shaped fallback payload passes validatePayload()
// in pack(). The attribution path under test is solverType-agnostic; using a
// typed schema (e.g. swe-rebench-v2.v1) would force the stub to produce a
// fully-formed solution payload that is irrelevant to plugin attribution.
const SOLVER_TYPE = 'legacy.v0';

function mkTmp(): string {
  const dir = join(tmpdir(), `learner-attr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Two baseline runtime plugins the SolverNet ships, mirroring production.
const baselinePlugins: RuntimePlugin[] = [
  {
    name: '@jinn-network/network-tools',
    version: '0.3.0',
    source: 'bundled:network-tools',
    root: '/dev/null/network-tools',
    manifestPath: '/dev/null/network-tools/jinn.plugin.json',
    sha256: 'aa'.repeat(32),
    provenance: 'default',
  },
  {
    name: 'swe-rebench-v2-runtime',
    version: '1.0.0',
    source: 'bundled:swe-rebench-v2-runtime',
    root: '/dev/null/swe-rebench-v2-runtime',
    manifestPath: '/dev/null/swe-rebench-v2-runtime/jinn.plugin.json',
    sha256: 'bb'.repeat(32),
    provenance: 'default',
  },
];

const learnerDescriptor: RuntimePlugin = {
  name: 'claude-code-learner',
  version: '0.1.0',
  source: 'bundled:learner',
  root: '/dev/null/learner',
  manifestPath: '/dev/null/learner/.claude-plugin/plugin.json',
  sha256: 'cc'.repeat(32),
  provenance: 'default',
};

function makeSolverNetRegistry(): SolverNetRegistryLike {
  return {
    forSolverType: (solverType) =>
      solverType === SOLVER_TYPE
        ? {
            name: 'test-net',
            solverType: SOLVER_TYPE,
            harness: 'claude-code',
            runtimePlugins: baselinePlugins,
          }
        : undefined,
  };
}

/** Stub impl. When `withAttribution` is true it advertises the learner plugin. */
function makeStubImpl(withAttribution: boolean): Harness {
  const impl: Harness = {
    name: 'claude-code',
    version: '0.1.0-shim',
    supports: (s) => s.role !== 'evaluation' && s.solverType === SOLVER_TYPE,
    async run(): Promise<Solution> {
      return {
        venueRef: { name: 'claude-code' },
        gating: { ok: true },
        preSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        postSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        fills: [],
      };
    },
  };
  if (withAttribution) {
    impl.attributionPlugins = () => [learnerDescriptor];
  }
  return impl;
}

function makeOpts(store: Store, tmp: string, impl: Harness): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(tmp, 'work'), implStateDirRoot: join(tmp, 'impl') },
    implRegistry: { findFor: (s) => (impl.supports(s) ? impl : undefined) },
    solverNetRegistry: makeSolverNetRegistry(),
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: '0xsafe' as `0x${string}`,
    },
  };
}

function makeInput(requestId: string): PersistedTaskRunInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    taskCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    solverType: SOLVER_TYPE,
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    task: { id: requestId, description: 'test', solverType: SOLVER_TYPE, role: 'restoration' },
  };
}

/** Drive observe → … → PACKAGING through the real runImpl + pack, return the uploaded envelope. */
async function runToEnvelope(
  store: Store,
  tmp: string,
  impl: Harness,
  requestId: string,
): Promise<Record<string, unknown>> {
  const engine = new TaskEngine(makeOpts(store, tmp, impl));
  const p = new TaskRunPersistence(store.db);
  await engine.observe(makeInput(requestId));
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  // First process(): WAITING → PRE_SNAPSHOT → RUNNING (real runImpl) → POST_SNAPSHOT.
  // The RUNNING case `break`s after runImpl (engine.ts:733-735), so the task
  // stops at POST_SNAPSHOT (postSnapshotPayload now set from the stub Solution).
  await engine.process(requestId);
  expect(p.getByRequestId(requestId)!.state).toBe(TaskRunState.POST_SNAPSHOT);
  // Second process(): POST_SNAPSHOT case (engine.ts:737-749) data-driven-advances
  // to PACKAGING and runs the real pack() (which uploads the signed envelope).
  await engine.process(requestId);

  const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
  const calls = (uploadToIpfs as ReturnType<typeof vi.fn>).mock.calls;
  const envelopeCall = calls.find(
    ([, payload]: [string, Record<string, unknown>]) =>
      typeof payload === 'object' && payload !== null && 'executor' in payload && 'participant' in payload,
  );
  if (!envelopeCall) throw new Error('no envelope was uploaded to IPFS');
  return envelopeCall[1] as Record<string, unknown>;
}

function pluginNames(envelope: Record<string, unknown>): string[] {
  const executor = envelope.executor as { plugins?: Array<{ name: string }> };
  return (executor.plugins ?? []).map((pl) => pl.name);
}

describe('#1035 learner plugin attribution in executor.plugins', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
    vi.clearAllMocks();
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('includes claude-code-learner with {name, version, sha256} for a learner run', async () => {
    const envelope = await runToEnvelope(store, tmp, makeStubImpl(true), 'req-attr-1');
    const executor = envelope.executor as { plugins: Array<{ name: string; version: string; sha256: string }> };
    const learner = executor.plugins.find((pl) => pl.name === 'claude-code-learner');
    expect(learner).toBeDefined();
    expect(learner!.version).toBe('0.1.0');
    expect(learner!.sha256).toBe('cc'.repeat(32));
    // No regression: both baseline plugins still present.
    expect(pluginNames(envelope)).toEqual(
      expect.arrayContaining(['@jinn-network/network-tools', 'swe-rebench-v2-runtime', 'claude-code-learner']),
    );
  });

  it('omits claude-code-learner for a harness without attributionPlugins()', async () => {
    const envelope = await runToEnvelope(store, tmp, makeStubImpl(false), 'req-attr-2');
    expect(pluginNames(envelope)).not.toContain('claude-code-learner');
    expect(pluginNames(envelope)).toEqual(
      expect.arrayContaining(['@jinn-network/network-tools', 'swe-rebench-v2-runtime']),
    );
  });
});
