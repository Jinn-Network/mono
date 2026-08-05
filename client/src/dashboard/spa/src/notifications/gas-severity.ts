/**
 * Single source of the gas-runway severity rule (#1296): blocking when the balance can't
 * cover the next tx (`balanceWei < minEthWei`), warning when the remaining runway is under
 * the 3-day threshold. Consumed by `Overview.tsx`'s WalletCard tint, which reads
 * `/v1/status` directly — that display concern is independent of notification derivation
 * (which moved server-side, issue #2408; see `client/src/api/notifications-build.ts`'s own
 * copy of this same rule).
 *
 * This function used to live in `notifications/derive.ts` alongside the (now server-side)
 * `deriveNotifications`. It stays client-side under its own name because WalletCard's tint
 * has nothing to do with the notification list — it's a per-field display computation over
 * the live status snapshot.
 */
const RUNWAY_LOW_THRESHOLD_DAYS = 3;

export function gasSeverity(gas: {
  balanceWei?: string;
  runwayDaysExcess?: string | number | null;
  minEthWei?: string;
}): 'warning' | 'blocking' | null {
  if (!gas || gas.balanceWei === undefined) return null;
  try {
    if (gas.minEthWei !== undefined && BigInt(gas.balanceWei) < BigInt(gas.minEthWei)) {
      return 'blocking';
    }
  } catch {
    /* non-numeric */
  }
  const days = Number(gas.runwayDaysExcess);
  if (Number.isFinite(days) && days < RUNWAY_LOW_THRESHOLD_DAYS) return 'warning';
  return null;
}
