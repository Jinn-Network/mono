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

/** A read no node took: nothing is known about what was asked. A rate limit is
 * one, because the node declined the caller, not the question. */
const UNREACHED = new Set([
  "HttpRequestError",
  "TimeoutError",
  "WebSocketRequestError",
  "SocketClosedError",
  "LimitExceededRpcError",
]);

/**
 * Whether a node took a read of a contract and block that a record chose, whatever it
 * said. A hostile statement picks both, so it can name a block no node holds or a
 * contract that returns junk, and neither may read as an outage. Only a read that
 * reached no node is one. A client that is not viem says nothing either way, so its
 * failure stays an outage.
 */
export function isReadAnswered(cause: unknown): boolean {
  let executed = false;
  for (let error = cause; error instanceof Error; error = error.cause) {
    if (UNREACHED.has(error.name)) return false;
    executed ||= error.name === "ContractFunctionExecutionError" || CONTRACT_ANSWERS.has(error.name);
  }
  return executed;
}
