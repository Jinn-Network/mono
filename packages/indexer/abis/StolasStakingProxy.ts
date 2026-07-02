/**
 * Minimal ABI for the active stOLAS staking proxy events the explorer needs.
 *
 * Checkpoint is the earned-reward signal: rewards are allocated to services at
 * checkpoint time, before any operator chooses to claim/cash out.
 */
export const STOLAS_STAKING_PROXY_ABI = [
  {
    type: 'event',
    name: 'ServiceStaked',
    inputs: [
      { name: 'epoch', type: 'uint256', indexed: false },
      { name: 'serviceId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'multisig', type: 'address', indexed: true },
      { name: 'nonces', type: 'uint256[]', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Checkpoint',
    inputs: [
      { name: 'epoch', type: 'uint256', indexed: true },
      { name: 'availableRewards', type: 'uint256', indexed: false },
      { name: 'serviceIds', type: 'uint256[]', indexed: false },
      { name: 'rewards', type: 'uint256[]', indexed: false },
      { name: 'epochLength', type: 'uint256', indexed: false },
    ],
  },
] as const;
