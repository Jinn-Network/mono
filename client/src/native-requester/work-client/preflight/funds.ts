import { RequesterError } from '../errors.js';

export interface PostingFundsInput {
  readonly safeBalanceWei: bigint;
  readonly agentBalanceWei: bigint;
  readonly solutionMaxDeliveryRateWei: bigint;
  readonly verdictMaxDeliveryRateWei: bigint;
  readonly maxClaims: number;
  readonly agentGasReserveWei: bigint;
}

/** The two-rail escrow the venue withholds: (solution + verdict) rates across every claim slot. */
export function postingBudgetWei(input: PostingFundsInput): bigint {
  return (
    (input.solutionMaxDeliveryRateWei + input.verdictMaxDeliveryRateWei)
    * BigInt(input.maxClaims)
  );
}

/**
 * The requester funding rule: the creator Safe holds the whole task budget, and the agent EOA
 * holds that same budget (it is the outer Safe exec value) plus a gas reserve. Mirrors the legacy
 * `assertMarketplaceTaskFunding` behavior (client/src/tasks/submit-preflight.ts:63-87), pinned by
 * the golden fixture.
 */
export function assertPostingFunds(input: PostingFundsInput): void {
  if (!Number.isInteger(input.maxClaims) || input.maxClaims < 1) {
    throw new RequesterError(
      'config',
      'invalid-max-claims',
      `maxClaims must be a positive integer, received ${input.maxClaims}`,
    );
  }
  const budget = postingBudgetWei(input);
  if (input.safeBalanceWei < budget) {
    throw new RequesterError(
      'funds',
      'safe-underfunded',
      `creator Safe requires ${budget} wei task budget but has ${input.safeBalanceWei} wei`,
    );
  }
  const requiredAgent = budget + input.agentGasReserveWei;
  if (input.agentBalanceWei < requiredAgent) {
    throw new RequesterError(
      'funds',
      'agent-underfunded',
      `creator agent EOA requires ${requiredAgent} wei: ${budget} wei outer Safe exec value plus `
      + `${input.agentGasReserveWei} wei gas reserve, but has ${input.agentBalanceWei} wei`,
    );
  }
}
