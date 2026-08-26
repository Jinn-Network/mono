import type Database from 'better-sqlite3';
import { maskUrlsInMessage } from '../rpc/transport.js';

export interface BalanceCacheEntry {
  role: string;
  address: string;
  nativeWei?: string | null;
  bondWei?: string | null;
  assetExtraJson?: string | null;
  fetchedAt: string;
  error?: string | null;
}

export class BalanceCacheStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * One-time migration (issue #2402, spec §14.2 item 2): a `balance_cache`
   * row written before this fix can carry a raw, key-in-path RPC URL in its
   * `error` column. `getBalanceCache()` re-masks on every read (see there),
   * which covers every row a client still fetches — but a service/role that
   * later drops out of the fleet (re-indexed display slot, removed service)
   * leaves its row un-read forever, so re-mask-on-read never reaches it.
   * Clearing the column outright at schema-init closes that orphan-row case;
   * `error` is re-populated on the role's next fetch/failure regardless.
   */
  clearLegacyErrors(): void {
    this.db.exec(`UPDATE balance_cache SET error = NULL WHERE error LIKE '%http%'`);
  }

  upsertBalanceCache(entry: BalanceCacheEntry): void {
    this.db.prepare(
      `INSERT INTO balance_cache (role, address, native_wei, bond_wei, asset_extra_json, fetched_at, error)
       VALUES (@role, @address, @nativeWei, @bondWei, @assetExtraJson, @fetchedAt, @error)
       ON CONFLICT(role) DO UPDATE SET
         address=excluded.address,
         native_wei=excluded.native_wei,
         bond_wei=excluded.bond_wei,
         asset_extra_json=excluded.asset_extra_json,
         fetched_at=excluded.fetched_at,
         error=excluded.error`,
    ).run({
      role: entry.role,
      address: entry.address,
      nativeWei: entry.nativeWei ?? null,
      bondWei: entry.bondWei ?? null,
      assetExtraJson: entry.assetExtraJson ?? null,
      fetchedAt: entry.fetchedAt,
      error: entry.error ?? null,
    });
  }

  getBalanceCache(): BalanceCacheEntry[] {
    const rows = this.db.prepare(
      `SELECT role, address, native_wei, bond_wei, asset_extra_json, fetched_at, error
       FROM balance_cache`,
    ).all() as Array<{
      role: string;
      address: string;
      native_wei: string | null;
      bond_wei: string | null;
      asset_extra_json: string | null;
      fetched_at: string;
      error: string | null;
    }>;
    return rows.map((r) => ({
      role: r.role,
      address: r.address,
      nativeWei: r.native_wei,
      bondWei: r.bond_wei,
      assetExtraJson: r.asset_extra_json,
      fetchedAt: r.fetched_at,
      // Re-mask on read (issue #2402, spec §14.2 item 2) — NOT a one-shot
      // scrub, this runs on every call. A row written before gather-status.ts's
      // `errorMessage` choke point started masking RPC URLs can carry a raw
      // key-in-path error string; masking again here is idempotent
      // (already-masked errors have no `http(s)://` substring left to match)
      // and guarantees such a row stops leaking on its very next read. The
      // actual one-shot scrub is `clearLegacyErrors()` at schema-init, which
      // also covers rows for a role that's since dropped out of the fleet and
      // would otherwise never be read again.
      error: r.error === null ? null : maskUrlsInMessage(r.error),
    }));
  }
}
