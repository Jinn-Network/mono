import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  deriveAgentAddress,
} from '../../src/earning/wallet.js';

const PREDICTED_SAFE = '0xBBBB000000000000000000000000000000000001';
const FLEET_AGENT_ID = '1234';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

function buildBootstrapper(earningDir: string): FleetBootstrapper {
  return new FleetBootstrapper({
    earningDir,
    chain: 'base',
    rpcUrl: 'http://127.0.0.1:8545',
    stakingMode: 'standard',
  });
}

describe('FleetBootstrapper.ensureStage1 — greenfield walk (nghf)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('pauses at ETH funding when agent EOA balance is 0 (no OLAS required)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const bootstrapper = buildBootstrapper(earningDir);

    // 0 balance on every getBalance call (master + agent EOA).
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    // Stage 1 funding gate is ETH-only.
    expect(result.message.toLowerCase()).toContain('eth');
    expect(result.fleet_state.fleet_stage).toBe('none');
    expect(result.fleet_state.services).toEqual([]);
  });

  it('walks wallet → predict Safe → deploy Safe → mint → bind, ending at fleet_stage="stage1"', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = buildBootstrapper(earningDir);

    // Sufficient ETH balance for Stage 1.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n, // 0.05 ETH
    );
    // Safe code lookup returns "0x" (not yet deployed) on the first call,
    // and bytecode after stepFleetSafeDeploy ran.
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );

    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(result.fleet_state.fleet_agent_id).toBe(FLEET_AGENT_ID);
    expect(result.fleet_state.fleet_safe_address).toBe(PREDICTED_SAFE);
    expect(result.fleet_state.fleet_identity_registry).toBe(IDENTITY_REGISTRY);
    // No service rows created by Stage 1.
    expect(result.fleet_state.services).toEqual([]);

    // Predict + deploy + register each called exactly once.
    expect((bootstrapper as any).stepFleetSafePredict).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepFleetSafeDeploy).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepFleetIdentityRegister).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — re-running ensureStage1 after stage1 is complete is a no-op', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);
    await store.patchFleet({
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: PREDICTED_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1',
    });

    const bootstrapper = buildBootstrapper(earningDir);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    const deploySpy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy');
    const registerSpy = vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister');

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(predictSpy).not.toHaveBeenCalled();
    expect(deploySpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('resumes from mid-Stage-1 (Safe predicted but not deployed)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);
    await store.patchFleet({
      fleet_safe_address: PREDICTED_SAFE,
      fleet_stage: 'none',
    });

    const bootstrapper = buildBootstrapper(earningDir);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0x'); // not deployed

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => store.load('base'));
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    // Predict was skipped (already had fleet_safe_address).
    expect(predictSpy).not.toHaveBeenCalled();
    expect((bootstrapper as any).stepFleetSafeDeploy).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepFleetIdentityRegister).toHaveBeenCalledTimes(1);
  });

  it('rejects funding at the gate when master has only enough for Stage 1 transfer (jinn-mono-u34i)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-u34i-stage1-'));
    dirs.push(earningDir);
    const bootstrapper = buildBootstrapper(earningDir);
    // 0.011 ETH on the master — above the pre-u34i 0.010 ETH gate (which
    // equaled the transfer amount → zero gas headroom → revert), and BELOW
    // the new full-bootstrap budget of 0.020 ETH. Pre-fix this either
    // halted in the funding tx OR halted at Stage 2's separate gate after
    // Stage 1 succeeded. Now the daemon refuses to even enter Stage 1
    // until the operator funds the whole bootstrap up front.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      11_000_000_000_000_000n, // 0.011 ETH
    );
    const result = await bootstrapper.ensureStage1('test-password');
    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    expect(result.message.toLowerCase()).toContain('eth');
    expect(result.fleet_state.fleet_stage).toBe('none');
  });

  it('rejects funding at the gate when master is one wei below the full-bootstrap budget (jinn-mono-u34i boundary)', async () => {
    // Boundary test for the new full-bootstrap gate: STAGE1_AGENT_ETH (0.010)
    // + minEoaGasEth*2 (0.010) = 0.020 ETH for N=1. Below this by even one
    // wei must be rejected — otherwise Stage 1 would succeed, drain master
    // to (gate - STAGE1_AGENT_ETH - 1 wei = 0.010 - 1 wei), and Stage 2's
    // existing gate (also 0.010) would re-prompt. The whole point of bumping
    // Stage 1's gate is that this scenario can never reach Stage 2 with
    // insufficient master ETH.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-u34i-stage1-'));
    dirs.push(earningDir);
    const bootstrapper = buildBootstrapper(earningDir);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      20_000_000_000_000_000n - 1n, // 0.020 ETH minus one wei
    );
    const result = await bootstrapper.ensureStage1('test-password');
    expect(result.ok).toBe(false);
    expect(result.funding?.eth_required).toBe('1'); // shortfall = exactly 1 wei
  });

  it('accepts funding when master has the full-bootstrap budget (jinn-mono-u34i one-shot funding)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-u34i-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = buildBootstrapper(earningDir);

    // Exactly 0.020 ETH — the full-bootstrap budget for N=1 standard mode.
    // After Stage 1 transfers 0.010 ETH to HD-1, master sits at 0.010 ETH
    // which exactly satisfies Stage 2's existing 0.010 ETH gate. End result:
    // operator funds once, daemon completes both stages without re-prompting.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      20_000_000_000_000_000n, // 0.020 ETH
    );
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );
    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
  });

  it('Stage 1 ignores OLAS balances entirely', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = buildBootstrapper(earningDir);
    // Plenty of ETH everywhere.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    // Safe code: "0x" first call (predict), bytecode after deploy.
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );

    // The contract surface that would read OLAS balance: getBondTokenBalance.
    // Spy on it; assert it is NEVER called from ensureStage1.
    const olasSpy = vi
      .spyOn(bootstrapper as any, 'getBondTokenBalance')
      .mockResolvedValue(0n);

    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(olasSpy).not.toHaveBeenCalled();
  });

  // ── Stage 1 setAgentWallet retry (jinn-mono-k1ng) ────────────────────────
  //
  // The freshly-deployed-Safe race: against a fresh 1/1 Safe on Base Sepolia,
  // the first setAgentWallet attempt reverts with "Execution reverted for an
  // unknown reason"; the same Safe + agentId a few seconds later succeeds.
  //
  // CRITICAL: bindAgentWalletToSafe RETURNS `{ ok: false, error }` for this
  // race — it does NOT throw. The h74p retry only caught throws, so it was
  // dead code in production. Per-service "worked" via the `safe_binding_pending`
  // resume safety net; Stage 1 had no such net, so a single `ok: false`
  // halted bootstrap (the 2026-05-18 canary's second-time-around failure).
  //
  // These tests use `mockResolvedValueOnce({ ok: false, ... })` — matching
  // production behavior — to assert the unified bindAgentWalletWithRetry
  // helper actually retries. mockRejectedValueOnce (what h74p used) is
  // documented as the OTHER path the retry handles, but is NOT how the race
  // actually manifests.
  it('Stage 1 setAgentWallet retries on ok:false (production race shape) and succeeds (jinn-mono-k1ng)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-k1ng-stage1-bind-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    // Pre-seed predicted Safe so stepFleetSafeDeploy can be skipped via mock.
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      // Fast retry delay so the test doesn't burn seconds.
      safeBindingRetryDelayMs: 0,
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n, // 0.05 ETH — well above any gate
    );
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );

    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });

    // Mock the on-chain register tx so we can drive stepFleetIdentityRegister
    // all the way to the bind step (which is what we're actually testing).
    const txMod = await import('../../src/tx-retry.js');
    vi.spyOn(txMod, 'viemSendTransactionWithRetry').mockResolvedValue(
      ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    );
    vi.spyOn(txMod, 'waitForTransactionReceiptWithRetry').mockResolvedValue({
      status: 'success',
      logs: [],
    } as any);
    vi.spyOn(bootstrapper as any, 'parseAgentIdFromReceipt').mockReturnValue(FLEET_AGENT_ID);

    // Bind: two transient `ok: false` (the production race), then success.
    // This is what bindAgentWalletToSafe ACTUALLY returns on Sepolia.
    const bindingMod = await import('../../src/earning/agent-wallet-binding.js');
    const bindSpy = vi
      .spyOn(bindingMod, 'bindAgentWalletToSafe')
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: 'safe_binding_failed',
          message: 'Execution reverted for an unknown reason.',
          shortMessage: 'Execution reverted for an unknown reason.',
          revertReason: null,
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: 'safe_binding_failed',
          message: 'Execution reverted for an unknown reason.',
          shortMessage: 'Execution reverted for an unknown reason.',
          revertReason: null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        txHash: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
        identityDigest: ('0x' + '11'.repeat(32)) as `0x${string}`,
        safeMessageHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
        signature: ('0x' + '33'.repeat(65)) as `0x${string}`,
        deadline: 9_999_999_999n,
      });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(bindSpy).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(result.fleet_state.fleet_agent_id).toBe(FLEET_AGENT_ID);
  });

  it('Stage 1 setAgentWallet halts after maxAttempts when ok:false persists (jinn-mono-k1ng)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-k1ng-stage1-bind-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      safeBindingRetryDelayMs: 0,
      safeBindingMaxAttempts: 2, // small budget so the test exits fast
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    const txMod = await import('../../src/tx-retry.js');
    vi.spyOn(txMod, 'viemSendTransactionWithRetry').mockResolvedValue(
      ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    );
    vi.spyOn(txMod, 'waitForTransactionReceiptWithRetry').mockResolvedValue({
      status: 'success',
      logs: [],
    } as any);
    vi.spyOn(bootstrapper as any, 'parseAgentIdFromReceipt').mockReturnValue(FLEET_AGENT_ID);

    // All attempts return ok:false — deterministic revert, no transient.
    const bindingMod = await import('../../src/earning/agent-wallet-binding.js');
    const bindSpy = vi.spyOn(bindingMod, 'bindAgentWalletToSafe').mockResolvedValue({
      ok: false,
      error: {
        kind: 'safe_binding_failed',
        message: 'deterministic revert',
        shortMessage: 'deterministic revert',
        revertReason: 'NotAuthorized',
      },
    });

    const result = await bootstrapper.ensureStage1('test-password');

    // After maxAttempts (2) all returning ok:false, Stage 1 halts with
    // a structured error. Bootstrap surfaces the failure with the actual
    // revert reason (operator can see "NotAuthorized" instead of a generic
    // OOG-shaped message).
    expect(bindSpy).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Fleet setAgentWallet failed');
    expect(result.rawErrorMessage ?? '').toContain('NotAuthorized');
  });
});
