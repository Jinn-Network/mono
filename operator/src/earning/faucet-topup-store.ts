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
  /**
   * Epoch ms until which CDP has rate-limited this address (typically a 24h
   * per-address cap). Distinct from `callsToday`: bootstrap drips never
   * increment the batch cap, but they must still zero GET /quota.
   */
  rateLimitedUntil?: number;
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

function parseRecord(value: unknown): FaucetTopupRecord | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as FaucetTopupRecord).callsToday !== 'number' ||
    typeof (value as FaucetTopupRecord).batchStartedAt !== 'number'
  ) {
    return undefined;
  }
  const record: FaucetTopupRecord = {
    callsToday: (value as FaucetTopupRecord).callsToday,
    batchStartedAt: (value as FaucetTopupRecord).batchStartedAt,
  };
  if (typeof (value as FaucetTopupRecord).rateLimitedUntil === 'number') {
    record.rateLimitedUntil = (value as FaucetTopupRecord).rateLimitedUntil;
  }
  return record;
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
      const record = parseRecord(v);
      if (record) byAddress[k.toLowerCase()] = record;
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
  const next: FaucetTopupRecord = {
    callsToday: record.callsToday,
    batchStartedAt: record.batchStartedAt,
  };
  if (record.rateLimitedUntil !== undefined) {
    next.rateLimitedUntil = record.rateLimitedUntil;
  }
  state.byAddress[address.toLowerCase()] = next;
  writeFileSync(topupPath(earningDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function persistCdpRateLimit(input: {
  earningDir: string;
  address: string;
  now: number;
  cooldownMs: number;
  existing?: FaucetTopupRecord;
}): void {
  writeFaucetTopupRecord(input.earningDir, input.address, {
    callsToday: input.existing?.callsToday ?? 0,
    batchStartedAt: input.existing?.batchStartedAt ?? input.now,
    rateLimitedUntil: input.now + input.cooldownMs,
  });
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
  /** True while a persisted CDP per-address rate-limit window is still open. */
  rateLimited: boolean;
}

/**
 * Pure quota computation. No record → full quota. Window elapsed (now past
 * batchStartedAt + cooldownMs) → quota resets, window inactive. Otherwise the
 * window is active and remaining = max(0, cap - callsToday).
 *
 * A persisted CDP rate-limit zeros remaining until `rateLimitedUntil`, even
 * when `callsToday` is still below the batch cap (bootstrap drips never
 * increment the batch counter).
 */
export function computeTopupQuota(input: ComputeTopupQuotaInput): TopupQuota {
  const { record, dailyCap, cooldownMs, now } = input;
  if (record?.rateLimitedUntil !== undefined && now < record.rateLimitedUntil) {
    return {
      callsRemaining: 0,
      cooldownExpiresAt: record.rateLimitedUntil,
      windowActive: true,
      rateLimited: true,
    };
  }
  if (!record) {
    return {
      callsRemaining: dailyCap,
      cooldownExpiresAt: null,
      windowActive: false,
      rateLimited: false,
    };
  }
  const cooldownExpiresAt = record.batchStartedAt + cooldownMs;
  if (now >= cooldownExpiresAt) {
    return {
      callsRemaining: dailyCap,
      cooldownExpiresAt,
      windowActive: false,
      rateLimited: false,
    };
  }
  return {
    callsRemaining: Math.max(0, dailyCap - record.callsToday),
    cooldownExpiresAt,
    windowActive: true,
    rateLimited: false,
  };
}

/** CDP's hard per-address 24h faucet cap — retries will not recover. */
export function isHardCdpAddressCap(reason?: string): boolean {
  return /1 claim per 24 hours/i.test(reason ?? '');
}
