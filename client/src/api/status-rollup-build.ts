/**
 * Slim `jinn status` roll-up from GatheredStatusRaw.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.1.
 */

import type { GatheredStatusRaw } from './status-build.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let versionCommitCache: { version: string; commit: string } | null = null;

export interface StatusRollupV1Response {
  schemaVersion: 1;
  generatedAt: string;
  daemon: {
    state: 'running' | 'stopped' | 'starting';
    startedAt: string | null;
    phase: string;
    network: 'testnet' | 'mainnet';
    version?: string;
    commit?: string;
  };
  rpc: { ok: boolean; chainId: number; blockNumber: number; error?: string };
  fleet: { size: number; complete: number; needsAttention: number };
  earnings: { pendingTotal: string; asset: 'reward' };
  paths: { earningDir: string | null; dbPath: string };
  exit: { blocking: boolean; hint: string | null };
}

function daemonState(shutdown: string | null): 'running' | 'stopped' | 'starting' {
  if (shutdown === 'running') return 'running';
  return 'stopped';
}

function buildExitRollup(
  raw: GatheredStatusRaw,
  needsAttention: number,
): { blocking: boolean; hint: string | null } {
  if (!raw.rpc.ok) {
    return { blocking: true, hint: raw.rpc.error ?? 'RPC unhealthy.' };
  }
  if (needsAttention > 0) {
    return { blocking: true, hint: 'Run `jinn fleet` for per-service detail.' };
  }
  if (raw.minMasterEthWei && raw.master.balanceWei) {
    try {
      if (BigInt(raw.master.balanceWei) < BigInt(raw.minMasterEthWei)) {
        return {
          blocking: false,
          hint: 'Master ETH runway is low; top up the master wallet soon.',
        };
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return { blocking: false, hint: null };
}

function readVersionCommit(): { version: string; commit: string } {
  if (versionCommitCache) {
    return versionCommitCache;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  let version = '0.0.0';
  let commit = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')) as { version?: string };
    version = pkg.version ?? version;
  } catch { /* */ }
  try {
    const meta = JSON.parse(readFileSync(join(here, '..', 'build-meta.json'), 'utf-8')) as { commit?: string };
    commit = meta.commit ?? commit;
  } catch { /* */ }
  versionCommitCache = { version, commit };
  return versionCommitCache;
}

export function assembleStatusRollupV1(raw: GatheredStatusRaw): StatusRollupV1Response {
  const { version, commit } = readVersionCommit();
  const services = raw.fleet?.services ?? [];
  const complete = services.filter(s => s.step === 'complete').length;
  const needsAttention = services.length - complete;
  const network: 'testnet' | 'mainnet' =
    raw.fleet?.chain === 'base' ? 'mainnet' : 'testnet';
  const phase = network === 'testnet' ? 'phase-1b' : 'phase-2';

  const blockStr = raw.rpc.blockNumber ?? '0';
  const blockNumber = Number(blockStr);
  const exit = buildExitRollup(raw, needsAttention);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    daemon: {
      state: daemonState(raw.shutdownState),
      startedAt: raw.daemonStartedAt ?? null,
      phase,
      network,
      version,
      commit,
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
    paths: {
      earningDir: raw.earningDir ?? null,
      dbPath: raw.dbPath,
    },
    exit,
  };
}
