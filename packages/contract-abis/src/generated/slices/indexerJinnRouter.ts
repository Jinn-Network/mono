export const JINN_ROUTER_ABI = [
  {
    "type": "event",
    "name": "TaskCreated",
    "inputs": [
      {
        "type": "address",
        "name": "creator",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "taskId",
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
      },
      {
        "type": "uint256",
        "name": "solutionBudget",
        "indexed": false
      },
      {
        "type": "uint256",
        "name": "verdictBudget",
        "indexed": false
      }
    ]
  },
  {
    "type": "event",
    "name": "TaskAttemptCreated",
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
        "type": "bytes32",
        "name": "requestId",
        "indexed": true
      },
      {
        "type": "address",
        "name": "operator",
        "indexed": false
      },
      {
        "type": "address",
        "name": "priorityMech",
        "indexed": false
      },
      {
        "type": "uint256",
        "name": "deliveryRate",
        "indexed": false
      }
    ]
  },
  {
    "type": "event",
    "name": "SolutionDeliveryClaimed",
    "inputs": [
      {
        "type": "address",
        "name": "operator",
        "indexed": true
      },
      {
        "type": "bytes32",
        "name": "requestId",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "taskId",
        "indexed": true
      },
      {
        "type": "uint32",
        "name": "attemptIndex",
        "indexed": false
      }
    ]
  },
  {
    "type": "event",
    "name": "VerdictDeliveryClaimed",
    "inputs": [
      {
        "type": "address",
        "name": "evaluator",
        "indexed": true
      },
      {
        "type": "bytes32",
        "name": "requestId",
        "indexed": true
      },
      {
        "type": "uint256",
        "name": "taskId",
        "indexed": true
      },
      {
        "type": "uint32",
        "name": "attemptIndex",
        "indexed": false
      },
      {
        "type": "uint32",
        "name": "verdictIndex",
        "indexed": false
      },
      {
        "type": "uint8",
        "name": "verdictCode",
        "indexed": false
      }
    ]
  },
  {
    "type": "event",
    "name": "TaskBudgetRefunded",
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
        "type": "uint256",
        "name": "solutionAmount",
        "indexed": false
      },
      {
        "type": "uint256",
        "name": "verdictAmount",
        "indexed": false
      }
    ]
  },
  {
    "type": "function",
    "name": "taskCoordinator",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "type": "address",
        "name": ""
      }
    ]
  },
  {
    "type": "function",
    "name": "createTask",
    "stateMutability": "payable",
    "inputs": [
      {
        "type": "bytes32",
        "name": "taskCidDigest"
      },
      {
        "type": "bytes32",
        "name": "manifestDigest"
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
        "type": "uint256",
        "name": "solutionMaxDeliveryRate"
      },
      {
        "type": "uint256",
        "name": "verdictMaxDeliveryRate"
      },
      {
        "type": "uint256",
        "name": "responseTimeout"
      }
    ],
    "outputs": [
      {
        "type": "uint256",
        "name": "taskId"
      }
    ]
  }
] as const;
