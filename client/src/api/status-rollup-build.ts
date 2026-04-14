/**
 * Slim `jinn status` roll-up from GatheredStatusRaw.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.1.
 */

import type { GatheredStatusRaw } from './status-build.js';

export interface StatusRollupV1Response {
  schemaVersion: 1;
  generatedAt: string;
  daemon: {
    state: 'running' | 'stopped' | 'starting';
    startedAt: string | null;
    phase: string;
    network: 'testnet' | 'mainnet';
  };
  rpc: { ok: boolean; chainId: number; blockNumber: number; error?: string };
  fleet: { size: number; complete: number; needsAttention: number };
  earnings: { pendingTotal: string; asset: 'reward' };
  exit: { blocking: boolean; hint: string | null };
}

function daemonState(shutdown: string | null): 'running' | 'stopped' | 'starting' {
  if (shutdown === 'running') return 'running';
  return 'stopped';
}

export function assembleStatusRollupV1(raw: GatheredStatusRaw): StatusRollupV1Response {
  const services = raw.fleet?.services ?? [];
  const complete = services.filter(s => s.step === 'complete').length;
  const needsAttention = services.length - complete;
  const network: 'testnet' | 'mainnet' =
    raw.fleet?.chain === 'base' ? 'mainnet' : 'testnet';
  const phase = network === 'testnet' ? 'phase-1b' : 'phase-2';

  const blockStr = raw.rpc.blockNumber ?? '0';
  const blockNumber = Number(blockStr);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    daemon: {
      state: daemonState(raw.shutdownState),
      startedAt: null,
      phase,
      network,
    },
    rpc: {
      ok: raw.rpc.ok,
      chainId: raw.rpc.chainId ?? 0,
      blockNumber: Number.isFinite(blockNumber) ? blockNumber : 0,
      ...(raw.rpc.error ? { error: raw.rpc.error } : {}),
    },
    fleet: {
      size: services.length,
      complete,
      needsAttention,
    },
    earnings: {
      pendingTotal: raw.pendingStakingRewardsWei ?? '0',
      asset: 'reward',
    },
    exit: {
      blocking: false,
      hint: needsAttention > 0 ? 'Run `jinn fleet` for per-service detail.' : null,
    },
  };
}
