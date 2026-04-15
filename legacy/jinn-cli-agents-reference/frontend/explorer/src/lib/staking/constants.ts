export interface StakingContractInfo {
  address: `0x${string}`
  label: string
  shortKey: string
}

export const STAKING_CONTRACTS: StakingContractInfo[] = [
  {
    address: '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139',
    label: 'V1',
    shortKey: 'v1',
  },
  {
    address: '0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488',
    label: 'V2',
    shortKey: 'v2',
  },
  {
    address: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',
    label: 'V3',
    shortKey: 'v3',
  },
]

export const STAKING_CONTRACT_BY_KEY = new Map(
  STAKING_CONTRACTS.map(c => [c.shortKey, c])
)
export const STAKING_CONTRACT_BY_ADDRESS = new Map(
  STAKING_CONTRACTS.map(c => [c.address.toLowerCase(), c])
)
export const ALL_STAKING_ADDRESSES = STAKING_CONTRACTS.map(c => c.address.toLowerCase())

/** @deprecated Use STAKING_CONTRACTS instead */
export const JINN_STAKING_CONTRACT = STAKING_CONTRACTS[0].address

export const OLAS_STAKING_SUBGRAPH_URL = 'https://staking-base.subgraph.autonolas.tech'

export const TARGET_REQUESTS_PER_EPOCH = 60

export const OLAS_TOKEN_CONTRACT = '0x54330d28ca3357F294334BDC454a032e7f353416' as const
export const SERVICE_REGISTRY_CONTRACT = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE' as const
export const ETH_FUNDING_TARGET_WEI = BigInt('2000000000000000') // 0.002 ETH
export const ETH_FUNDING_WARNING_WEI = BigInt('1000000000000000') // 0.001 ETH

export const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020' as const

export const marketplaceAbi = [
  {
    type: 'function',
    name: 'mapRequestCounts',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const
export const LIVENESS_PERIOD = 86400 // 1 day in seconds

export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export const serviceRegistryAbi = [
  {
    type: 'function',
    name: 'getAgentInstances',
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    outputs: [
      { name: 'numAgentInstances', type: 'uint256' },
      { name: 'agentInstances', type: 'address[]' },
    ],
    stateMutability: 'view',
  },
] as const

export const stakingAbi = [
  {
    type: 'function',
    name: 'tsCheckpoint',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getNextRewardCheckpointTimestamp',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'livenessPeriod',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getServiceIds',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getServiceInfo',
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'multisig', type: 'address' },
          { name: 'owner', type: 'address' },
          { name: 'nonces', type: 'uint256[]' },
          { name: 'tsStart', type: 'uint256' },
          { name: 'reward', type: 'uint256' },
          { name: 'inactivity', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'calculateStakingReward',
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'availableRewards',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getStakingState',
    inputs: [{ name: 'serviceId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'maxNumInactivityPeriods',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'minStakingDuration',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const
