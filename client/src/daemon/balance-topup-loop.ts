/**
 * Periodic balance top-up loop for agent EOA and Safe wallets.
 *
 * Checks each complete fleet service's agent EOA and Safe balances. When either
 * drops below its trigger threshold, the master wallet tops it up to the target amount.
 * ETH is sent directly from master → agent EOA and master → Safe (plain ETH transfers).
 *
 * Scheduling: interval from config (default 5 minutes). Set to 0 to disable.
 * Env: JINN_BALANCE_TOPUP_INTERVAL_MS
 */

import type { PublicClient, WalletClient, Address } from 'viem';
import { getAddress, formatEther } from 'viem';
import type { FleetStateStore } from '../earning/store.js';
import type { Store } from '../store/store.js';
import { viemSendTransactionWithRetry, waitForTransactionReceiptWithRetry } from '../tx-retry.js';
import { emitEvent } from '../observability/emit-event.js';
import { displayFleetServiceIndex } from '../earning/fleet-display-index.js';
import { isOperationalServiceStep } from '../earning/types.js';
import { runLoop } from './loop-heartbeat.js';

export interface BalanceTopupLoopConfig {
  intervalMs: number;
  publicClient: PublicClient;
  /** Master EOA wallet — pays for all top-up transfers. */
  masterWallet: WalletClient;
  store: FleetStateStore;
  chain: 'base' | 'base-sepolia';
  /** Refill agent EOA when balance drops below this (wei). */
  eoaTopupTrigger: bigint;
  /** Refill agent EOA up to this target (wei). */
  eoaTopupTarget: bigint;
  /** Refill Safe when balance drops below this (wei). */
  safeTopupTrigger: bigint;
  /** Refill Safe up to this target (wei). */
  safeTopupTarget: bigint;
  /** When set, records last top-up tick time for GET /v1/status. */
  jinnStore?: Store;
}

export class BalanceTopupLoop {
  private stopped = false;

  constructor(private readonly config: BalanceTopupLoopConfig) {}

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<void> {
    const state = await this.config.store.load(this.config.chain);
    const masterAccount = this.config.masterWallet.account;
    if (!masterAccount) return;

    for (const svc of state.services) {
      if (!isOperationalServiceStep(svc.step)) continue;
      if (!svc.agent_address || !svc.safe_address) continue;
      const displayIndex = displayFleetServiceIndex(svc);

      try {
        await this.topUpService(
          displayIndex,
          svc.index,
          svc.agent_address,
          svc.safe_address,
          masterAccount,
        );
      } catch (err) {
        console.error(
          `[balance-topup] Service ${svc.index}: unexpected error (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
        this.config.jinnStore && emitEvent(this.config.jinnStore, {
          kind: 'tick_error',
          serviceIndex: displayIndex,
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'balance-topup');
      }
    }
  }

  private async topUpService(
    displayIndex: number,
    logIndex: number,
    agentAddressRaw: string,
    safeAddressRaw: string,
    masterAccount: NonNullable<WalletClient['account']>,
  ): Promise<void> {
    const agentAddr = getAddress(agentAddressRaw) as Address;
    const safeAddr = getAddress(safeAddressRaw) as Address;

    // Check agent EOA balance
    const agentBal = await this.config.publicClient.getBalance({ address: agentAddr });
    if (agentBal < this.config.eoaTopupTrigger) {
      const needed = this.config.eoaTopupTarget - agentBal;
      const masterBal = await this.config.publicClient.getBalance({ address: masterAccount.address });
      if (masterBal > needed) {
        console.error(
          `[balance-topup] Service ${logIndex}: agent ${agentAddr} balance ${formatEther(agentBal)} ETH below trigger, topping up with ${formatEther(needed)} ETH from master`,
        );
        const hash = await viemSendTransactionWithRetry(
          this.config.masterWallet,
          this.config.publicClient,
          {
            account: masterAccount,
            to: agentAddr,
            value: needed,
          },
        );
        await waitForTransactionReceiptWithRetry(this.config.publicClient, hash);
        this.config.jinnStore && emitEvent(this.config.jinnStore, {
          kind: 'balance_topup',
          serviceIndex: displayIndex,
          txHash: hash,
          outcome: 'ok',
          detail: `Topped up agent to ${formatEther(this.config.eoaTopupTarget)} ETH`,
        }, 'balance-topup');
      } else {
        console.error(
          `[balance-topup] Warning: master balance (${formatEther(masterBal)} ETH) too low to top up agent ${agentAddr} (needs ${formatEther(needed)} ETH)`,
        );
      }
    }

    // Check Safe balance — master funds the Safe directly (plain ETH transfer)
    const safeBal = await this.config.publicClient.getBalance({ address: safeAddr });
    if (safeBal < this.config.safeTopupTrigger) {
      const safeNeeded = this.config.safeTopupTarget - safeBal;
      const masterBal = await this.config.publicClient.getBalance({ address: masterAccount.address });
      if (masterBal > safeNeeded) {
        console.error(
          `[balance-topup] Service ${logIndex}: Safe ${safeAddr} balance ${formatEther(safeBal)} ETH below trigger, topping up with ${formatEther(safeNeeded)} ETH from master`,
        );
        const hash = await viemSendTransactionWithRetry(
          this.config.masterWallet,
          this.config.publicClient,
          {
            account: masterAccount,
            to: safeAddr,
            value: safeNeeded,
          },
        );
        await waitForTransactionReceiptWithRetry(this.config.publicClient, hash);
        this.config.jinnStore && emitEvent(this.config.jinnStore, {
          kind: 'balance_topup',
          serviceIndex: displayIndex,
          txHash: hash,
          outcome: 'ok',
          detail: `Topped up safe to ${formatEther(this.config.safeTopupTarget)} ETH`,
        }, 'balance-topup');
      } else {
        console.error(
          `[balance-topup] Warning: master balance (${formatEther(masterBal)} ETH) too low to top up Safe ${safeAddr} (needs ${formatEther(safeNeeded)} ETH)`,
        );
      }
    }
  }

  async run(): Promise<void> {
    if (this.config.intervalMs <= 0) {
      return;
    }

    const jinnStore = this.config.jinnStore;
    if (!jinnStore) {
      // Without a Store there is no heartbeat surface; keep the minimal inline
      // loop so runLoop's always-stamp behavior can't fire without a store.
      while (!this.stopped) {
        try {
          await this.runOnce();
        } catch (err) {
          console.error('[balance-topup] Tick failed (non-fatal):', err instanceof Error ? err.message : err);
        }
        await new Promise(r => setTimeout(r, this.config.intervalMs));
      }
      return;
    }

    await runLoop({
      name: 'balance-topup',
      store: jinnStore,
      tick: () => this.runOnce(),
      intervalMs: this.config.intervalMs,
      stopSignal: () => this.stopped,
      emitSource: 'balance-topup',
      onError: (err) => {
        console.error('[balance-topup] Tick failed (non-fatal):', err instanceof Error ? err.message : err);
        emitEvent(jinnStore, {
          kind: 'tick_error',
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'balance-topup');
      },
      afterTick: () => jinnStore.setConfigValue('last_balance_topup_tick_at', new Date().toISOString()),
    });
  }
}
