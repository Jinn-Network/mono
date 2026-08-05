import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdateCommand, formatUpdateSuccessLine } from '@/cli/commands/update.js';
import { runCommand } from '@test/cli.js';
import type { CommandContext } from '@/cli/command.js';
import { FleetStateStore } from '@/earning/store.js';
import { createDefaultFleetState, createDefaultServiceState } from '@/earning/types.js';
import type { FleetState, ServiceState } from '@/earning/types.js';
import { DEFAULT_TESTNET_ARTIFACTS, getChainConfig } from '@/earning/contracts.js';
import { resolveTaskNativeReadiness } from '@/cli/task-native-readiness.js';
import { Store } from '@/store/store.js';

// MOCK_JUSTIFICATION: node:child_process is a leaf Node built-in; execSync is a syscall and cannot be DI'd without a shim module we don't own.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

describe('update command', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    return Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeEarningDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-update-'));
    dirs.push(dir);
    return dir;
  }

  function makeUpdateCommand(
    earningDir: string,
    integrationsRun = vi.fn(async () => {}),
    opts: {
      dbPath?: string;
      storeFactory?: (dbPath: string) => Pick<Store, 'close'>;
    } = {},
  ) {
    return createUpdateCommand({
      integrationsRun,
      loadConfig: () => ({ earningDir, dbPath: opts.dbPath ?? ':memory:' }) as any,
      getConfigPathFromArgs: (argv = []) => {
        const idx = argv.indexOf('--config');
        return idx >= 0 ? argv[idx + 1] : undefined;
      },
      fleetStateStoreFactory: (dir) => new FleetStateStore(dir),
      storeFactory: opts.storeFactory ?? (() => ({ close: () => {} })),
    });
  }

  function completeService(): ServiceState {
    return {
      ...createDefaultServiceState(1, '0x1111111111111111111111111111111111111111'),
      safe_address: '0x2222222222222222222222222222222222222222',
      service_id: 42,
      mech_address: '0x3333333333333333333333333333333333333333',
      staking_address: '0x4444444444444444444444444444444444444444',
      step: 'complete',
      agent_id: '12345',
      agent_uri: 'ipfs://agent',
      identity_registry_address: '0x5555555555555555555555555555555555555555',
      agent_registered_tx: `0x${'aa'.repeat(32)}`,
      safe_bound_to_agent: true,
    };
  }

  function baseSepoliaCompleteService(
    index: number,
    ids: {
      agent: string;
      safe: string;
      serviceId: number;
      mech: string;
      staking: string;
      agentId: string;
    },
  ): ServiceState {
    return {
      ...createDefaultServiceState(index, ids.agent),
      safe_address: ids.safe,
      service_id: ids.serviceId,
      mech_address: ids.mech,
      staking_address: ids.staking,
      step: 'complete',
      agent_id: ids.agentId,
      agent_uri: `ipfs://agent-${ids.agentId}`,
      identity_registry_address: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      agent_registered_tx: `0x${String(index).repeat(64)}`,
      safe_bound_to_agent: true,
    };
  }

  function preservedIdentifiers(state: FleetState) {
    return {
      master: state.master_address,
      services: state.services.map((svc) => ({
        index: svc.index,
        wallet: svc.agent_address,
        agentId: svc.agent_id,
        safe: svc.safe_address,
        serviceId: svc.service_id,
        mech: svc.mech_address,
        staking: svc.staking_address,
        identityRegistry: svc.identity_registry_address,
      })),
    };
  }

  it('reports integration refresh errors even when integrations install does not set an exit code', async () => {
    const earningDir = await makeEarningDir();
    const integrationsRunMock = vi.fn(async (ctx: CommandContext) => {
      ctx.writer.write(JSON.stringify({
        results: [
          {
            target: 'claude-code',
            mcp: { status: 'error', detail: 'failed to add MCP' },
            skill: { status: 'configured', detail: 'skill installed' },
          },
        ],
      }));
    });

    const cmd = makeUpdateCommand(earningDir, integrationsRunMock);
    const { envelopes, exits } = await runCommand(cmd, { argv: ['--json', '--skip-npm'] });

    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'integrations-install',
        status: 'error',
      }),
    ]));
    expect(payload.steps.find((step) => step.step === 'integrations-install')?.detail)
      .toContain('claude-code');
    expect(exits).toEqual([]);
  });

  // F4 fold: `summarizeIntegrationInstall` must not report `ok` when only
  // the hook axis errored — the `hook` field is optional on the result
  // shape (older `integrations install` builds don't emit it), so a naive
  // reader that only checks `mcp`/`skill` silently swallows hook failures.
  it('reports a hook-install error even when mcp and skill both succeeded', async () => {
    const earningDir = await makeEarningDir();
    const integrationsRunMock = vi.fn(async (ctx: CommandContext) => {
      ctx.writer.write(JSON.stringify({
        results: [
          {
            target: 'claude-code',
            mcp: { status: 'configured', detail: 'MCP installed' },
            skill: { status: 'configured', detail: 'skill installed' },
            hook: { status: 'error', detail: 'failed to write .claude/settings.json' },
          },
        ],
      }));
    });

    const cmd = makeUpdateCommand(earningDir, integrationsRunMock);
    const { envelopes, exits } = await runCommand(cmd, { argv: ['--json', '--skip-npm'] });

    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'integrations-install', status: 'error' }),
    ]));
    expect(payload.steps.find((step) => step.step === 'integrations-install')?.detail)
      .toContain('claude-code');
    expect(exits).toEqual([]);
  });

  it('preserves complete local earning fields during Task-native preflight', async () => {
    const earningDir = await makeEarningDir();
    const store = new FleetStateStore(earningDir);
    const initial = {
      ...createDefaultFleetState('base'),
      master_address: '0x9999999999999999999999999999999999999999',
      services: [completeService()],
    };
    await store.save(initial);

    const cmd = makeUpdateCommand(earningDir);
    const { envelopes } = await runCommand(cmd, { argv: ['--json', '--skip-npm', '--skip-plugins'] });
    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };

    expect(payload.ok).toBe(true);
    expect(payload.steps.find((step) => step.step === 'earning-state')).toMatchObject({
      status: 'ok',
    });
    expect(payload.steps.find((step) => step.step === 'earning-state')?.detail)
      .toContain('No chain readback or writes were performed');

    const persisted = await store.tryLoadExisting();
    expect(persisted?.master_address).toBe(initial.master_address);
    expect(persisted?.services[0]).toMatchObject({
      agent_address: '0x1111111111111111111111111111111111111111',
      safe_address: '0x2222222222222222222222222222222222222222',
      service_id: 42,
      mech_address: '0x3333333333333333333333333333333333333333',
      staking_address: '0x4444444444444444444444444444444444444444',
      agent_id: '12345',
      identity_registry_address: '0x5555555555555555555555555555555555555555',
      agent_registered_tx: `0x${'aa'.repeat(32)}`,
      safe_bound_to_agent: true,
    });
  });

  it('upgrades a pre-upgrade Base Sepolia fixture without rebootstrap and resolves bundled V3 runtime metadata', async () => {
    const earningDir = await makeEarningDir();
    const prevV3Artifact = process.env['JINN_TESTNET_TASK_COORDINATOR_ROUTER_V3_DEPLOYMENT'];
    process.env['JINN_TESTNET_TASK_COORDINATOR_ROUTER_V3_DEPLOYMENT'] =
      DEFAULT_TESTNET_ARTIFACTS.taskCoordinatorRouterV3;

    try {
      const chainCfg = getChainConfig('base-sepolia');
      const store = new FleetStateStore(earningDir);
      const preUpgrade: FleetState = {
        ...createDefaultFleetState('base-sepolia'),
        master_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        staking_mode: 'standard',
        services: [
          baseSepoliaCompleteService(1, {
            agent: '0x1111111111111111111111111111111111111111',
            safe: '0x2222222222222222222222222222222222222222',
            serviceId: 7001,
            mech: '0x3333333333333333333333333333333333333333',
            staking: chainCfg.stakingContract,
            agentId: '800401',
          }),
          baseSepoliaCompleteService(2, {
            agent: '0x4444444444444444444444444444444444444444',
            safe: '0x5555555555555555555555555555555555555555',
            serviceId: 7002,
            mech: '0x6666666666666666666666666666666666666666',
            staking: chainCfg.stakingContract,
            agentId: '800402',
          }),
        ],
      };
      await store.save(preUpgrade);
      const before = await store.tryLoadExisting();
      expect(before).not.toBeNull();
      const beforeIdentifiers = preservedIdentifiers(before!);

      const cmd = makeUpdateCommand(earningDir);
      const { envelopes } = await runCommand(cmd, { argv: ['--json', '--skip-npm', '--skip-plugins'] });
      const payload = envelopes[envelopes.length - 1] as {
        ok: boolean;
        steps: Array<{ step: string; status: string; detail: string }>;
      };
      const earningStep = payload.steps.find((step) => step.step === 'earning-state');

      expect(payload.ok).toBe(true);
      expect(earningStep).toMatchObject({ status: 'ok' });
      expect(earningStep?.detail).toContain('Preserved locally recorded wallet, agent, Safe, service, Mech');
      expect(earningStep?.detail).toContain('No chain readback or writes were performed');

      const after = await store.tryLoadExisting();
      expect(after).not.toBeNull();
      expect(after!.chain).toBe('base-sepolia');
      expect(after!.services).toHaveLength(2);
      expect(preservedIdentifiers(after!)).toEqual(beforeIdentifiers);

      const artifact = JSON.parse(
        await readFile(DEFAULT_TESTNET_ARTIFACTS.taskCoordinatorRouterV3, 'utf8'),
      ) as {
        contracts: {
          taskCoordinator: string;
          jinnRouterV3: string;
          activityChecker: string;
        };
      };
      const readiness = resolveTaskNativeReadiness({
        network: 'testnet',
        earningDir,
        dbPath: ':memory:',
        // Issue #421: evaluator-role detection reads joinedSolverNets only.
        joinedSolverNets: {
          'legacy:swe': {
            manifestCid: 'legacy:swe',
            name: 'swe',
            contract: { id: 'swe-rebench-v2', version: 'v1' },
            roles: ['solver', 'evaluator'],
            harness: 'codex-code-learner',
            plugins: [],
            disabledDefaultPlugins: [],
          },
        },
      } as any);
      expect(readiness.ok).toBe(true);
      expect(readiness.solverReady).toBe(true);
      expect(readiness.evaluatorReady).toBe(true);
      expect(readiness.evaluatorRoleReady).toBe(true);
      expect(readiness.distinctEvaluatorServiceReady).toBe(true);
      expect(readiness.source).toBe(DEFAULT_TESTNET_ARTIFACTS.taskCoordinatorRouterV3);
      expect(readiness.contracts).toEqual({
        taskCoordinator: artifact.contracts.taskCoordinator,
        jinnRouterV3: artifact.contracts.jinnRouterV3,
        taskActivityCheckerV3: artifact.contracts.activityChecker,
      });
      expect(readiness.routerClaimDeliveryVersion).toBe('v3');
      expect(readiness.operatorState?.activeSafe).toBe(beforeIdentifiers.services[0]?.safe);
      expect(readiness.operatorState?.evaluatorSafe).toBe(beforeIdentifiers.services[1]?.safe);
      expect(chainCfg.jinnRouter).toBe(artifact.contracts.jinnRouterV3);
      expect(chainCfg.routerClaimDeliveryVersion).toBe('v3');
    } finally {
      if (prevV3Artifact === undefined) {
        delete process.env['JINN_TESTNET_TASK_COORDINATOR_ROUTER_V3_DEPLOYMENT'];
      } else {
        process.env['JINN_TESTNET_TASK_COORDINATOR_ROUTER_V3_DEPLOYMENT'] = prevV3Artifact;
      }
    }
  });

  it('removes legacy ClaimRegistry/request-first config fields with a migration note', async () => {
    const earningDir = await makeEarningDir();
    const configPath = path.join(earningDir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      network: 'testnet',
      testnetClaimRegistryDeploymentPath: '/tmp/claim-registry.json',
      claimRegistryAddress: '0x1111111111111111111111111111111111111111',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          harness: 'claude-code-learner',
          plugins: [],
          taskGenerator: { enabled: true },
        },
      },
    }, null, 2));

    const cmd = makeUpdateCommand(earningDir);
    const { envelopes } = await runCommand(cmd, {
      argv: ['--json', '--skip-npm', '--skip-plugins', '--config', configPath],
    });
    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };
    const configStep = payload.steps.find((step) => step.step === 'config-migration');

    expect(payload.ok).toBe(true);
    expect(configStep).toMatchObject({ status: 'ok' });
    expect(configStep?.detail).toContain('Removed legacy ClaimRegistry/request-first config field');
    expect(configStep?.detail).toContain('TaskCoordinator/JinnRouterV3');

    const migrated = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect('testnetClaimRegistryDeploymentPath' in migrated).toBe(false);
    expect('claimRegistryAddress' in migrated).toBe(false);
    const files = await readdir(earningDir);
    expect(files.some((file) => file.startsWith('config.json.bak.'))).toBe(true);
  });

  it('records legacy request-first in-flight jobs as ignored without blocking local store preflight', async () => {
    const earningDir = await makeEarningDir();
    const dbPath = path.join(earningDir, 'jinn.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE restoration_intents (
        request_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        window_start_ts INTEGER NOT NULL
      );
      INSERT INTO restoration_intents (request_id, state, window_start_ts)
      VALUES ('legacy-req-1', 'CLAIMED', 1);
    `);
    db.close();

    const cmd = makeUpdateCommand(earningDir, vi.fn(async () => {}), {
      dbPath,
      storeFactory: (path) => new Store(path),
    });
    const { envelopes } = await runCommand(cmd, { argv: ['--json', '--skip-npm', '--skip-plugins'] });
    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };

    expect(payload.ok).toBe(true);
    expect(payload.steps.find((step) => step.step === 'task-native-store')).toMatchObject({ status: 'ok' });

    const store = new Store(dbPath);
    try {
      const markerRaw = store.getConfigValue('legacy_restoration_intents_ignored_v1');
      expect(markerRaw).not.toBeNull();
      const marker = JSON.parse(markerRaw!) as { inFlightRows: number; reason: string };
      expect(marker.inFlightRows).toBe(1);
      expect(marker.reason).toBe('legacy_request_first_task_native_update');
      const events = store.getRecentActivityEvents(10);
      expect(events.some((event) =>
        event.kind === 'legacy_ignored' &&
        event.detail?.includes('legacy request-first restoration_intents row')
      )).toBe(true);
    } finally {
      store.close();
    }
  });

  it('reports partial local earning state as bootstrapping without repairing it', async () => {
    const earningDir = await makeEarningDir();
    const store = new FleetStateStore(earningDir);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: '0x9999999999999999999999999999999999999999',
      services: [
        createDefaultServiceState(1, '0x1111111111111111111111111111111111111111'),
      ],
    });

    const cmd = makeUpdateCommand(earningDir);
    const { envelopes } = await runCommand(cmd, { argv: ['--json', '--skip-npm', '--skip-plugins'] });
    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };
    const earningStep = payload.steps.find((step) => step.step === 'earning-state');

    expect(payload.ok).toBe(true);
    expect(earningStep).toMatchObject({ status: 'warning' });
    expect(earningStep?.detail).toContain('still bootstrapping');
    expect(earningStep?.detail).toContain('No chain readback or writes were performed');

    const persisted = await store.tryLoadExisting();
    expect(persisted?.services[0]).toMatchObject({
      safe_address: null,
      service_id: null,
      mech_address: null,
      agent_id: null,
    });
  });

  it('reports ready-looking local state with missing Task-native fields as state-integrity', async () => {
    const earningDir = await makeEarningDir();
    const store = new FleetStateStore(earningDir);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: '0x9999999999999999999999999999999999999999',
      services: [{
        ...completeService(),
        mech_address: null,
      }],
    });

    const cmd = makeUpdateCommand(earningDir);
    const { envelopes } = await runCommand(cmd, { argv: ['--json', '--skip-npm', '--skip-plugins'] });
    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };
    const earningStep = payload.steps.find((step) => step.step === 'earning-state');

    expect(payload.ok).toBe(false);
    expect(earningStep).toMatchObject({ status: 'state-integrity' });
    expect(earningStep?.detail).toContain('Mech');
    expect(earningStep?.detail).toContain('Run doctor/recovery');
    expect(earningStep?.detail).toContain('did not repair from RPC');
  });

  it('warns but does not fail when optional ERC-8004 metadata is not locally recorded', async () => {
    const earningDir = await makeEarningDir();
    const store = new FleetStateStore(earningDir);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: '0x9999999999999999999999999999999999999999',
      services: [{
        ...completeService(),
        agent_id: null,
        identity_registry_address: null,
      }],
    });

    const cmd = makeUpdateCommand(earningDir);
    const { envelopes } = await runCommand(cmd, { argv: ['--json', '--skip-npm', '--skip-plugins'] });
    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };
    const earningStep = payload.steps.find((step) => step.step === 'earning-state');

    expect(payload.ok).toBe(true);
    expect(earningStep).toMatchObject({ status: 'warning' });
    expect(earningStep?.detail).toContain('optional ERC-8004 metadata');
    expect(earningStep?.detail).toContain('migrate-agent-id');
    expect(earningStep?.detail).toContain('No chain readback or writes were performed');
  });

  it('reports not-bootstrapped local state without creating earning state', async () => {
    const earningDir = await makeEarningDir();
    const cmd = makeUpdateCommand(earningDir);
    const { envelopes } = await runCommand(cmd, { argv: ['--json', '--skip-npm', '--skip-plugins'] });
    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };
    const earningStep = payload.steps.find((step) => step.step === 'earning-state');

    expect(payload.ok).toBe(true);
    expect(earningStep).toMatchObject({ status: 'skipped' });
    expect(earningStep?.detail).toContain('not bootstrapped');
    expect(await new FleetStateStore(earningDir).tryLoadExisting()).toBeNull();
  });

  // #337 — clear all-good indicator after `jinn update`.
  describe('all-good success indicator', () => {
    it('formats a plain success line when stderr is not a TTY', () => {
      expect(formatUpdateSuccessLine('1.2.3', { stderrIsTty: false, noColor: false }))
        .toBe('✓ jinn updated to v1.2.3');
    });

    it('wraps the success line in ANSI green when stderr is a TTY and NO_COLOR is unset', () => {
      expect(formatUpdateSuccessLine('1.2.3', { stderrIsTty: true, noColor: false }))
        .toBe('\x1b[32m✓ jinn updated to v1.2.3\x1b[0m');
    });

    it('drops color when NO_COLOR is set even on a TTY', () => {
      expect(formatUpdateSuccessLine('1.2.3', { stderrIsTty: true, noColor: true }))
        .toBe('✓ jinn updated to v1.2.3');
    });

    it('prints the success line to stderr on the happy path', async () => {
      const earningDir = await makeEarningDir();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const cmd = makeUpdateCommand(earningDir);
        const { envelopes } = await runCommand(cmd, {
          argv: ['--json', '--skip-npm', '--skip-plugins'],
        });
        const payload = envelopes[envelopes.length - 1] as { ok: boolean };
        expect(payload.ok).toBe(true);

        const stderrText = errSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(stderrText).toMatch(/✓ jinn updated to v/);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('does not print the success line when an update step fails', async () => {
      const earningDir = await makeEarningDir();
      const store = new FleetStateStore(earningDir);
      // Trigger a state-integrity error so allOk is false.
      await store.save({
        ...createDefaultFleetState('base'),
        master_address: '0x9999999999999999999999999999999999999999',
        services: [{ ...completeService(), mech_address: null }],
      });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const cmd = makeUpdateCommand(earningDir);
        const { envelopes } = await runCommand(cmd, {
          argv: ['--json', '--skip-npm', '--skip-plugins'],
        });
        const payload = envelopes[envelopes.length - 1] as { ok: boolean };
        expect(payload.ok).toBe(false);

        const stderrText = errSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(stderrText).not.toMatch(/✓ jinn updated to v/);
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});
