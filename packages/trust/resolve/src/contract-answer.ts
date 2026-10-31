// SPDX-License-Identifier: Apache-2.0

/** By name, not class: the client that threw may be built on another copy of viem. */
const CONTRACT_ANSWERS = new Set(["ContractFunctionRevertedError", "ContractFunctionZeroDataError"]);

/**
 * Whether a failed contract read is the chain's answer rather than an outage: the
 * call reached the contract, which reverted, or no contract was there. Nothing
 * retried will change it, and it says something about what was asked.
 */
export function isContractAnswer(cause: unknown): boolean {
  for (let error = cause; error instanceof Error; error = error.cause) {
    if (CONTRACT_ANSWERS.has(error.name)) return true;
  }
  return false;
}
