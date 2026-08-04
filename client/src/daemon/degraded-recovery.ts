/**
 * Degrade-open recovery loops (issue #2407, spec §5/§11).
 *
 * When bootstrap halts on an economic-class cause (funding shortfall,
 * incomplete fleet, a recoverable on-chain error mid-step) while the
 * operator may already have an operational fleet on disk, the daemon must
 * not sit fully dark until the halt resolves — the eviction/checkpoint/
 * balance-topup/reward-claim loops for whatever part of the fleet IS
 * already operational must keep running, so a self-healing economic
 * condition (an eviction, a low balance, an unclaimed reward) doesn't
 * compound while the halted step is retried. This ratifies
 * `earning/bootstrap.ts`'s existing #773/#789/#917 decision (never an
 * inline boot-time broadcast; eviction recovery belongs to the running
 * eviction loop) rather than reversing it.
 *
 * This is a standalone runner, not the full `Daemon` class: `Daemon`'s
 * construction needs `mechAddress`/`safeAddress`/`composition`/`adapter`
 * resolved from a COMPLETED bootstrap, none of which exist mid-halt. Each
 * of these four loop classes is independently self-sufficient — they load
 * `FleetStateStore` fresh every tick and iterate whatever operational
 * services already exist — so they run standalone against just a
 * publicClient/masterWallet/FleetStateStore, with zero services simply
 * meaning "nothing to do this tick," not a construction error.
 *
 * `creator` / `engine-tick` / `work` (the claim/work path, `admission:
 * 'ready-only'` per `daemon/loop-heartbeat.ts`) are deliberately NEVER
 * constructed here — they need the adapter/composition machinery that
 * doesn't exist pre-bootstrap. Ready-only stays off by construction, not
 * by a runtime admission check (this module doesn't import those loop
 * classes at all).
 */
import { getAddress, type PublicClient, type WalletClient } from 'viem';
import type { ChainConfig } from '../earning/contracts.js';
import { FleetStateStore } from '../earning/store.js';
import type { JinnOnchainNetwork } from '../earning/viem-clients.js';
import type { Store } from '../store/store.js';
import { withEoaBroadcastLock } from '../tx-retry.js';
import { EvictionLoop } from './eviction-loop.js';
import { CheckpointLoop } from './checkpoint-loop.js';
import { BalanceTopupLoop } from './balance-topup-loop.js';
import { RewardClaimLoop } from './reward-claim-loop.js';
import { recoverEvictedService as recoverEvictedServiceFn } from '../earning/bootstrap.js';

export interface DegradedRecoveryDeps {
  earningDir: string;
  network: JinnOnchainNetwork;
  publicClient: PublicClient;
  masterWallet: WalletClient;
  /** Decrypted master mnemonic — needed by `recoverEvictedServiceFn`, which derives its own signer. */
  mnemonic: string;
  rpcUrl: string;
  chainConfig: Pick<
    ChainConfig,
    'distributorAddress' | 'eoaTopupTrigger' | 'minEoaGasEth' | 'safeTopupTrigger' | 'minSafeEth'
  >;
  intervals: {
    evictionCheckIntervalMs: number;
    checkpointIntervalMs: number;
    balanceTopupIntervalMs: number;
    rewardClaimIntervalMs: number;
  };
  stakingMode: 'standard' | 'self-bond';
  /** Daemon observability store for loop heartbeats; omit in tests with no Store. */
  jinnStore?: Store;
}

export interface DegradedRecoveryHandle {
  /**
   * Signals every running loop to stop. Deliberately fire-and-forget (does
   * NOT await the loops' `.run()` promises settling): `EvictionLoop` and
   * `CheckpointLoop` only check their stop flag at the top of each
   * iteration, so awaiting them here could block a bootstrap-retry
   * transition for up to their full interval (5 min for checkpoint). A
   * brief overlap between a stopped degraded-mode loop finishing its
   * current tick and the freshly-constructed full `Daemon`'s own loop
   * starting is bounded and self-correcting (both read fresh fleet state
   * every tick; `withEoaBroadcastLock` already serializes actual sends
   * from the same EOA regardless of which loop instance calls it).
   */
  stop(): void;
}

const CHECKPOINT_ABI = [
  {
    type: 'function',
    name: 'checkpoint',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const;

export function startDegradedRecoveryLoops(deps: DegradedRecoveryDeps): DegradedRecoveryHandle {
  const store = new FleetStateStore(deps.earningDir);
  const masterAccount = deps.masterWallet.account;
  const runners: Array<{ run: () => Promise<void>; stop: () => void }> = [];

  if (
    deps.intervals.evictionCheckIntervalMs > 0 &&
    deps.stakingMode === 'standard' &&
    deps.chainConfig.distributorAddress
  ) {
    const distributorAddress = deps.chainConfig.distributorAddress;
    runners.push(
      new EvictionLoop({
        intervalMs: deps.intervals.evictionCheckIntervalMs,
        reStakeThrottleMs: deps.intervals.checkpointIntervalMs,
        store,
        chain: deps.network,
        readContract: (opts) =>
          deps.publicClient.readContract(opts as Parameters<typeof deps.publicClient.readContract>[0]) as Promise<bigint>,
        recoverEvictedService: async (svc) => {
          if (!svc.service_id || !svc.staking_address) return;
          await recoverEvictedServiceFn({
            serviceDisplayIndex: Math.max(0, svc.index - 1),
            serviceId: svc.service_id,
            stakingAddress: svc.staking_address,
            distributorAddress,
            rpcUrl: deps.rpcUrl,
            chain: deps.network,
            mnemonic: deps.mnemonic,
          });
        },
        jinnStore: deps.jinnStore,
      }),
    );
  }

  if (deps.intervals.checkpointIntervalMs > 0 && deps.stakingMode === 'standard' && masterAccount) {
    runners.push(
      new CheckpointLoop({
        intervalMs: deps.intervals.checkpointIntervalMs,
        store,
        chain: deps.network,
        writeCheckpoint: async ({ stakingProxy }) => {
          const txHash = await withEoaBroadcastLock(getAddress(masterAccount.address), () =>
            deps.masterWallet.writeContract({
              address: stakingProxy,
              abi: CHECKPOINT_ABI,
              functionName: 'checkpoint',
              account: masterAccount,
              chain: null,
            }),
          );
          return { txHash };
        },
        jinnStore: deps.jinnStore,
      }),
    );
  }

  if (deps.intervals.balanceTopupIntervalMs > 0) {
    runners.push(
      new BalanceTopupLoop({
        intervalMs: deps.intervals.balanceTopupIntervalMs,
        publicClient: deps.publicClient,
        masterWallet: deps.masterWallet,
        store,
        chain: deps.network,
        eoaTopupTrigger: deps.chainConfig.eoaTopupTrigger,
        eoaTopupTarget: deps.chainConfig.minEoaGasEth,
        safeTopupTrigger: deps.chainConfig.safeTopupTrigger,
        safeTopupTarget: deps.chainConfig.minSafeEth,
        jinnStore: deps.jinnStore,
      }),
    );
  }

  if (deps.intervals.rewardClaimIntervalMs > 0) {
    runners.push(
      new RewardClaimLoop({
        intervalMs: deps.intervals.rewardClaimIntervalMs,
        publicClient: deps.publicClient,
        masterWallet: deps.masterWallet,
        store,
        chain: deps.network,
        distributorAddress: deps.chainConfig.distributorAddress,
        jinnStore: deps.jinnStore,
      }),
    );
  }

  for (const runner of runners) {
    void runner.run().catch((err) => {
      console.error(
        '[degraded-recovery] loop crashed (non-fatal — the full Daemon will construct a fresh instance once bootstrap completes):',
        err instanceof Error ? err.message : err,
      );
    });
  }

  return {
    stop(): void {
      for (const runner of runners) runner.stop();
    },
  };
}
