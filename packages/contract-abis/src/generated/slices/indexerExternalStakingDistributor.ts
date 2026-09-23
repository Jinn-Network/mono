export const EXTERNAL_STAKING_DISTRIBUTOR_ABI = [
  {
    "type": "event",
    "name": "RewardsDistributed",
    "inputs": [
      {
        "type": "uint256",
        "name": "serviceId",
        "indexed": true
      },
      {
        "type": "address",
        "name": "multisig",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "collectorAmount",
        "indexed": false
      },
      {
        "type": "uint256",
        "name": "protocolAmount",
        "indexed": false
      },
      {
        "type": "uint256",
        "name": "curatingAgentAmount",
        "indexed": false
      }
    ]
  }
] as const;
