export const TASK_COORDINATOR_ABI = [
  {
    "type": "event",
    "name": "TaskClaimed",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId",
        "indexed": true
      },
      {
        "type": "uint32",
        "name": "attemptIndex",
        "indexed": true
      },
      {
        "type": "address",
        "name": "operator",
        "indexed": true
      }
    ]
  },
  {
    "type": "event",
    "name": "TaskCreated",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId",
        "indexed": true
      },
      {
        "type": "address",
        "name": "creator",
        "indexed": true
      },
      {
        "type": "bytes32",
        "name": "manifestDigest",
        "indexed": true
      },
      {
        "type": "bytes32",
        "name": "taskCidDigest",
        "indexed": false
      },
      {
        "type": "uint32",
        "name": "maxClaims",
        "indexed": false
      }
    ]
  },
  {
    "type": "function",
    "name": "getAttempt",
    "stateMutability": "view",
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
    "outputs": [
      {
        "type": "tuple",
        "name": "attempt",
        "components": [
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
            "name": "operator"
          },
          {
            "type": "bytes32",
            "name": "requestId"
          },
          {
            "type": "bytes32",
            "name": "solutionCidDigest"
          },
          {
            "type": "uint256",
            "name": "solutionWeight"
          },
          {
            "type": "uint32",
            "name": "verdictCount"
          },
          {
            "type": "uint8",
            "name": "status"
          }
        ]
      }
    ]
  },
  {
    "type": "function",
    "name": "getTask",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "uint256",
        "name": "taskId"
      }
    ],
    "outputs": [
      {
        "type": "tuple",
        "name": "record",
        "components": [
          {
            "type": "address",
            "name": "creator"
          },
          {
            "type": "bytes32",
            "name": "taskCidDigest"
          },
          {
            "type": "bytes32",
            "name": "manifestDigest"
          },
          {
            "type": "uint8",
            "name": "status"
          },
          {
            "type": "tuple",
            "name": "policy",
            "components": [
              {
                "type": "uint32",
                "name": "maxClaims"
              },
              {
                "type": "bool",
                "name": "allowSolverSelfEvaluation"
              }
            ]
          },
          {
            "type": "uint32",
            "name": "claimCount"
          },
          {
            "type": "uint32",
            "name": "submittedCount"
          },
          {
            "type": "uint32",
            "name": "finalizedAttemptCount"
          },
          {
            "type": "bool",
            "name": "creatorCredited"
          }
        ]
      }
    ]
  },
  {
    "type": "function",
    "name": "getRequestRef",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "bytes32",
        "name": "requestId"
      }
    ],
    "outputs": [
      {
        "type": "uint256",
        "name": "taskId"
      },
      {
        "type": "uint32",
        "name": "attemptIndex"
      },
      {
        "type": "bool",
        "name": "exists"
      }
    ]
  },
  {
    "type": "function",
    "name": "getVerdictRequestRef",
    "stateMutability": "view",
    "inputs": [
      {
        "type": "bytes32",
        "name": "requestId"
      }
    ],
    "outputs": [
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
        "type": "bool",
        "name": "exists"
      }
    ]
  },
  {
    "type": "function",
    "name": "getVerdict",
    "stateMutability": "view",
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
    "outputs": [
      {
        "type": "tuple",
        "name": "verdict",
        "components": [
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
            "type": "address",
            "name": "evaluator"
          },
          {
            "type": "bytes32",
            "name": "requestId"
          },
          {
            "type": "bytes32",
            "name": "verdictCidDigest"
          },
          {
            "type": "uint8",
            "name": "verdictCode"
          },
          {
            "type": "uint8",
            "name": "status"
          }
        ]
      }
    ]
  }
] as const;
