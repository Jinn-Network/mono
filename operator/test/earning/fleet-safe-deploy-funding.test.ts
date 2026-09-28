/**
 * Pins the agent-EOA balance fence at its call site (#4827).
 *
 * `operator/test/tx-retry.test.ts` covers `waitForNativeBalanceAtLeast` in
 * isolation, and every other `stepFleetSafeDeploy` test stubs the step out
 * entirely. That leaves two things a later edit could silently break: the one
 * arithmetic choice — the wait targets `agentFundingWei`, the *post-transfer*
 * balance, not `fundAmount`, the delta — and the ordering, which only helps if
 * the fence sits between the funding receipt and the Safe factory call.
 *
 * These cases drive the real step through `ensureRequesterSafe`, mocking only
 * the chain-touching seams.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  sendTx: vi.fn(),
  waitReceipt: vi.fn(),
  waitBalance: vi.fn(),
  waitCode: vi.fn(),
  initSafe: vi.fn(),
  events: [] as string[],
}));

// MOCK_JUSTIFICATION: these four helpers are the step's only chain-touching
// boundary, and `stepFleetSafeDeploy` imports them directly with no DI seam.
// Mocking them is what makes the fence's arguments and ordering observable —
// the subject under test here. The helpers' own behaviour is covered in
// `test/tx-retry.test.ts`.
vi.mock('../../src/tx-retry.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/tx-retry.js')>()),
  viemSendTransactionWithRetry: seams.sendTx,
  waitForTransactionReceiptWithRetry: seams.waitReceipt,
  waitForNativeBalanceAtLeast: seams.waitBalance,
  waitForContractCode: seams.waitCode,
}));

// MOCK_JUSTIFICATION: `initPredictedSafe` drives the Safe SDK against a live
// RPC. It stands in as the Safe-factory boundary whose ordering relative to
// the fence is being pinned.
vi.mock('../../src/earning/safe-adapter.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/earning/safe-adapter.js')>()),
  initPredictedSafe: seams.initSafe,
}));

// MOCK_JUSTIFICATION: `createJinnWalletClient` opens an RPC transport. The
// returned client is only ever handed to the mocked send helper above, so a
// bare object suffices; `createJinnPublicClient` is left real and spied.
vi.mock('../../src/earning/viem-clients.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/earning/viem-clients.js')>()),
  createJinnWalletClient: vi.fn(() => ({})),
}));

const { FleetBootstrapper } = await import('../../src/earning/bootstrap.js');
const { FleetStateStore } = await import('../../src/earning/store.js');
const { REQUESTER_SAFE_DEPLOY_ETH, requesterMinMasterEth } = await import(
  '../../src/earning/requester-init.js'
);
const { deriveAgentAddress, encryptMnemonic, generateMnemonic } = await import(
  '../../src/earning/wallet.js'
);

const PREDICTED_SAFE = '0xBBBB000000000000000000000000000000000003';
const DEPLOY_TARGET = '0xCCCC000000000000000000000000000000000004';
const FUND_TX = '0xf00d';
const DEPLOY_TX = '0xdeploy';

/** Agent EOA starts with a quarter of the target, so delta ≠ target. */
const AGENT_STARTING_WEI = REQUESTER_SAFE_DEPLOY_ETH / 4n;
const EXPECTED_FUND_DELTA = REQUESTER_SAFE_DEPLOY_ETH - AGENT_STARTING_WEI;

describe('stepFleetSafeDeploy — agent-EOA balance fence (#4827)', () => {
  const dirs: string[] = [];

  async function buildScenario() {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-4827-'));
    dirs.push(earningDir);
    const mnemonic = generateMnemonic();
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, 'test-password'));
    await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });
    const agentAddress = getAddress(deriveAgentAddress(mnemonic, 1));

    // Master clears the requester gate; the agent EOA is partially funded.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockImplementation(
      async ({ address }: { address: string }) =>
        getAddress(address) === agentAddress ? AGENT_STARTING_WEI : requesterMinMasterEth(),
    );
    // Safe not yet deployed, so the deploy branch runs.
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0x');

    return { bootstrapper, agentAddress };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    seams.events.length = 0;
    seams.sendTx.mockReset();
    seams.waitReceipt.mockReset();
    seams.waitBalance.mockReset();
    seams.waitCode.mockReset();
    seams.initSafe.mockReset();

    seams.sendTx.mockImplementation(async (_wallet: unknown, _client: unknown, tx: any) => {
      const isDeploy = tx.data !== undefined;
      seams.events.push(isDeploy ? 'send:deploy' : 'send:fund');
      return isDeploy ? DEPLOY_TX : FUND_TX;
    });
    seams.waitReceipt.mockImplementation(async (_client: unknown, hash: string) => {
      seams.events.push(hash === DEPLOY_TX ? 'receipt:deploy' : 'receipt:fund');
      return { status: 'success' };
    });
    seams.waitBalance.mockImplementation(async () => {
      seams.events.push('wait-balance');
      return REQUESTER_SAFE_DEPLOY_ETH;
    });
    seams.waitCode.mockResolvedValue('0xdeadbeef');
    seams.initSafe.mockImplementation(async () => {
      seams.events.push('init-safe');
      return {
        safe: {
          createSafeDeploymentTransaction: async () => ({
            to: DEPLOY_TARGET,
            value: '0',
            data: '0xabcdef',
          }),
        },
      };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('waits on the post-transfer target, after the funding receipt and before the factory call', async () => {
    const { bootstrapper, agentAddress } = await buildScenario();

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.ok).toBe(true);
    expect(seams.events).toEqual([
      'send:fund',
      'receipt:fund',
      'wait-balance',
      'init-safe',
      'send:deploy',
      'receipt:deploy',
    ]);

    // The transfer moves the delta; the fence waits on the resulting balance.
    expect(seams.sendTx.mock.calls[0]![2].value).toBe(EXPECTED_FUND_DELTA);
    expect(seams.waitBalance).toHaveBeenCalledTimes(1);
    const [, waitedAddress, waitedMin] = seams.waitBalance.mock.calls[0]!;
    expect(waitedAddress).toBe(agentAddress);
    expect(waitedMin).toBe(REQUESTER_SAFE_DEPLOY_ETH);
    expect(waitedMin).not.toBe(EXPECTED_FUND_DELTA);
  });

  it('surfaces an exhausted wait as an ok:false envelope, never deploying', async () => {
    const { bootstrapper, agentAddress } = await buildScenario();
    seams.waitBalance.mockImplementation(async () => {
      seams.events.push('wait-balance');
      throw new Error(
        `Balance at ${agentAddress} is 0 wei after 6 getBalance attempts; ` +
          `need ${REQUESTER_SAFE_DEPLOY_ETH.toString()} wei`,
      );
    });

    const result = await bootstrapper.ensureRequesterSafe('test-password');

    expect(result.ok).toBe(false);
    expect(result.rawErrorMessage).toContain('getBalance attempts');
    expect(seams.initSafe).not.toHaveBeenCalled();
    expect(seams.events).toEqual(['send:fund', 'receipt:fund', 'wait-balance']);
    expect(result.fleet_state.requester_stage).toBe('none');
  });
});
