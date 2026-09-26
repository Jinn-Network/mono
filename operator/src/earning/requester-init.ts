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
 * Floor only. Live Base Sepolia quotes may raise this (see
 * {@link quoteRequesterSafeFunding}) so the agent can cover
 * `SAFE_CREATE_PROXY_GAS` × current maxFee, including replacement bumps.
 * The 2026-09-26 scratch-HOME walk cleared this floor then failed deploy
 * because viem's unbounded `eth_estimateGas` × maxFee exceeded 0.001 ETH
 * on the paying EOA (#4791).
 */
export const REQUESTER_SAFE_DEPLOY_ETH = 1_000_000_000_000_000n; // 0.001 ETH

/**
 * Gas limit pinned on the Safe factory `createProxy` broadcast.
 *
 * Protocol Kit's deployment tx is ~250k gas. Leaving gas unset lets viem
 * take a 5M-class estimate (the Safe-adapter fallback neighbourhood) and
 * then refuse the send as insufficient funds even when 0.001 ETH would
 * pay a real 250k-gas deploy at testnet fees.
 */
export const SAFE_CREATE_PROXY_GAS = 800_000n;

/** Simple value-transfer gas, pinned so the master→agent fund tx cannot inherit a bogus estimate. */
export const REQUESTER_MASTER_TRANSFER_GAS = 21_000n;

/**
 * Extra multiple over `gas × fee` so one replacement bump (15%) still fits.
 */
export const REQUESTER_FEE_HEADROOM_NUMERATOR = 2n;

/**
 * Hard cap on the quoted requester master gate. Always below the operator's
 * 0.02 ETH Stage 1 target so a fee spike cannot reintroduce the §4.2 defect.
 */
export const REQUESTER_MASTER_ETH_CAP = 10_000_000_000_000_000n; // 0.01 ETH

/**
 * Master gas reserve. The master signs exactly one transaction on this path —
 * the 21k-gas value transfer above — so this is deliberately far below the
 * operator's `minEoaGasEth` (0.005), which budgets for a whole state machine.
 */
export const REQUESTER_MASTER_GAS_RESERVE_ETH = 500_000_000_000_000n; // 0.0005 ETH

export type RequesterSafeFundingQuote = {
  readonly agentWei: bigint;
  readonly masterWei: bigint;
};

/**
 * Size the agent transfer and master gate from a fee-per-gas observation.
 *
 * `feePerGas === 0n` (RPC miss) returns the static floor. Otherwise the
 * quote is `max(floor, gas × fee × headroom)`, capped at
 * {@link REQUESTER_MASTER_ETH_CAP}.
 */
export function quoteRequesterSafeFunding(feePerGas: bigint): RequesterSafeFundingQuote {
  if (feePerGas <= 0n) {
    return {
      agentWei: REQUESTER_SAFE_DEPLOY_ETH,
      masterWei: requesterMinMasterEth(),
    };
  }
  const deployCost =
    (SAFE_CREATE_PROXY_GAS * feePerGas * REQUESTER_FEE_HEADROOM_NUMERATOR);
  const transferCost =
    (REQUESTER_MASTER_TRANSFER_GAS * feePerGas * REQUESTER_FEE_HEADROOM_NUMERATOR);
  const agentWei = deployCost > REQUESTER_SAFE_DEPLOY_ETH ? deployCost : REQUESTER_SAFE_DEPLOY_ETH;
  const reserve = transferCost > REQUESTER_MASTER_GAS_RESERVE_ETH
    ? transferCost
    : REQUESTER_MASTER_GAS_RESERVE_ETH;
  let masterWei = agentWei + reserve;
  if (masterWei > REQUESTER_MASTER_ETH_CAP) {
    masterWei = REQUESTER_MASTER_ETH_CAP;
    const cappedAgent = masterWei > reserve ? masterWei - reserve : masterWei;
    return { agentWei: cappedAgent, masterWei };
  }
  return { agentWei, masterWei };
}

/**
 * Total ETH the master EOA needs before `ensureRequesterSafe` can complete
 * when fees are unknown. Live Base Sepolia uses {@link quoteRequesterSafeFunding}
 * so the gate and the transfer still agree.
 *
 * Single source of truth for the static floor: the mutating gate (when the
 * fee read fails) and the read-only `planFleetFunding` both route through
 * this, so the number a requester is asked for is the number that unblocks
 * them on the cheap-fee path.
 */
export function requesterMinMasterEth(): bigint {
  return REQUESTER_SAFE_DEPLOY_ETH + REQUESTER_MASTER_GAS_RESERVE_ETH;
}
