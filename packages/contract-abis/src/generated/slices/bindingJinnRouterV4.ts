export const JINN_ROUTER_V4_ABI = [
  {
    "type": "function",
    "name": "claimTask",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId"
      },
      {
        "type": "address",
        "name": "priorityMech"
      }
    ],
    "outputs": [
      {
        "type": "uint32",
        "name": "attemptIndex"
      }
    ]
  },
  {
    "type": "function",
    "name": "claimEvaluation",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId"
      },
      {
        "type": "uint32",
        "name": "attemptIndex"
      },
      {
        "type": "address",
        "name": "evaluatorMech"
      }
    ],
    "outputs": [
      {
        "type": "uint32",
        "name": "verdictIndex"
      }
    ]
  },
  {
    "type": "function",
    "name": "prepareSolutionDelivery",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId"
      },
      {
        "type": "uint32",
        "name": "attemptIndex"
      },
      {
        "type": "bytes32",
        "name": "deliveryDigest"
      }
    ],
    "outputs": [
      {
        "type": "bytes32",
        "name": "expectedRequestId"
      },
      {
        "type": "uint256",
        "name": "nonce"
      },
      {
        "type": "bytes",
        "name": "requestData"
      }
    ]
  },
  {
    "type": "function",
    "name": "prepareVerdictDelivery",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId"
      },
      {
        "type": "uint32",
        "name": "attemptIndex"
      },
      {
        "type": "uint32",
        "name": "verdictIndex"
      },
      {
        "type": "bytes32",
        "name": "deliveryDigest"
      },
      {
        "type": "uint8",
        "name": "verdictCode"
      }
    ],
    "outputs": [
      {
        "type": "bytes32",
        "name": "expectedRequestId"
      },
      {
        "type": "uint256",
        "name": "nonce"
      },
      {
        "type": "bytes",
        "name": "requestData"
      }
    ]
  },
  {
    "type": "function",
    "name": "releaseAttempt",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId"
      },
      {
        "type": "uint32",
        "name": "attemptIndex"
      }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "releaseVerdict",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId"
      },
      {
        "type": "uint32",
        "name": "attemptIndex"
      },
      {
        "type": "uint32",
        "name": "verdictIndex"
      }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "forfeitDeliveredReservation",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId"
      },
      {
        "type": "uint32",
        "name": "attemptIndex"
      },
      {
        "type": "uint32",
        "name": "verdictIndex"
      },
      {
        "type": "uint8",
        "name": "legKind"
      }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "closeTask",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId"
      }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "claimSolutionDelivery",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "mech"
      },
      {
        "type": "bytes",
        "name": "requestData"
      },
      {
        "type": "uint256",
        "name": "deliveryRate"
      },
      {
        "type": "bytes32",
        "name": "paymentType"
      },
      {
        "type": "uint256",
        "name": "nonce"
      }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "claimVerdictDelivery",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "type": "address",
        "name": "mech"
      },
      {
        "type": "bytes",
        "name": "requestData"
      },
      {
        "type": "uint256",
        "name": "deliveryRate"
      },
      {
        "type": "bytes32",
        "name": "paymentType"
      },
      {
        "type": "uint256",
        "name": "nonce"
      }
    ],
    "outputs": []
  }
] as const;
