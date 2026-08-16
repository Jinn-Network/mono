/**
 * Shared detector for the stOLAS ExternalStakingDistributor's
 * `UnauthorizedAccount(address)` revert, which `reStake()` throws when the
 * caller is not in `mapCuratingAgents` / `mapManagingAgents` and is not the
 * distributor owner. Both the bootstrap reconcile path and the operator-facing
 * error formatter need to recognise it.
 */

/** 4-byte selector of `UnauthorizedAccount(address)`. */
export const UNAUTHORIZED_ACCOUNT_SELECTOR = '0x32b2baa3';

export function isUnauthorizedAccountError(message: string): boolean {
  return (
    message.includes('UnauthorizedAccount') ||
    message.includes(UNAUTHORIZED_ACCOUNT_SELECTOR)
  );
}
