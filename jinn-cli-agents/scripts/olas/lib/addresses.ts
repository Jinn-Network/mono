// All OLAS-related contract addresses, verified on-chain Feb 2026

export const MAINNET = {
  veOLAS: '0x7e01A500805f8A52Fad229b3015AD130A332B7b3',
  voteWeighting: '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1',
  // Current contracts (old ones at 0x87f89F94... and 0xeED0000f... are deprecated)
  tokenomics: '0xc096362fa6f4A4B1a9ea68b1043416f3381ce300',
  dispenser: '0x5650300fcbab43a0d7d02f8cb5d0f039402593f0',
} as const;

export const BASE = {
  jinnStaking: '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139',
  // stOLAS ExternalStakingDistributor (LemonTree)
  stolasDistributor: '0x40abf47B926181148000DbCC7c8DE76A3a61a66f', // proxy
  stolasDistributorImpl: '0x4A26F79b9dd73a48d57ce4DF70295A875afa006c',
  stolasGuard: '0x4D3911420a8E4E7dB8c979f4915dA8983C5e3ba2',
  stolasL2Processor: '0xCAF018A23a104095180e298856AC1a415f9831E8',
  stolasCollector: '0xaC7eA9478E0e1186E7D1c82b8d8dc80AEe0F79F6',
} as const;

export const JINN = {
  nomineeBytes32: '0x0000000000000000000000000dfafbf570e9e813507aae18aa08dfba0abc5139',
  chainId: 8453,
  rewardsPerService: 575, // OLAS per 14-day epoch (from rewardsPerSecond)
  maxSlots: 10,
} as const;

export const VOTER = '0x0b6D0a414bc61A8f312f055669851edFb1764CE0';

export const RPC = {
  mainnet: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
} as const;
