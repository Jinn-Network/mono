/**
 * Test-only legacy `claimEvaluation` write helper.
 *
 * Production verdict claims go through venue-base `VerdictPorts` (stage 2).
 * E2E harnesses still need a direct router write for second-operator / Anvil
 * closed-loop scripts until those paths call `venue.verdict.openVerdictAttempt`.
 */
import {
  decodeEventLog,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  withEvictionRecovery,
  type EvictionRecoveryConfig,
} from '../../src/adapters/mech/contracts.js';
import { executeSafeTransaction, type VenueBroadcaster } from '../../src/adapters/mech/safe.js';
import { JINN_ROUTER_ABI } from '../../src/adapters/mech/types.js';
import { waitForTransactionReceiptWithRetry } from '../../src/tx-retry.js';

export async function claimEvaluation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  broadcaster: VenueBroadcaster | undefined,
  safeAddress: Address,
  routerAddress: Address,
  taskId: string | bigint,
  attemptIndex: number,
  evaluatorMech: Address,
  evaluationTaskCidDigest: Hex,
  evictionRecovery?: EvictionRecoveryConfig,
): Promise<{
  taskId: string;
  attemptIndex: number;
  verdictIndex: number;
  requestId: string;
  txHash: Hex;
  blockNumber?: number;
}> {
  const taskIdBigInt = typeof taskId === 'bigint' ? taskId : BigInt(taskId);
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'claimEvaluation',
    args: [taskIdBigInt, attemptIndex, evaluatorMech, evaluationTaskCidDigest],
  });

  const txHash = await withEvictionRecovery(
    publicClient,
    evictionRecovery,
    'claimEvaluation',
    () =>
      executeSafeTransaction(
        publicClient,
        walletClient,
        {
          safeAddress,
          to: routerAddress,
          value: 0n,
          data: calldata,
        },
        broadcaster,
      ),
  );

  const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash, {
    onRetry: ({ attempt, message }) => {
      console.error(`[router] wait claim evaluation receipt retry ${attempt}: ${message}`);
    },
  });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'EvaluationAttemptCreated') {
        const args = decoded.args as {
          taskId: bigint;
          attemptIndex: number;
          verdictIndex: number;
          requestId: Hex;
        };
        return {
          taskId: String(args.taskId),
          attemptIndex: Number(args.attemptIndex),
          verdictIndex: Number(args.verdictIndex),
          requestId: String(args.requestId),
          txHash,
          blockNumber: log.blockNumber != null ? Number(log.blockNumber) : undefined,
        };
      }
    } catch {
      // Not our event
    }
  }

  throw new Error(`No EvaluationAttemptCreated event returned from router tx=${txHash}`);
}
