import { OLAS_STAKING_SUBGRAPH_URL } from './constants'

async function querySubgraph<T>(query: string): Promise<T> {
  const res = await fetch(OLAS_STAKING_SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    next: { revalidate: 120 }, // Cache for 2 minutes in Next.js
  })

  if (!res.ok) {
    throw new Error(`Subgraph returned ${res.status}: ${await res.text()}`)
  }

  const json = await res.json()
  if (json.errors?.length) {
    throw new Error(`Subgraph query error: ${json.errors[0].message}`)
  }

  return json.data as T
}

export interface SubgraphService {
  id: string
  currentOlasStaked: string
  olasRewardsEarned: string
  olasRewardsClaimed: string
  latestStakingContract: string | null
  totalEpochsParticipated: number
}

export async function getServiceFromSubgraph(serviceId: string): Promise<SubgraphService | null> {
  const data = await querySubgraph<{ service: SubgraphService | null }>(`{
    service(id: "${serviceId}") {
      id
      currentOlasStaked
      olasRewardsEarned
      olasRewardsClaimed
      latestStakingContract
      totalEpochsParticipated
    }
  }`)
  return data.service
}

export interface SubgraphCheckpoint {
  epoch: string
  availableRewards: string
  epochLength: string
  blockTimestamp: string
  serviceIds: string[]
  rewards: string[]
  contractAddress: string
}

export async function getLatestCheckpoint(contractAddress: string): Promise<SubgraphCheckpoint | null> {
  const addr = contractAddress.toLowerCase()
  const data = await querySubgraph<{ checkpoints: SubgraphCheckpoint[] }>(`{
    checkpoints(
      first: 1
      orderBy: blockTimestamp
      orderDirection: desc
      where: { contractAddress: "${addr}" }
    ) {
      epoch
      availableRewards
      epochLength
      blockTimestamp
      serviceIds
      rewards
      contractAddress
    }
  }`)
  return data.checkpoints[0] ?? null
}

export interface SubgraphStakingContract {
  id: string
  livenessPeriod: string
  rewardsPerSecond: string
  maxNumServices: string
}

export async function getStakingContract(address: string): Promise<SubgraphStakingContract | null> {
  const addr = address.toLowerCase()
  const data = await querySubgraph<{ stakingContract: SubgraphStakingContract | null }>(`{
    stakingContract(id: "${addr}") {
      id
      livenessPeriod
      rewardsPerSecond
      maxNumServices
    }
  }`)
  return data.stakingContract
}
