'use client'

import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import {
  VOTE_WEIGHTING_ADDRESS,
  JINN_NOMINEE_BYTES32,
  JINN_V1_NOMINEE_BYTES32,
  JINN_V2_NOMINEE_BYTES32,
  NOMINEE_CHAIN_ID,
  voteWeightingAbi,
} from '@/lib/vote/constants'

export function useVoteSubmit() {
  const {
    writeContract,
    data: txHash,
    isPending: isSubmitting,
    error: submitError,
    reset,
  } = useWriteContract()

  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    error: confirmError,
  } = useWaitForTransactionReceipt({ hash: txHash })

  function vote(weightBasisPoints: bigint) {
    writeContract({
      address: VOTE_WEIGHTING_ADDRESS,
      abi: voteWeightingAbi,
      functionName: 'voteForNomineeWeights',
      args: [JINN_NOMINEE_BYTES32, NOMINEE_CHAIN_ID, weightBasisPoints],
    })
  }

  /** Remove legacy (v1+v2) votes and set v3 vote in a single batch transaction */
  function migrateVote(v3WeightBasisPoints: bigint, { hasV1, hasV2 }: { hasV1: boolean; hasV2: boolean }) {
    const accounts: `0x${string}`[] = []
    const chainIds: bigint[] = []
    const weights: bigint[] = []

    if (hasV1) {
      accounts.push(JINN_V1_NOMINEE_BYTES32)
      chainIds.push(NOMINEE_CHAIN_ID)
      weights.push(BigInt(0))
    }
    if (hasV2) {
      accounts.push(JINN_V2_NOMINEE_BYTES32)
      chainIds.push(NOMINEE_CHAIN_ID)
      weights.push(BigInt(0))
    }

    accounts.push(JINN_NOMINEE_BYTES32)
    chainIds.push(NOMINEE_CHAIN_ID)
    weights.push(v3WeightBasisPoints)

    writeContract({
      address: VOTE_WEIGHTING_ADDRESS,
      abi: voteWeightingAbi,
      functionName: 'voteForNomineeWeightsBatch',
      args: [accounts, chainIds, weights],
    })
  }

  /** Remove all legacy votes (v1+v2) without touching v3 */
  function removeLegacyVotes({ hasV1, hasV2 }: { hasV1: boolean; hasV2: boolean }) {
    const accounts: `0x${string}`[] = []
    const chainIds: bigint[] = []
    const weights: bigint[] = []

    if (hasV1) {
      accounts.push(JINN_V1_NOMINEE_BYTES32)
      chainIds.push(NOMINEE_CHAIN_ID)
      weights.push(BigInt(0))
    }
    if (hasV2) {
      accounts.push(JINN_V2_NOMINEE_BYTES32)
      chainIds.push(NOMINEE_CHAIN_ID)
      weights.push(BigInt(0))
    }

    if (accounts.length === 1) {
      writeContract({
        address: VOTE_WEIGHTING_ADDRESS,
        abi: voteWeightingAbi,
        functionName: 'voteForNomineeWeights',
        args: [accounts[0], chainIds[0], weights[0]],
      })
    } else {
      writeContract({
        address: VOTE_WEIGHTING_ADDRESS,
        abi: voteWeightingAbi,
        functionName: 'voteForNomineeWeightsBatch',
        args: [accounts, chainIds, weights],
      })
    }
  }

  return {
    vote,
    migrateVote,
    removeLegacyVotes,
    txHash,
    isSubmitting,
    isConfirming,
    isConfirmed,
    error: submitError || confirmError,
    reset,
  }
}
