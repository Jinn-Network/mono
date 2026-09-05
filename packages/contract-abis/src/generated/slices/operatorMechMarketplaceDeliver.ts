export const MECH_MARKETPLACE_DELIVER_ABI = [
  {
    "type": "function",
    "name": "deliverMarketplace",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "bytes32[]",
        "name": "requestIds"
      },
      {
        "type": "uint256[]",
        "name": "deliveryRates"
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
