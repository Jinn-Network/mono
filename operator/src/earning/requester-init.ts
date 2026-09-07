/**
 * Requester-only onboarding constants (B0a, issue #2446).
 *
 * The operator's master-ETH gate (`stage1MinMasterEth`) is 0.020 ETH for a
 * one-service standard bootstrap: 0.010 to the agent EOA — sized for Safe
 * deploy *plus* ERC-8004 register *plus* setAgentWallet — and a 0.010 master
 * budget spread across both bootstrap stages.
 *
 * A requester buys none of that. It deploys one Safe and sends one value
 * transfer to fund the EOA that deploys it. Reporting the operator's number
 * to a requester is the defect the user-journeys design records at §4.2
 * ("asks for 0.02 ETH, the operator bootstrap target, where a requester needs
 * Safe-deployment gas"), and it is not cosmetic: at the measured CDP drip of
 * ~0.0001 ETH (`ESTIMATED_DRIP_WEI`) the operator target is ~200 drips against
 * a 4:30 budget for the whole of beats 2–4.
 */

/**
 * Master → agent-EOA transfer that funds the creator-Safe deployment.
 *
 * Safe deployment through the Safe factory costs ~250k gas. Base Sepolia
 * settles well below 1 gwei in normal conditions; 0.001 ETH is ~4× the
 * 1 gwei cost and leaves the agent EOA with change for a retry.
 */
export const REQUESTER_SAFE_DEPLOY_ETH = 1_000_000_000_000_000n; // 0.001 ETH

/**
 * Master gas reserve. The master signs exactly one transaction on this path —
 * the 21k-gas value transfer above — so this is deliberately far below the
 * operator's `minEoaGasEth` (0.005), which budgets for a whole state machine.
 */
export const REQUESTER_MASTER_GAS_RESERVE_ETH = 500_000_000_000_000n; // 0.0005 ETH

/**
 * Total ETH the master EOA needs before `ensureRequesterSafe` can complete.
 * Single source of truth: the mutating gate in `FleetBootstrapper` and the
 * read-only `planFleetFunding` both route through this, so the number a
 * requester is asked for is the number that unblocks them.
 */
export function requesterMinMasterEth(): bigint {
  return REQUESTER_SAFE_DEPLOY_ETH + REQUESTER_MASTER_GAS_RESERVE_ETH;
}
