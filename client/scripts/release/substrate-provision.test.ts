// client/scripts/release/substrate-provision.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  provisionSubstrate,
  buildRpcChain,
  rpcChainIsHealthy,
  DEFAULT_SOLVE_HARNESS,
  DEFAULT_SOLVE_MODEL,
  EVALUATOR_STATE_DIR_NAME,
  type CheckResult,
} from './substrate-provision.js';
import { DEFAULT_TESTNET_RPC_URLS } from '../../src/config.js';
import { EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { KNOWN_INSTANCE_ID } from '../../test/release/tier-2/fixtures/known-instance.js';

const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

// Write a validated-pool.json at the evaluator state dir holding a (un)scorable
// admission for the T3.1 gate fixture — simulates the operator having run
// `jinn solver-nets validate-pool` so the admission-pool-fixture check passes.
async function seedFixturePool(opDir: string, scorable = true): Promise<void> {
  const stateDir = path.join(opDir, '.jinn-client', 'engine', 'impl-state', EVALUATOR_STATE_DIR_NAME);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, 'validated-pool.json'),
    JSON.stringify({
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      updatedAt: new Date().toISOString(),
      entries: {
        [KNOWN_INSTANCE_ID]: {
          scorable,
          reason: scorable ? 'gold-patch-resolves' : 'gold-patch-not-resolved',
          checkedAt: new Date().toISOString(),
        },
      },
    }, null, 2),
  );
}

function manifestFixture(opName: string, overrides: { rpcUrl?: string; fleetSafe?: string } = {}): unknown {
  return {
    substrateVersion: '1',
    createdAt: new Date().toISOString(),
    adoptedFrom: '/tmp/source',
    name: opName,
    shape: 'current',
    role: 'participant',
    network: 'base-sepolia',
    operator: {
      masterAddress: ADDR(1),
      fleetAgentId: '42',
      fleetSafeAddress: overrides.fleetSafe ?? ADDR(2),
      fleetStage: 'staked',
      serviceId: 7,
      serviceStep: 'complete',
      agentEoa: ADDR(3),
      safeAddress: ADDR(2),
      mechAddress: ADDR(4),
      stakingAddress: ADDR(5),
      identityRegistry: ADDR(6),
    },
    config: {
      apiPort: 7331,
      rpcUrl: overrides.rpcUrl ?? DEFAULT_TESTNET_RPC_URLS[0],
      joinedSolverNets: ['QmManifestCidA'],
    },
  };
}

interface SetupOpts {
  rpcUrl?: string | string[];
  harness?: string;
  model?: string;
  roles?: string[];
  manifestRpcUrl?: string;
  withEvaluatorState?: boolean;
  withPool?: boolean;
}

async function setupHome(root: string, opName: string, o: SetupOpts = {}): Promise<string> {
  const opDir = path.join(root, 'operators', opName);
  const jinn = path.join(opDir, '.jinn-client');
  await fs.mkdir(path.join(jinn, 'earning'), { recursive: true });

  await fs.writeFile(
    path.join(opDir, 'manifest.json'),
    JSON.stringify(manifestFixture(opName, { rpcUrl: o.manifestRpcUrl }), null, 2) + '\n',
  );
  await fs.writeFile(
    path.join(jinn, 'config.json'),
    JSON.stringify(
      {
        apiPort: 7331,
        rpcUrl: o.rpcUrl ?? DEFAULT_TESTNET_RPC_URLS[0], // single endpoint = drift by default
        executionWiring: [{
          workKind: 'swe-rebench-v2.v1',
          harness: o.harness ?? 'hermes-agent',
          model: o.model ?? 'deepseek/deepseek-v4-flash',
          plugins: [],
          credentialRef: `${o.harness ?? 'hermes-agent'}-default`,
          isolationPolicy: 'process',
          legacyManifestDigest: 'QmManifestCidA',
        }],
        ...(o.roles?.includes('evaluator') ? { evaluator: { enabled: true } } : {}),
      },
      null,
      2,
    ) + '\n',
  );
  await fs.writeFile(
    path.join(jinn, 'earning', 'earning_state.json'),
    JSON.stringify({ fleet_agent_id: '42', fleet_safe_address: ADDR(2), chain: 'base-sepolia' }, null, 2) + '\n',
  );
  return opDir;
}

function byId(checks: CheckResult[], id: CheckResult['id']): CheckResult {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

const credsPresent = async () => true;
const credsMissing = async () => false;
const fakeEnableEvaluatorHarness = async (implStateDir: string) => {
  const upstreamRepoDir = path.join(implStateDir, 'upstream');
  await fs.mkdir(upstreamRepoDir, { recursive: true });
  await fs.writeFile(path.join(upstreamRepoDir, 'eval.py'), '# fake upstream\n');
  await fs.writeFile(
    path.join(implStateDir, 'state.json'),
    JSON.stringify({
      schemaVersion: 'swe-rebench-v2-evaluator-state.v1',
      enabled: true,
      enabledAt: new Date().toISOString(),
      upstreamRepoDir,
    }, null, 2) + '\n',
  );
  return { status: 'ready', details: { upstreamRepoDir } };
};

describe('substrate-provision doctor', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-provision-test-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rpcChainIsHealthy / buildRpcChain agree on the canonical chain', () => {
    expect(rpcChainIsHealthy(DEFAULT_TESTNET_RPC_URLS[0])).toBe(false); // single string = drift
    expect(rpcChainIsHealthy([DEFAULT_TESTNET_RPC_URLS[0]])).toBe(false); // missing slot
    expect(rpcChainIsHealthy(buildRpcChain())).toBe(true);
    const paid = buildRpcChain('https://paid.example');
    expect(paid[0]).toBe('https://paid.example');
    expect(rpcChainIsHealthy(paid)).toBe(true);
  });

  it('detects all five drift categories without mutating files (detect-only)', async () => {
    const opDir = await setupHome(root, 'op-a');
    const cfgBefore = await fs.readFile(path.join(opDir, '.jinn-client', 'config.json'), 'utf-8');

    const res = await provisionSubstrate('op-a', {
      substrateRoot: root,
      skipOnChain: true,
      isEvaluator: true,
      hasHarnessCreds: credsMissing,
    });

    expect(res.ok).toBe(false);
    expect(byId(res.checks, 'rpc-fallback-chain').status).toBe('drift');
    expect(byId(res.checks, 'harness-config').status).toBe('drift');
    expect(byId(res.checks, 'evaluator-role').status).toBe('drift');
    expect(byId(res.checks, 'evaluator-harness-state').status).toBe('drift');
    expect(byId(res.checks, 'admission-pool').status).toBe('drift');
    expect(byId(res.checks, 'harness-creds').status).toBe('drift');

    // detect-only must not write
    expect(await fs.readFile(path.join(opDir, '.jinn-client', 'config.json'), 'utf-8')).toBe(cfgBefore);
  });

  it('repairs RPC chain, harness config, evaluator role, harness state, and admission pool', async () => {
    const opDir = await setupHome(root, 'op-b');

    const res = await provisionSubstrate('op-b', {
      substrateRoot: root,
      repair: true,
      skipOnChain: true,
      isEvaluator: true,
      hasHarnessCreds: credsPresent,
      enableEvaluatorHarness: fakeEnableEvaluatorHarness,
    });

    // --repair fixes every structural drift, BUT seeds an EMPTY admission pool —
    // it cannot synthesise a scorable gold-patch grade for the gate fixture, so
    // admission-pool-fixture stays drift and the op is not yet release-ready
    // (the operator must run `validate-pool`). This is the fast-fail that
    // replaces a 23-min T3.1 timeout (2026-06-08 cut).
    expect(res.ok).toBe(false);
    expect(byId(res.checks, 'rpc-fallback-chain').status).toBe('repaired');
    expect(byId(res.checks, 'harness-config').status).toBe('repaired');
    expect(byId(res.checks, 'evaluator-role').status).toBe('repaired');
    expect(byId(res.checks, 'evaluator-harness-state').status).toBe('repaired');
    expect(byId(res.checks, 'admission-pool').status).toBe('repaired');
    expect(byId(res.checks, 'admission-pool-fixture').status).toBe('drift');

    const cfg = JSON.parse(await fs.readFile(path.join(opDir, '.jinn-client', 'config.json'), 'utf-8'));
    expect(Array.isArray(cfg.rpcUrl)).toBe(true);
    expect(cfg.rpcUrl).toEqual(DEFAULT_TESTNET_RPC_URLS);
    const entry = cfg.executionWiring[0];
    // HarnessNameSchema is not applied here (raw config rewrite) — the doctor
    // writes the configured alias verbatim; the daemon canonicalises on load.
    expect(entry.harness).toBe(DEFAULT_SOLVE_HARNESS);
    expect(entry.model).toBe(DEFAULT_SOLVE_MODEL);
    expect(cfg.evaluator.enabled).toBe(true);

    const stateDir = path.join(opDir, '.jinn-client', 'engine', 'impl-state', EVALUATOR_STATE_DIR_NAME);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf-8'));
    expect(state.enabled).toBe(true);
    await expect(fs.access(path.join(stateDir, 'upstream', 'eval.py'))).resolves.toBeUndefined();
    const pool = JSON.parse(await fs.readFile(path.join(stateDir, 'validated-pool.json'), 'utf-8'));
    expect(pool.schemaVersion).toBe('swe-rebench-v2-validated-pool.v1');
    expect(pool.entries).toEqual({});
  });

  it('is idempotent — a second repair run reports ok with no further repairs', async () => {
    const opDir = await setupHome(root, 'op-b');
    await provisionSubstrate('op-b', {
      substrateRoot: root,
      repair: true,
      skipOnChain: true,
      isEvaluator: true,
      hasHarnessCreds: credsPresent,
      enableEvaluatorHarness: fakeEnableEvaluatorHarness,
    });

    // Simulate the operator running `validate-pool` between preflights: the gate
    // fixture now has a scorable v4 admission, so the home is fully release-ready
    // and the second run is a clean no-op.
    await seedFixturePool(opDir, true);

    const second = await provisionSubstrate('op-b', {
      substrateRoot: root,
      repair: true,
      skipOnChain: true,
      isEvaluator: true,
      hasHarnessCreds: credsPresent,
      enableEvaluatorHarness: async () => {
        throw new Error('enable should not be called when state+upstream are ready');
      },
    });
    expect(second.ok).toBe(true);
    const repaired = second.checks.filter((c) => c.status === 'repaired');
    expect(repaired).toHaveLength(0);
    for (const c of second.checks) {
      expect(['ok', 'skipped']).toContain(c.status);
    }
  });

  it('admission-pool-fixture: ok when the gate fixture is scorable under the current semantics', async () => {
    const opDir = await setupHome(root, 'op-a');
    await seedFixturePool(opDir, true);

    const res = await provisionSubstrate('op-a', {
      substrateRoot: root,
      skipOnChain: true,
      isEvaluator: true,
      hasHarnessCreds: credsPresent,
    });

    expect(byId(res.checks, 'admission-pool').status).toBe('ok');
    expect(byId(res.checks, 'admission-pool-fixture').status).toBe('ok');
  });

  it('admission-pool-fixture: drift (un-repairable) when the gate fixture is recorded unscorable', async () => {
    const opDir = await setupHome(root, 'op-c');
    await seedFixturePool(opDir, false);

    // --repair cannot fix this: a scorable admission needs a real gold-patch grade.
    const res = await provisionSubstrate('op-c', {
      substrateRoot: root,
      repair: true,
      skipOnChain: true,
      isEvaluator: true,
      hasHarnessCreds: credsPresent,
      enableEvaluatorHarness: fakeEnableEvaluatorHarness,
    });

    expect(byId(res.checks, 'admission-pool-fixture').status).toBe('drift');
    expect(res.ok).toBe(false);
  });

  it('harness-creds drift can never be auto-repaired (no synthesised login)', async () => {
    await setupHome(root, 'op-a');
    const res = await provisionSubstrate('op-a', { substrateRoot: root, repair: true, skipOnChain: true, hasHarnessCreds: credsMissing });
    const creds = byId(res.checks, 'harness-creds');
    expect(creds.status).toBe('drift');
    expect(res.ok).toBe(false);
  });

  it('treats enabled evaluator state without the upstream checkout as drift', async () => {
    const opDir = await setupHome(root, 'op-b');
    const stateDir = path.join(opDir, '.jinn-client', 'engine', 'impl-state', EVALUATOR_STATE_DIR_NAME);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-evaluator-state.v1',
        enabled: true,
        enabledAt: new Date().toISOString(),
        upstreamRepoDir: path.join(stateDir, 'upstream'),
      }, null, 2) + '\n',
    );

    const res = await provisionSubstrate('op-b', {
      substrateRoot: root,
      skipOnChain: true,
      isEvaluator: true,
      hasHarnessCreds: credsPresent,
    });

    const stateCheck = byId(res.checks, 'evaluator-harness-state');
    expect(stateCheck.status).toBe('drift');
    expect(stateCheck.detail).toMatch(/upstream repo missing/);
  });

  it('prepends a paid RPC key to the testnet chain when provided', async () => {
    const opDir = await setupHome(root, 'op-a');
    await provisionSubstrate('op-a', { substrateRoot: root, repair: true, skipOnChain: true, paidRpcUrl: 'https://alchemy.example', hasHarnessCreds: credsPresent });
    const cfg = JSON.parse(await fs.readFile(path.join(opDir, '.jinn-client', 'config.json'), 'utf-8'));
    expect(cfg.rpcUrl[0]).toBe('https://alchemy.example');
    expect(cfg.rpcUrl).toContain(DEFAULT_TESTNET_RPC_URLS[0]);
    // manifest single-endpoint stays the head slot (paid key)
    const manifest = JSON.parse(await fs.readFile(path.join(opDir, 'manifest.json'), 'utf-8'));
    expect(manifest.config.rpcUrl).toBe('https://alchemy.example');
  });

  it('skips evaluator-only checks for a non-evaluator op', async () => {
    await setupHome(root, 'op-a', { roles: ['solver'] });
    const res = await provisionSubstrate('op-a', { substrateRoot: root, skipOnChain: true, hasHarnessCreds: credsPresent });
    expect(res.checks.find((c) => c.id === 'evaluator-role')).toBeUndefined();
    expect(res.checks.find((c) => c.id === 'admission-pool')).toBeUndefined();
  });

  it('returns a skipped result with no crash when manifest is missing', async () => {
    const res = await provisionSubstrate('op-missing', { substrateRoot: root, skipOnChain: true, hasHarnessCreds: credsPresent });
    expect(res.ok).toBe(false);
    expect(res.checks[0].status).toBe('skipped');
  });
});
