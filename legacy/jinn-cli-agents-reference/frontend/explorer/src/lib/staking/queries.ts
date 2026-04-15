import { request } from 'graphql-request'

const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || 'https://indexer.jinn.network/graphql'

export interface StakedService {
  id: string
  serviceId: string
  stakingContract: string
  owner: string
  multisig: string
  stakedAt: string
  unstakedAt: string | null
  isStaked: boolean
}

export interface MechServiceMapping {
  id: string
  mech: string
  serviceId: string
  mechFactory: string
  blockTimestamp: string
}

export interface StakingDelivery {
  id: string
  requestId: string
  mech: string
  mechServiceMultisig: string
  deliveryRate: string
  ipfsHash: string | null
  transactionHash: string
  blockNumber: string
  blockTimestamp: string
  jobInstanceStatusUpdate: string | null
}

export interface StakingRequest {
  id: string
  mech: string
  sender: string
  jobName: string | null
  blockTimestamp: string
  delivered: boolean
  transactionHash: string
}

export async function getStakedServices(contractAddresses?: string[]): Promise<StakedService[]> {
  const hasFilter = contractAddresses && contractAddresses.length > 0

  const query = hasFilter
    ? `query StakedServices($contracts: [String!]!) {
        stakedServices(
          where: { stakingContract_in: $contracts }
          orderBy: "stakedAt"
          orderDirection: "desc"
        ) {
          items {
            id serviceId stakingContract owner multisig stakedAt unstakedAt isStaked
          }
        }
      }`
    : `query AllStakedServices {
        stakedServices(
          orderBy: "stakedAt"
          orderDirection: "desc"
        ) {
          items {
            id serviceId stakingContract owner multisig stakedAt unstakedAt isStaked
          }
        }
      }`

  try {
    const variables = hasFilter
      ? { contracts: contractAddresses.map(a => a.toLowerCase()) }
      : {}
    const response = await request<{ stakedServices: { items: StakedService[] } }>(
      SUBGRAPH_URL,
      query,
      variables
    )
    // Sort: actively staked first, then evicted/unstaked
    return response.stakedServices.items.sort((a, b) => {
      if (a.isStaked !== b.isStaked) return a.isStaked ? -1 : 1
      return 0
    })
  } catch (error) {
    console.error('Error querying staked services:', error)
    return []
  }
}

export async function getStakedServiceByServiceId(serviceId: string): Promise<StakedService[]> {
  const query = `
    query StakedServiceByServiceId($serviceId: BigInt!) {
      stakedServices(
        where: { serviceId: $serviceId }
        orderBy: "stakedAt"
        orderDirection: "desc"
      ) {
        items {
          id serviceId stakingContract owner multisig stakedAt unstakedAt isStaked
        }
      }
    }
  `

  try {
    const response = await request<{ stakedServices: { items: StakedService[] } }>(
      SUBGRAPH_URL,
      query,
      { serviceId }
    )
    return response.stakedServices.items
  } catch (error) {
    console.error('Error querying staked service:', error)
    return []
  }
}

export async function getMechsForServiceIds(serviceIds: string[]): Promise<MechServiceMapping[]> {
  const query = `
    query MechMappings($serviceIds: [BigInt!]!) {
      mechServiceMappings(where: { serviceId_in: $serviceIds }) {
        items {
          id
          mech
          serviceId
          mechFactory
          blockTimestamp
        }
      }
    }
  `

  try {
    const response = await request<{ mechServiceMappings: { items: MechServiceMapping[] } }>(
      SUBGRAPH_URL,
      query,
      { serviceIds }
    )
    return response.mechServiceMappings.items
  } catch (error) {
    console.error('Error querying mech mappings:', error)
    return []
  }
}

export async function getDeliveryCountSince(multisig: string, sinceTimestamp: string): Promise<number> {
  const query = `
    query DeliveryCount($multisig: String!, $since: BigInt!) {
      deliverys(
        where: { mechServiceMultisig: $multisig, blockTimestamp_gte: $since }
      ) {
        totalCount
      }
    }
  `

  try {
    const response = await request<{ deliverys: { totalCount: number } }>(
      SUBGRAPH_URL,
      query,
      { multisig: multisig.toLowerCase(), since: sinceTimestamp }
    )
    return response.deliverys.totalCount
  } catch (error) {
    console.error('Error querying delivery count:', error)
    return 0
  }
}

export async function getRecentDeliveries(multisig: string, limit: number = 50): Promise<StakingDelivery[]> {
  const query = `
    query RecentDeliveries($multisig: String!, $limit: Int!) {
      deliverys(
        where: { mechServiceMultisig: $multisig }
        orderBy: "blockTimestamp"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          id
          requestId
          mech
          mechServiceMultisig
          deliveryRate
          ipfsHash
          transactionHash
          blockNumber
          blockTimestamp
          jobInstanceStatusUpdate
        }
      }
    }
  `

  try {
    const response = await request<{ deliverys: { items: StakingDelivery[] } }>(
      SUBGRAPH_URL,
      query,
      { multisig: multisig.toLowerCase(), limit }
    )
    return response.deliverys.items
  } catch (error) {
    console.error('Error querying recent deliveries:', error)
    return []
  }
}

export async function getRecentRequests(mechAddress: string, limit: number = 50): Promise<StakingRequest[]> {
  const query = `
    query RecentRequests($mech: String!, $limit: Int!) {
      requests(
        where: { mech: $mech }
        orderBy: "blockTimestamp"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          id
          mech
          sender
          jobName
          blockTimestamp
          delivered
          transactionHash
        }
      }
    }
  `

  try {
    const response = await request<{ requests: { items: StakingRequest[] } }>(
      SUBGRAPH_URL,
      query,
      { mech: mechAddress.toLowerCase(), limit }
    )
    return response.requests.items
  } catch (error) {
    console.error('Error querying recent requests:', error)
    return []
  }
}
