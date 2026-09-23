export const MECH_ABI = [
  {
    "type": "event",
    "name": "Deliver",
    "inputs": [
      {
        "type": "address",
        "name": "mech",
        "indexed": true
      },
      {
        "type": "address",
        "name": "mechServiceMultisig",
        "indexed": true
      },
      {
        "type": "bytes32",
        "name": "requestId",
        "indexed": false
      },
      {
        "type": "uint256",
        "name": "deliveryRate",
        "indexed": false
      },
      {
        "type": "bytes",
        "name": "data",
        "indexed": false
      }
    ]
  }
] as const;
