/**
 * #4825 — `stepSelfBondSetup`'s agent-ETH gate was a hand-rolled five-attempt
 * poll. Replacing it with the shared `waitForNativeBalanceAtLeast` has two
 * properties that are silently reversible and therefore pinned here:
 *
 * 1. the observed post-wait balance stays bound — step 4's Safe auto-top-up
 *    computes `eoaAvailable = agentBalanceAfter - minEoaGasEth`, so dropping
 *    the binding would zero it and silently skip the top-up;
 * 2. the service index survives into the operator-facing message — the shared
 *    helper's own message names only the address, and in a fleet "which
 *    service" is the first question an operator asks.
 *
 * No existing suite drives `stepSelfBondSetup`, hence a new file. The
 * bootstrapper is pointed at the in-process fake JSON-RPC boundary so the real
 * wait and the real transfer path execute.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress, parseTransaction, type Hex } from 'viem';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  deriveAgentAddress,
  deriveMasterAddress,
  generateMnemonic,
} from '../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../src/earning/types.js';
import { startFakeRpc, type FakeRpc } from '../_support/chain/fake-rpc.js';

/** base-sepolia chain config. */
const MIN_EOA_GAS = 5_000_000_000_000_000n;
const MIN_SAFE_ETH = 2_000_000_000_000_000n;
/** `SELF_BOND_AGENT_ETH` in `stepSelfBondSetup`. */
const REQUIRED_AGENT_ETH = 25_000_000_000_000_000n;
const SAFE_ADDRESS = '0x2222222222222222222222222222222222222222';

describe('stepSelfBondSetup agent-ETH balance wait', () => {
  const dirs: string[] = [];
  const servers: FakeRpc[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function setup(balanceFor: (address: string) => bigint): Promise<{
    bootstrapper: FleetBootstrapper;
    store: FleetStateStore;
    fake: FakeRpc;
    sends: Array<{ to: string; value: bigint }>;
    agentAddress: string;
    mnemonic: string;
  }> {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-self-bond-wait-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const agentAddress = deriveAgentAddress(mnemonic, 1);

    const store = new FleetStateStore(earningDir);
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      master_address: deriveMasterAddress(mnemonic),
      staking_mode: 'self-bond',
      services: [
        {
          index: 1,
          agent_address: agentAddress,
          safe_address: SAFE_ADDRESS,
          service_id: null,
          mech_address: null,
          staking_address: null,
          step: 'awaiting_stake',
          error: null,
          agent_id: null,
          agent_uri: null,
          identity_registry_address: null,
          agent_registered_tx: null,
          safe_bound_to_agent: false,
          error_revert_reason: null,
          error_short_message: null,
        },
      ],
    });

    const sends: Array<{ to: string; value: bigint }> = [];
    const fake = await startFakeRpc({
      eth_getBalance: (params: unknown[]) => `0x${balanceFor(String(params[0])).toString(16)}`,
      eth_sendRawTransaction: (params: unknown[]) => {
        // Record the transfer target and value off the signed envelope.
        sends.push(decodeTransfer(String(params[0])));
        return `0x${(sends.length).toString(16).padStart(64, '0')}`;
      },
    });
    servers.push(fake);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: fake.url,
      stakingMode: 'self-bond',
    });
    // MOCK_JUSTIFICATION: the OLAS bond-token read is an ERC-20 `eth_call`
    // the fake answers with `0x`, which viem cannot decode. Stubbing the one
    // private reader keeps the fence under test — every balance, transfer and
    // wait below it — on the real path.
    vi.spyOn(bootstrapper as any, 'getBondTokenBalance').mockResolvedValue(
      10n ** 30n,
    );

    return { bootstrapper, store, fake, sends, agentAddress, mnemonic };
  }

  it('keeps the observed post-wait balance for the Safe auto-top-up arithmetic', async () => {
    // Agent already at the target so the funding branch is skipped and the
    // wait's first read is the one that matters; Safe empty so the top-up
    // fires — but only if `agentBalanceAfter` survived, since
    // `eoaAvailable = agentBalanceAfter - minEoaGasEth` gates it.
    const safe = getAddress(SAFE_ADDRESS).toLowerCase();
    const { bootstrapper, store, sends, mnemonic } = await setup((address) =>
      address.toLowerCase() === safe ? 0n : REQUIRED_AGENT_ETH,
    );

    const state = await store.load('base-sepolia');
    await (bootstrapper as any).stepSelfBondSetup(state, mnemonic, 1);

    expect(sends).toHaveLength(1);
    expect(sends[0]!.to.toLowerCase()).toBe(safe);
    expect(sends[0]!.value).toBe(MIN_SAFE_ETH);
    expect(REQUIRED_AGENT_ETH - MIN_EOA_GAS).toBeGreaterThanOrEqual(MIN_SAFE_ETH);
  }, 30_000);

  it('names the service when the agent balance never reaches the self-bond target', async () => {
    const { bootstrapper, store, agentAddress, mnemonic } = await setup(
      () => REQUIRED_AGENT_ETH - 1n,
    );

    const state = await store.load('base-sepolia');
    // The index prefix AND the helper's own text: that text carries the
    // balance actually observed, which is what an operator needs to tell
    // "nothing landed" from "landed, target slightly short".
    await expect((bootstrapper as any).stepSelfBondSetup(state, mnemonic, 1))
      .rejects.toThrow(new RegExp(`Service 1:.*${agentAddress}.*${REQUIRED_AGENT_ETH - 1n} wei`));
  }, 30_000);
});

/** `to` and `value` of a signed envelope, via viem's own parser. */
function decodeTransfer(raw: string): { to: string; value: bigint } {
  const tx = parseTransaction(raw as Hex);
  return { to: tx.to ?? '', value: tx.value ?? 0n };
}
