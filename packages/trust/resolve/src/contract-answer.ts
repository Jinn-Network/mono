// SPDX-License-Identifier: Apache-2.0

import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from "viem";

/**
 * Whether a failed contract read is the chain's answer rather than an outage: the
 * call reached the contract, which reverted, or no contract was there. Nothing
 * retried will change it, and it says something about what was asked.
 */
export function isContractAnswer(cause: unknown): boolean {
  return cause instanceof BaseError && cause.walk((error) =>
    error instanceof ContractFunctionRevertedError || error instanceof ContractFunctionZeroDataError) !== null;
}
