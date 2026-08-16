/**
 * Conservative default: ~0.0005 ETH/day master gas if not configured.
 *
 * Post-bootstrap master burn is dominated by rare BalanceTopupLoop top-ups,
 * not every-poll activity — the previous 0.001 ETH/day floor (alongside a
 * poll-based blend, since removed) over-estimated steady-state burn and
 * surfaced a misleading "1 days runway" dashboard reading at ~0.008 ETH
 * balances (#288).
 */
export const DEFAULT_MASTER_ETH_DAILY_WEI = 500_000_000_000_000n;
