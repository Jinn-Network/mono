/**
 * Re-export of the extracted notification derivation kit
 * (`@jinn-network/lifecycle-notifications`). The HTTP assembler stays here.
 */
export {
  CLAIM_FAILED_WINDOW_MS,
  PASSWORD_ROTATION_INTERVAL_MS,
  RUNWAY_LOW_THRESHOLD_DAYS,
  buildNotifications,
  countRecentClaimFailures,
  fundsChainFromGasBlock,
  gasSeverity,
} from '@jinn-network/lifecycle-notifications';
export type {
  ClaimEventLike,
  DerivedNotice as NotificationV1,
  FundsChain,
  GasBlockLike,
  NotificationsBuildInput,
  RpcSlotHealthLike,
} from '@jinn-network/lifecycle-notifications';
