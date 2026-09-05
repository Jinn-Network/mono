export const MECH_DELIVER_TO_MARKETPLACE_ABI = [
  {
    "type": "function",
    "name": "deliverToMarketplace",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "bytes32[]",
        "name": "requestIds"
      },
      {
        "type": "bytes[]",
        "name": "datas"
      }
    ],
    "outputs": [
      {
        "type": "bool[]",
        "name": "deliveredRequests"
      }
    ]
  }
] as const;
