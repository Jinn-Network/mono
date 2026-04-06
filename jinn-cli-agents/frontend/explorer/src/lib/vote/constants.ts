// VoteWeighting contract on Ethereum Mainnet
export const VOTE_WEIGHTING_ADDRESS = '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1' as const

// veOLAS contract on Ethereum Mainnet
export const VE_OLAS_ADDRESS = '0x7e01A500805f8A52Fad229b3015AD130A332B7b3' as const

// Jinn v1 staking contract on Base (old — user may have votes allocated here)
export const JINN_V1_STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139' as const
export const JINN_V1_NOMINEE_BYTES32 =
  '0x0000000000000000000000000dfafbf570e9e813507aae18aa08dfba0abc5139' as `0x${string}`

// Jinn v2 staking contract on Base (legacy — user may have votes allocated here)
export const JINN_V2_STAKING_CONTRACT = '0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488' as const
export const JINN_V2_NOMINEE_BYTES32 =
  '0x00000000000000000000000066a92cda5b319dcccac6c1cecbb690ca3fb59488' as `0x${string}`

// Jinn v3 staking contract on Base (current target)
export const JINN_V3_STAKING_CONTRACT = '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54' as const

// Nominee as bytes32 (address left-padded to 32 bytes) — points to current (v3) contract
export const JINN_NOMINEE_BYTES32 =
  '0x00000000000000000000000051c5f4982b9b0b3c0482678f5847ea6228cc8e54' as `0x${string}`

// Base chain ID
export const NOMINEE_CHAIN_ID = BigInt(8453)

// Precomputed nominee hashes for voteUserSlopes lookup
// nomineeHash = keccak256(abi.encode(account, chainId))
// v1: keccak256(encode(0x0000...0dfafbf570e9e813507aae18aa08dfba0abc5139, 8453))
export const JINN_V1_NOMINEE_HASH =
  '0x479b0756e692586f2a9ece0418b549e39ad992e5a5486ccf332747bebb203b83' as `0x${string}`
// v2: keccak256(encode(0x0000...66a92cda5b319dcccac6c1cecbb690ca3fb59488, 8453))
export const JINN_V2_NOMINEE_HASH =
  '0xc63c6aa6c9cf823b70c55334347c4d91d5f687b783ba687ce2acf87e06dd4dd5' as `0x${string}`
// v3: keccak256(encode(0x0000...51c5f4982b9b0b3c0482678f5847ea6228cc8e54, 8453))
export const JINN_V3_NOMINEE_HASH =
  '0x62f9f44ed197acd3149d636f6a45dd801bbce22b232fecf2060b54402c13e4bb' as `0x${string}`

// Max vote weight (100% = 10000 basis points)
export const MAX_WEIGHT_BPS = 10000

export const voteWeightingAbi = [
  {
    type: 'function',
    name: 'voteForNomineeWeights',
    inputs: [
      { name: 'account', type: 'bytes32' },
      { name: 'chainId', type: 'uint256' },
      { name: 'weight', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'voteUserPower',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getNomineeWeight',
    inputs: [
      { name: 'account', type: 'bytes32' },
      { name: 'chainId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getWeightsSum',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'nomineeRelativeWeight',
    inputs: [
      { name: 'account', type: 'bytes32' },
      { name: 'chainId', type: 'uint256' },
      { name: 'time', type: 'uint256' },
    ],
    outputs: [
      { name: 'weight', type: 'uint256' },
      { name: 'totalWeight', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'voteForNomineeWeightsBatch',
    inputs: [
      { name: 'accounts', type: 'bytes32[]' },
      { name: 'chainIds', type: 'uint256[]' },
      { name: 'weights', type: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export const veOlasAbi = [
  {
    type: 'function',
    name: 'getVotes',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const
