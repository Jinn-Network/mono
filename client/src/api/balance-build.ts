/**
 * Balance response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.3.
 */

import type { GatheredStatusRaw } from './status-build.js';
import type { ServiceState } from '../earning/types.js';

interface BalanceEntry {
  asset: 'native' | 'bond' | 'reward';
  amountWei: string;
}

export interface WalletEntry {
  role: string;
  address: string;
  balances: BalanceEntry[];
}

export interface BalanceV1Response {
  schemaVersion: 1;
  generatedAt: string;
  wallets: WalletEntry[];
}

function displayServiceIndex(s: ServiceState): number {
  return Math.max(0, s.index - 1);
}

export function assembleBalanceV1(raw: GatheredStatusRaw): BalanceV1Response {
  const wallets: WalletEntry[] = [];
  const masterAddr = raw.fleet?.master_address ?? raw.master.address ?? '0x';

  wallets.push({
    role: 'master',
    address: masterAddr,
    balances: [{ asset: 'native', amountWei: raw.master.balanceWei ?? '0' }],
  });

  for (const svc of raw.fleet?.services ?? []) {
    const di = displayServiceIndex(svc);
    wallets.push({
      role: `service.${di}.agent`,
      address: svc.agent_address || '0x',
      balances: [{ asset: 'native', amountWei: '0' }],
    });
    wallets.push({
      role: `service.${di}.multisig`,
      address: svc.safe_address || '0x',
      balances: [
        { asset: 'native', amountWei: '0' },
        { asset: 'bond', amountWei: '0' },
      ],
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    wallets,
  };
}
