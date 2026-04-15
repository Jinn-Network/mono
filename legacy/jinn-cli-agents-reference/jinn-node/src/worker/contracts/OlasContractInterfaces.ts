/**
 * OLAS Contract Interfaces and ABIs
 * 
 * This module contains the contract interfaces and ABIs for interacting with
 * OLAS protocol contracts (AgentRegistry, ServiceRegistry) via ethers.js
 * 
 * Part of JINN-150 Slice 2: Service Creation and Registration Refactoring
 */

import { Interface, keccak256, AbiCoder } from 'ethers';

// AgentRegistry ABI - focusing on the create function and events
export const AGENT_REGISTRY_ABI = [
  // create function
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "agentOwner",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "agentHash",
        "type": "bytes32"
      }
    ],
    "name": "create",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  // CreateAgent event
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "agentHash",
        "type": "bytes32"
      }
    ],
    "name": "CreateAgent",
    "type": "event"
  },
  // ownerOf function for checking ownership
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "id",
        "type": "uint256"
      }
    ],
    "name": "ownerOf",
    "outputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // exists function for checking if agent exists
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "unitId",
        "type": "uint256"
      }
    ],
    "name": "exists",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // getHashes function for getting agent hashes
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      }
    ],
    "name": "getHashes",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "numHashes",
        "type": "uint256"
      },
      {
        "internalType": "bytes32[]",
        "name": "agentHashes",
        "type": "bytes32[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

// ServiceRegistry ABI - based on OLAS protocol patterns
export const SERVICE_REGISTRY_ABI = [
  // create function
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "serviceOwner",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "configHash",
        "type": "bytes32"
      },
      {
        "internalType": "uint32[]",
        "name": "agentIds",
        "type": "uint32[]"
      },
      {
        "internalType": "uint32[]",
        "name": "agentParams",
        "type": "uint32[]"
      },
      {
        "internalType": "uint32",
        "name": "threshold",
        "type": "uint32"
      }
    ],
    "name": "create",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  // CreateService event
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "configHash",
        "type": "bytes32"
      }
    ],
    "name": "CreateService",
    "type": "event"
  },
  // activateRegistration function
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      }
    ],
    "name": "activateRegistration",
    "outputs": [
      {
        "internalType": "bool",
        "name": "success",
        "type": "bool"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  // ActivateRegistration event
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "serviceOwner",
        "type": "address"
      }
    ],
    "name": "ActivateRegistration",
    "type": "event"
  },
  // ownerOf function
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "id",
        "type": "uint256"
      }
    ],
    "name": "ownerOf",
    "outputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // exists function
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "unitId",
        "type": "uint256"
      }
    ],
    "name": "exists",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // getService function to get service details
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      }
    ],
    "name": "getService",
    "outputs": [
      {
        "internalType": "address",
        "name": "serviceOwner",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "configHash",
        "type": "bytes32"
      },
      {
        "internalType": "uint32[]",
        "name": "agentIds",
        "type": "uint32[]"
      },
      {
        "internalType": "uint32[]",
        "name": "agentParams",
        "type": "uint32[]"
      },
      {
        "internalType": "uint32",
        "name": "threshold",
        "type": "uint32"
      },
      {
        "internalType": "uint256",
        "name": "state",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

// OLAS Staking Contract ABI - based on OLAS protocol staking patterns
export const OLAS_STAKING_ABI = [
  // stake function
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      }
    ],
    "name": "stake",
    "outputs": [
      {
        "internalType": "bool",
        "name": "success",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  // unstake function
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      }
    ],
    "name": "unstake",
    "outputs": [
      {
        "internalType": "bool",
        "name": "success",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  // claim function for rewards
  {
    "inputs": [],
    "name": "claim",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "reward",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  // getStakedServiceIds function
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "getStakedServiceIds",
    "outputs": [
      {
        "internalType": "uint256[]",
        "name": "serviceIds",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // getServiceStakingState function
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      }
    ],
    "name": "getServiceStakingState",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "stakingState",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "stakingStartTime",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  // ServiceStaked event
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "ServiceStaked",
    "type": "event"
  },
  // ServiceUnstaked event
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "ServiceUnstaked",
    "type": "event"
  },
  // RewardsClaimed event
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "RewardsClaimed",
    "type": "event"
  }
];

// Service states
export enum ServiceState {
  NonExistent = 0,
  PreRegistration = 1,
  ActiveRegistration = 2,
  FinishedRegistration = 3,
  Deployed = 4,
  TerminatedBonded = 5
}

// Staking states
export enum StakingState {
  NotStaked = 0,
  Staked = 1,
  Unstaked = 2
}

// Contract interaction helper functions
export class OlasContractHelpers {
  /**
   * Encode agent creation transaction data
   */
  static encodeAgentCreation(agentOwner: string, agentHash: string): string {
    const iface = new Interface(AGENT_REGISTRY_ABI);
    return iface.encodeFunctionData('create', [agentOwner, agentHash]);
  }

  /**
   * Encode service creation transaction data
   */
  static encodeServiceCreation(
    serviceOwner: string,
    configHash: string,
    agentIds: number[],
    agentParams: number[],
    threshold: number
  ): string {
    const iface = new Interface(SERVICE_REGISTRY_ABI);
    return iface.encodeFunctionData('create', [
      serviceOwner,
      configHash,
      agentIds,
      agentParams,
      threshold
    ]);
  }

  /**
   * Encode service activation transaction data
   */
  static encodeServiceActivation(serviceId: number): string {
    const iface = new Interface(SERVICE_REGISTRY_ABI);
    return iface.encodeFunctionData('activateRegistration', [serviceId]);
  }

  /**
   * Encode service staking transaction data
   */
  static encodeServiceStaking(serviceId: number): string {
    const iface = new Interface(OLAS_STAKING_ABI);
    return iface.encodeFunctionData('stake', [serviceId]);
  }

  /**
   * Encode service unstaking transaction data
   */
  static encodeServiceUnstaking(serviceId: number): string {
    const iface = new Interface(OLAS_STAKING_ABI);
    return iface.encodeFunctionData('unstake', [serviceId]);
  }

  /**
   * Encode rewards claiming transaction data
   */
  static encodeRewardsClaiming(): string {
    const iface = new Interface(OLAS_STAKING_ABI);
    return iface.encodeFunctionData('claim', []);
  }

  /**
   * Generic event parser for contract events
   */
  private static parseEventFromReceipt(
    receipt: any,
    abi: any[],
    eventName: string,
    fieldName: string
  ): number | null {
    const iface = new Interface(abi);
    
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed.name === eventName) {
          return Number(parsed.args[fieldName]);
        }
      } catch {
        // Not our event, continue
      }
    }
    return null;
  }

  /**
   * Parse CreateAgent event from transaction receipt
   */
  static parseCreateAgentEvent(receipt: any): number | null {
    return this.parseEventFromReceipt(receipt, AGENT_REGISTRY_ABI, 'CreateAgent', 'agentId');
  }

  /**
   * Parse CreateService event from transaction receipt
   */
  static parseCreateServiceEvent(receipt: any): number | null {
    return this.parseEventFromReceipt(receipt, SERVICE_REGISTRY_ABI, 'CreateService', 'serviceId');
  }

  /**
   * Generate a deterministic config hash for a service
   */
  static generateServiceConfigHash(
    agentIds: number[],
    agentParams: number[],
    threshold: number
  ): string {
    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['uint32[]', 'uint32[]', 'uint32'],
      [agentIds, agentParams, threshold]
    );
    return keccak256(encoded);
  }

  /**
   * Generate a simple agent hash (for demo purposes)
   */
  static generateAgentHash(agentId: number): string {
    const encoded = AbiCoder.defaultAbiCoder().encode(['uint256'], [agentId]);
    return keccak256(encoded);
  }

}

export default {
  AGENT_REGISTRY_ABI,
  SERVICE_REGISTRY_ABI,
  OLAS_STAKING_ABI,
  ServiceState,
  StakingState,
  OlasContractHelpers
};
