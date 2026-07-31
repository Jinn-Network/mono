// SPDX-License-Identifier: MIT

// The production `SafeBroadcastPort` for today-mode posting: one direct EOA transaction carrying
// the `createTask` calldata `postTask` already built, plus the `TaskCreated` receipt decode.
// Productionizes the wiring that until now existed only inside the Anvil-fork conformance harness
// (`packages/marketplace/testing/src/backend-conformance.test.ts`) -- supply design §8 D7,
// binding finding F2.
//
// Named divergence (finding F-C5-6): `JinnRouterV3.createTask` is a plain `payable` function
// keyed on `msg.sender`, so today-mode posting is not Safe-gated. Safe-routing itself
// (`executeSafeTransaction` in `./safe.js`) is the work client's territory: the marketplace
// consumption-boundary design owns posting mechanics, and this adapter is what the posting
// application swaps out beneath its policy surface at that client's mint (supply design §8, F7).
// The interface keeps its name because this is that interface's production implementation;
// `input.safeAddress` is the creator of record, and this port CHECKS it against the wallet's own
// account rather than assuming the caller got it right.
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import { decodeEventLog, type PublicClient, type WalletClient } from "viem";
import { JINN_ROUTER_V3_ABI } from "../abis/jinn-router-v3.js";
import type { PostingOutcome } from "../broadcast-intent.js";
import type { SafeBroadcastPort } from "../posting.js";

type TransactionReceipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;

export interface EoaBroadcastOptions {
  /** Receipt poll interval in ms; omitted -> the client's own default. */
  readonly receiptPollingIntervalMs?: number;
  /** Receipt wait ceiling in ms; omitted -> the client's own default. */
  readonly receiptTimeoutMs?: number;
}

function decodeTaskCreatedTaskId(receipt: TransactionReceipt, router: string): bigint | undefined {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== router.toLowerCase()) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics });
    } catch {
      continue; // a router log this ABI does not describe is not an error, just not ours
    }
    if (decoded.eventName === "TaskCreated") return decoded.args.taskId;
  }
  return undefined;
}

/**
 * Builds the EOA broadcast port. Both viem clients are parameters -- this module never constructs
 * a transport, reads an env var, or touches key material (custody law). The wallet client's
 * account is the requester of record.
 *
 * Broadcasts are serialized per port instance: one EOA has one nonce sequence, and two concurrent
 * posts would race it. Serializing here keeps the lock out of `postTask`, which stays
 * chain-client-agnostic.
 */
export function createEoaBroadcastPort(
  publicClient: PublicClient,
  walletClient: WalletClient,
  options: EoaBroadcastOptions = {},
): SafeBroadcastPort {
  const account = walletClient.account;
  if (account === undefined) {
    throw new Error("createEoaBroadcastPort requires a wallet client with an account");
  }
  let queue: Promise<unknown> = Promise.resolve();

  return {
    broadcastCreateTask: async (input) => {
      const run = queue.then(async (): Promise<PostingOutcome> => {
        if (input.safeAddress.toLowerCase() !== account.address.toLowerCase()) {
          throw new TaskExecutionError("access-denied", {
            detail:
              `creator of record ${input.safeAddress} is not this wallet's account `
              + `${account.address} -- refusing to post under another requester's identity`,
          });
        }

        const hash = await walletClient.sendTransaction({
          account,
          chain: walletClient.chain ?? null,
          to: input.to,
          data: input.data,
          value: input.value,
        });

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          ...(options.receiptPollingIntervalMs === undefined
            ? {}
            : { pollingInterval: options.receiptPollingIntervalMs }),
          ...(options.receiptTimeoutMs === undefined ? {} : { timeout: options.receiptTimeoutMs }),
        });
        if (receipt.status !== "success") {
          throw new Error(`JinnRouterV3.createTask reverted (txHash=${hash})`);
        }

        const taskId = decodeTaskCreatedTaskId(receipt, input.to);
        if (taskId === undefined) {
          throw new TaskExecutionError("protocol-violation", {
            detail:
              `createTask succeeded but the router emitted no TaskCreated event (txHash=${hash}) `
              + "-- the post cannot be keyed, so the intent stays unresolved for the recovery scan",
          });
        }
        return { taskId, txHash: hash };
      });
      // The queue must survive a rejection: the next caller waits for this attempt to finish, not
      // for it to succeed.
      queue = run.then(() => undefined, () => undefined);
      return await run;
    },
  };
}
