/**
 * Slim `jinn status` roll-up from GatheredStatusRaw.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.1.
 */

import type { GatheredStatusRaw } from './status-build.js';
import { isOperationalServiceStep } from '../earning/types.js';
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
  paths: { earningDir: string | null; dbPath: string };
  exit: { blocking: boolean; hint: string | null };
  /** Present only when --detail flag is passed. */
  detail?: StatusDetailV1;
}

/**
 * Operator diagnostic detail — last known values for each diagnostic dimension.
 * Surfaced by `jinn status --detail` (audit finding U4).
 */
export interface StatusDetailV1 {
  /** Last bootstrap step recorded in fleet state, or null if no fleet exists yet. */
  lastBootstrapStep: string | null;
  /** ISO timestamp when fleet state was last written. */
  fleetUpdatedAt: string | null;
  /** Last activity event recorded in SQLite (most recent daemon loop action). */
  lastDaemonEvent: {
    ts: string | null;
    kind: string;
    txHash: string | null;
    outcome: string | null;
  } | null;
  /** Most recent Claude session outcome from engine working dir. */
  lastClaudeSession: {
    requestId: string;
    sessionId: string;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    aborted: boolean;
  } | null;
  /** Most recent on-chain transaction hash recorded in activity events. */
  lastChainTx: string | null;
  /** Latest automatic setup archive, when one exists. */
  latestSetupArchive: {
    updatedAt: string;
    backupStatePath: string;
    serviceIndexes: number[];
  } | null;
  /** Prioritised list of operator actions. Same source as /v1/status nextActions. */
  nextActions: string[];
}

function daemonState(raw: GatheredStatusRaw): 'running' | 'stopped' | 'starting' {
  if (raw.shutdownState === 'running' && raw.daemonRuntime) {
    return raw.daemonRuntime.alive ? 'running' : 'stopped';
  }
  if (raw.shutdownState === 'running') return 'running';
  return 'stopped';
}

/**
 * Produce a human-friendly RPC hint without leaking raw viem/node error text
 * directly into `exit.hint`. The underlying error is preserved in `rpc.error`
 * for structured consumers (audit U4 — raw viem errors in exit.hint).
 */
function friendlyRpcHint(rawError: string | undefined): string {
  if (!rawError) return 'RPC unreachable — check rpcUrl in config.';
  // Viem / fetch errors are verbose (stack frames, JSON-RPC method names, etc).
  // Produce a short human hint while preserving the underlying text in rpc.error.
  const lower = rawError.toLowerCase();
  if (lower.includes('econnrefused') || lower.includes('connection refused') || lower.includes('fetch failed')) {
    return 'RPC unreachable — connection refused. Check rpcUrl or network connectivity.';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'RPC unreachable — request timed out. Check rpcUrl or network connectivity.';
  }
  if (lower.includes('unauthorized') || lower.includes('403') || lower.includes('401')) {
    return 'RPC unreachable — authentication error. Check rpcUrl credentials.';
  }
  // Generic fallback: trim to first line only (removes viem stack noise)
  const firstLine = rawError.split('\n')[0]?.trim() ?? rawError;
  const truncated = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  return `RPC unreachable — ${truncated}`;
}

function buildExitRollup(
  raw: GatheredStatusRaw,
  needsAttention: number,
): { blocking: boolean; hint: string | null } {
  if (!raw.rpc.ok) {
    return { blocking: true, hint: friendlyRpcHint(raw.rpc.error) };
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

/**
 * Build the `detail` block for `jinn status --detail` (audit finding U4).
 * Pulls from already-gathered GatheredStatusRaw — no extra I/O.
 */
export function assembleStatusDetailV1(raw: GatheredStatusRaw): StatusDetailV1 {
  // Last bootstrap step: take the worst non-operational step across services,
  // surface safe_binding_pending if present, or 'complete' if all are fully bound.
  let lastBootstrapStep: string | null = null;
  let fleetUpdatedAt: string | null = null;
  if (raw.fleet) {
    fleetUpdatedAt = raw.fleet.updated_at ?? null;
    const services = raw.fleet.services;
    if (services.length > 0) {
      const incomplete = services.filter(s => !isOperationalServiceStep(s.step));
      if (incomplete.length > 0) {
        // Return the step of the first incomplete service (lowest index)
        const sorted = [...incomplete].sort((a, b) => a.index - b.index);
        lastBootstrapStep = sorted[0]!.step;
      } else if (services.some(s => s.step === 'safe_binding_pending')) {
        lastBootstrapStep = 'safe_binding_pending';
      } else {
        lastBootstrapStep = 'complete';
      }
    }
  }

  // Last daemon activity event (most recent SQLite row)
  let lastDaemonEvent: StatusDetailV1['lastDaemonEvent'] = null;
  if (raw.recentActivity.length > 0) {
    // recentActivity is ordered DESC by id in gather-status; first entry is newest
    const latest = raw.recentActivity[0]!;
    lastDaemonEvent = {
      ts: latest.ts,
      kind: latest.kind,
      txHash: latest.txHash,
      outcome: latest.outcome,
    };
  }

  // Last chain tx: scan recent activity for a txHash
  let lastChainTx: string | null = null;
  for (const evt of raw.recentActivity) {
    if (evt.txHash) {
      lastChainTx = evt.txHash;
      break;
    }
  }

  let latestSetupArchive: StatusDetailV1['latestSetupArchive'] = null;
  const migrationEntries = raw.migrationArchive?.entries ?? [];
  if (migrationEntries.length > 0) {
    const sorted = [...migrationEntries].sort((a, b) =>
      Date.parse(b.updated_at) - Date.parse(a.updated_at),
    );
    const latest = sorted[0]!;
    latestSetupArchive = {
      updatedAt: latest.updated_at,
      backupStatePath: latest.backup_state_path,
      serviceIndexes: sorted
        .filter(e => e.backup_state_path === latest.backup_state_path)
        .map(e => e.service_index)
        .sort((a, b) => a - b),
    };
  }

  // Last Claude session: from portfolioV0 (already gathered, no extra I/O)
  let lastClaudeSession: StatusDetailV1['lastClaudeSession'] = null;
  const outcomes = raw.portfolioV0?.recentClaudeOutcomes;
  if (outcomes && outcomes.length > 0) {
    const o = outcomes[0]!;
    lastClaudeSession = {
      requestId: o.requestId,
      sessionId: o.sessionId,
      startedAt: o.startedAt,
      endedAt: o.endedAt,
      durationMs: o.durationMs,
      aborted: o.aborted,
    };
  }

  // Next actions: reuse the buildNextActions logic from status-build via raw
  // We reconstruct a minimal fleet summary for the shared helper.
  const nextActions = buildNextActionsFromRaw(raw);

  return {
    lastBootstrapStep,
    fleetUpdatedAt,
    lastDaemonEvent,
    lastClaudeSession,
    lastChainTx,
    latestSetupArchive,
    nextActions,
  };
}

/**
 * Derive prioritised next actions from GatheredStatusRaw without importing
 * the full assembleStatusV1 pipeline.
 */
function buildNextActionsFromRaw(raw: GatheredStatusRaw): string[] {
  const actions: string[] = [];

  if (!raw.rpc.ok) {
    actions.push('Restore RPC access — check rpcUrl / network for live balances and rewards.');
  }

  const fleet = raw.fleet;
  if (!fleet) {
    actions.push('Run bootstrap (`jinn run` with JINN_PASSWORD) to create fleet and staking state.');
  } else {
    if (!fleet.master_address) {
      actions.push('Complete earning bootstrap so master_address is recorded.');
    }
    for (const s of fleet.services) {
      if (s.error) {
        actions.push(`Service ${s.index}: ${s.error}`);
      }
      if (!isOperationalServiceStep(s.step)) {
        actions.push(`Resume service ${s.index}: local step "${s.step}" — re-run jinn run.`);
      } else if (s.step === 'safe_binding_pending') {
        actions.push(`Service ${s.index}: identity binding pending; daemon will retry setAgentWallet on next bootstrap.`);
      }
    }
  }

  if (raw.master.address && raw.minMasterEthWei && raw.master.balanceWei !== undefined) {
    try {
      const bal = BigInt(raw.master.balanceWei);
      const min = BigInt(raw.minMasterEthWei);
      if (bal < min) {
        actions.push('Fund master EOA with more ETH for gas (below configured minimum).');
      }
    } catch { /* ignore */ }
  }

  const dedup = [...new Set(actions)];
  if (dedup.length === 0) {
    dedup.push('No urgent actions — daemon loops and reward claims run on schedule.');
  }
  return dedup;
}

export function assembleStatusRollupV1(
  raw: GatheredStatusRaw,
  opts: { includeDetail?: boolean } = {},
): StatusRollupV1Response {
  const { version, commit } = readVersionCommit();
  const services = raw.fleet?.services ?? [];
  const complete = services.filter(s => isOperationalServiceStep(s.step)).length;
  const needsAttention = services.filter(s => !isOperationalServiceStep(s.step) || s.error).length;
  const network: 'testnet' | 'mainnet' =
    raw.fleet?.chain === 'base' ? 'mainnet' : 'testnet';
  const phase = network === 'testnet' ? 'phase-1b' : 'phase-2';

  const blockStr = raw.rpc.blockNumber ?? '0';
  const blockNumber = Number(blockStr);
  const exit = buildExitRollup(raw, needsAttention);

  const base: StatusRollupV1Response = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    daemon: {
      state: daemonState(raw),
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
    paths: {
      earningDir: raw.earningDir ?? null,
      dbPath: raw.dbPath,
    },
    exit,
  };

  if (opts.includeDetail) {
    base.detail = assembleStatusDetailV1(raw);
  }

  return base;
}
