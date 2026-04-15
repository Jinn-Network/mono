'use client'

import { useAccount, useReadContracts } from 'wagmi'
import {
  VOTE_WEIGHTING_ADDRESS,
  VE_OLAS_ADDRESS,
  JINN_NOMINEE_BYTES32,
  NOMINEE_CHAIN_ID,
  JINN_V1_NOMINEE_HASH,
  JINN_V2_NOMINEE_HASH,
  JINN_V3_NOMINEE_HASH,
  voteWeightingAbi,
  veOlasAbi,
  MAX_WEIGHT_BPS,
} from '@/lib/vote/constants'

// voteUserSlopes is mapping(address => mapping(bytes32 nomineeHash => VotedSlope))
// where nomineeHash = keccak256(abi.encode(account, chainId))
// VotedSlope = { slope: uint256, power: uint256, end: uint256 }
const voteUserSlopesAbi = [
  {
    type: 'function',
    name: 'voteUserSlopes',
    inputs: [
      { name: '', type: 'address' },
      { name: '', type: 'bytes32' },
    ],
    outputs: [
      { name: 'slope', type: 'uint256' },
      { name: 'power', type: 'uint256' },
      { name: 'end', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
] as const

export function useVoteData() {
  const { address, isConnected } = useAccount()

  // Public reads — always enabled, no wallet required
  const { data: publicData, isLoading: publicLoading, refetch: refetchPublic } = useReadContracts({
    contracts: [
      // 0: Jinn v3 nominee absolute weight
      {
        chainId: 1,
        address: VOTE_WEIGHTING_ADDRESS,
        abi: voteWeightingAbi,
        functionName: 'getNomineeWeight',
        args: [JINN_NOMINEE_BYTES32, NOMINEE_CHAIN_ID],
      },
      // 1: total weight sum across all nominees
      {
        chainId: 1,
        address: VOTE_WEIGHTING_ADDRESS,
        abi: voteWeightingAbi,
        functionName: 'getWeightsSum',
      },
    ],
    query: { refetchInterval: 30_000 },
  })

  // Wallet reads — only when connected
  const { data: userData, isLoading: userLoading, refetch: refetchUser } = useReadContracts({
    contracts: [
      // 0: veOLAS voting power (decays linearly toward lock expiry)
      {
        chainId: 1,
        address: VE_OLAS_ADDRESS,
        abi: veOlasAbi,
        functionName: 'getVotes',
        args: [address!],
      },
      // 1: total allocated vote power (0-10000 bps)
      {
        chainId: 1,
        address: VOTE_WEIGHTING_ADDRESS,
        abi: voteWeightingAbi,
        functionName: 'voteUserPower',
        args: [address!],
      },
      // 2: user's existing vote for Jinn v3 nominee (power field = bps allocated)
      {
        chainId: 1,
        address: VOTE_WEIGHTING_ADDRESS,
        abi: voteUserSlopesAbi,
        functionName: 'voteUserSlopes',
        args: [address!, JINN_V3_NOMINEE_HASH],
      },
      // 3: user's existing vote for Jinn v1 nominee (legacy — migration)
      {
        chainId: 1,
        address: VOTE_WEIGHTING_ADDRESS,
        abi: voteUserSlopesAbi,
        functionName: 'voteUserSlopes',
        args: [address!, JINN_V1_NOMINEE_HASH],
      },
      // 4: user's existing vote for Jinn v2 nominee (legacy — migration)
      {
        chainId: 1,
        address: VOTE_WEIGHTING_ADDRESS,
        abi: voteUserSlopesAbi,
        functionName: 'voteUserSlopes',
        args: [address!, JINN_V2_NOMINEE_HASH],
      },
    ],
    query: {
      enabled: isConnected && !!address,
      refetchInterval: 30_000,
    },
  })

  const [nomineeWeight, weightsSum] = publicData ?? []
  const [veOlasBalance, userPower, v3Slope, v1Slope, v2Slope] = userData ?? []

  const userAllocatedPower = userPower?.result as bigint | undefined
  // power field from VotedSlope = bps the user allocated to this specific nominee
  const existingV3Power = (v3Slope?.result as readonly [bigint, bigint, bigint] | undefined)?.[1]
  const existingV1Power = (v1Slope?.result as readonly [bigint, bigint, bigint] | undefined)?.[1]
  const existingV2Power = (v2Slope?.result as readonly [bigint, bigint, bigint] | undefined)?.[1]
  const existingLegacyPower = BigInt(existingV1Power ?? 0) + BigInt(existingV2Power ?? 0)

  // Max the user can allocate to Jinn v3:
  // contract does: newTotal = userPower - oldV3Power + newWeight; require(newTotal <= 10000)
  // so maxWeight = 10000 - userPower + oldV3Power
  const maxAvailableBps =
    userAllocatedPower !== undefined
      ? MAX_WEIGHT_BPS - Number(userAllocatedPower) + Number(existingV3Power ?? BigInt(0))
      : MAX_WEIGHT_BPS

  function refetch() {
    refetchPublic()
    refetchUser()
  }

  return {
    isConnected,
    isLoading: publicLoading || userLoading,
    refetch,
    veOlasBalance: veOlasBalance?.result as bigint | undefined,
    userAllocatedPower,
    nomineeWeight: nomineeWeight?.result as bigint | undefined,
    weightsSum: weightsSum?.result as bigint | undefined,
    existingV3Power,
    existingV1Power,
    existingV2Power,
    existingLegacyPower,
    maxAvailableBps: Math.max(0, Math.min(MAX_WEIGHT_BPS, maxAvailableBps)),
  }
}
