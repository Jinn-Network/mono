export const EXTERNAL_STAKING_DISTRIBUTOR_ABI = [
  {
    type: 'event',
    name: 'RewardsDistributed',
    inputs: [
      { name: 'serviceId', type: 'uint256', indexed: true },
      { name: 'multisig', type: 'address', indexed: true },
      { name: 'collectorAmount', type: 'uint256', indexed: false },
      { name: 'protocolAmount', type: 'uint256', indexed: false },
      { name: 'curatingAgentAmount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
] as const;
