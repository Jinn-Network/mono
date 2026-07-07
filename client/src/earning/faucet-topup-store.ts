/**
 * Per-wallet faucet top-up accounting (issue #560).
 *
 * The running-mode Dashboard "Top up from faucet" button issues a BATCH of
 * faucet drips up to a project-set daily cap in one operator click, then
 * disables itself until a cooldown window elapses since the first call of that
 * batch. This sidecar persists, per master address, how many drips have been
 * issued in the current batch and when that batch started, so the cap survives
 * a daemon restart and the SPA can surface the remaining quota + cooldown
 * expiry.
 *
 * Stored at `<earningDir>/faucet-topup.json`, mode 0o600. Reads are fail-soft:
 * a missing or corrupt file yields an empty default rather than throwing, so a
 * lost sidecar simply re-grants a full batch rather than wedging the button.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FAUCET_TOPUP_FILE = 'faucet-topup.json';

export interface FaucetTopupRecord {
  /** Drips issued in the current (active) 24h batch window. */
  callsToday: number;
  /** Epoch ms of the first drip in the current batch window. */
  batchStartedAt: number;
}

export interface FaucetTopupState {
  schemaVersion: 1;
  byAddress: Record<string, FaucetTopupRecord>;
}

function emptyState(): FaucetTopupState {
  return { schemaVersion: 1, byAddress: {} };
}

function topupPath(earningDir: string): string {
  return join(earningDir, FAUCET_TOPUP_FILE);
}

/**
 * Read the per-wallet top-up state. Fail-soft: a missing, unreadable, or
 * malformed file returns an empty default (never throws).
 */
export function readFaucetTopupState(earningDir: string): FaucetTopupState {
  const path = topupPath(earningDir);
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<FaucetTopupState>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.byAddress !== 'object' || parsed.byAddress === null) {
      return emptyState();
    }
    const byAddress: Record<string, FaucetTopupRecord> = {};
    for (const [k, v] of Object.entries(parsed.byAddress)) {
      if (
        v &&
        typeof v === 'object' &&
        typeof (v as FaucetTopupRecord).callsToday === 'number' &&
        typeof (v as FaucetTopupRecord).batchStartedAt === 'number'
      ) {
        byAddress[k.toLowerCase()] = {
          callsToday: (v as FaucetTopupRecord).callsToday,
          batchStartedAt: (v as FaucetTopupRecord).batchStartedAt,
        };
      }
    }
    return { schemaVersion: 1, byAddress };
  } catch {
    return emptyState();
  }
}

/**
 * Read-modify-write the top-up record for one address. Keys by lowercased
 * address; writes atomically-ish via a single 0o600 writeFileSync (mirrors the
 * persistFundingGate idiom in setup-endpoints.ts).
 */
export function writeFaucetTopupRecord(
  earningDir: string,
  address: string,
  record: FaucetTopupRecord,
): void {
  const state = readFaucetTopupState(earningDir);
  state.byAddress[address.toLowerCase()] = {
    callsToday: record.callsToday,
    batchStartedAt: record.batchStartedAt,
  };
  writeFileSync(topupPath(earningDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export interface ComputeTopupQuotaInput {
  record: FaucetTopupRecord | undefined;
  dailyCap: number;
  cooldownMs: number;
  now: number;
}

export interface TopupQuota {
  /** Drips the operator may still issue right now. */
  callsRemaining: number;
  /** Epoch ms when the active batch window expires, or null if no window. */
  cooldownExpiresAt: number | null;
  /** True when a batch window is active and the cap has been (partly) used. */
  windowActive: boolean;
}

/**
 * Pure quota computation. No record → full quota. Window elapsed (now past
 * batchStartedAt + cooldownMs) → quota resets, window inactive. Otherwise the
 * window is active and remaining = max(0, cap - callsToday).
 */
export function computeTopupQuota(input: ComputeTopupQuotaInput): TopupQuota {
  const { record, dailyCap, cooldownMs, now } = input;
  if (!record) {
    return { callsRemaining: dailyCap, cooldownExpiresAt: null, windowActive: false };
  }
  const cooldownExpiresAt = record.batchStartedAt + cooldownMs;
  if (now >= cooldownExpiresAt) {
    return { callsRemaining: dailyCap, cooldownExpiresAt, windowActive: false };
  }
  return {
    callsRemaining: Math.max(0, dailyCap - record.callsToday),
    cooldownExpiresAt,
    windowActive: true,
  };
}
