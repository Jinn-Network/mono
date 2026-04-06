/**
 * OLAS Contract Manager
 * 
 * This class provides a high-level interface for interacting with OLAS protocol
 * contracts via ethers.js, including proper transaction construction and event parsing.
 * 
 * Part of JINN-150 Slice 2: Service Creation and Registration Refactoring
 */

import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes, TransactionReceipt } from 'ethers';
import { createRpcProvider } from '../../config/index.js';
import { TransactionRequest, TransactionPayload } from '../types/transaction.js';
import { 
  AGENT_REGISTRY_ABI, 
  SERVICE_REGISTRY_ABI, 
  OLAS_STAKING_ABI,
  OlasContractHelpers,
  ServiceState,
  StakingState 
} from './OlasContractInterfaces.js';
import { logger } from '../../logging/index.js';

const contractLogger = logger.child({ component: 'OLAS-CONTRACTS' });

export interface ContractAddresses {
  agentRegistry: string;
  serviceRegistry: string;
  stakingContract?: string;
}

export interface AgentDetails {
  agentId: number;
  owner: string;
  exists: boolean;
  hashes: string[];
}

export interface ServiceDetails {
  serviceId: number;
  owner: string;
  configHash: string;
  agentIds: number[];
  agentParams: number[];
  threshold: number;
  state: ServiceState;
}

export class OlasContractManager {
  private provider: JsonRpcProvider;
  private addresses: ContractAddresses;

  constructor(rpcUrl: string, addresses: ContractAddresses) {
    this.provider = createRpcProvider(rpcUrl);
    this.addresses = addresses;

    contractLogger.info({
      rpcUrl,
      addresses: this.addresses
    }, 'OlasContractManager initialized');
  }

  /**
   * Create agent registry contract instance
   */
  private createAgentRegistryContract(): Contract {
    return new Contract(
      this.addresses.agentRegistry,
      AGENT_REGISTRY_ABI,
      this.provider
    );
  }

  /**
   * Create service registry contract instance
   */
  private createServiceRegistryContract(): Contract {
    return new Contract(
      this.addresses.serviceRegistry,
      SERVICE_REGISTRY_ABI,
      this.provider
    );
  }

  /**
   * Create staking contract instance
   */
  private createStakingContract(): Contract | null {
    if (!this.addresses.stakingContract) {
      return null;
    }
    return new Contract(
      this.addresses.stakingContract,
      OLAS_STAKING_ABI,
      this.provider
    );
  }

  /**
   * Create a transaction request for agent registration
   */
  createAgentRegistrationTransaction(
    agentOwner: string,
    agentId: number,
    requestId?: string
  ): TransactionRequest {
    const agentHash = OlasContractHelpers.generateAgentHash(agentId);
    const data = OlasContractHelpers.encodeAgentCreation(agentOwner, agentHash);

    const payload: TransactionPayload = {
      to: this.addresses.agentRegistry,
      data,
      value: '0'
    };

    return {
      id: requestId || `agent-${agentId}-${Date.now()}`,
      status: 'PENDING',
      attempt_count: 0,
      payload_hash: keccak256(toUtf8Bytes(JSON.stringify(payload))),
      worker_id: null,
      claimed_at: null,
      completed_at: null,
      payload,
      chain_id: 8453, // Base network
      execution_strategy: 'SAFE',
      idempotency_key: `agent-registration-${agentId}`,
      safe_tx_hash: null,
      tx_hash: null,
      error_code: null,
      error_message: null,
      source_job_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  /**
   * Create a transaction request for service creation
   */
  createServiceCreationTransaction(
    serviceOwner: string,
    agentIds: number[],
    threshold: number,
    maxSlots: number,
    requestId?: string
  ): TransactionRequest {
    // For OLAS services, agentParams typically represent the number of slots per agent
    const agentParams = new Array(agentIds.length).fill(maxSlots);
    const configHash = OlasContractHelpers.generateServiceConfigHash(agentIds, agentParams, threshold);
    
    const data = OlasContractHelpers.encodeServiceCreation(
      serviceOwner,
      configHash,
      agentIds,
      agentParams,
      threshold
    );

    const payload: TransactionPayload = {
      to: this.addresses.serviceRegistry,
      data,
      value: '0'
    };

    return {
      id: requestId || `service-create-${Date.now()}`,
      status: 'PENDING',
      attempt_count: 0,
      payload_hash: keccak256(toUtf8Bytes(JSON.stringify(payload))),
      worker_id: null,
      claimed_at: null,
      completed_at: null,
      payload,
      chain_id: 8453, // Base network
      execution_strategy: 'SAFE',
      idempotency_key: `service-creation-${agentIds.join('-')}-${threshold}`,
      safe_tx_hash: null,
      tx_hash: null,
      error_code: null,
      error_message: null,
      source_job_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  /**
   * Create a transaction request for service activation
   */
  createServiceActivationTransaction(
    serviceId: number,
    bondAmount: string,
    requestId?: string
  ): TransactionRequest {
    const data = OlasContractHelpers.encodeServiceActivation(serviceId);

    const payload: TransactionPayload = {
      to: this.addresses.serviceRegistry,
      data,
      value: bondAmount
    };

    return {
      id: requestId || `service-activate-${serviceId}-${Date.now()}`,
      status: 'PENDING',
      attempt_count: 0,
      payload_hash: keccak256(toUtf8Bytes(JSON.stringify(payload))),
      worker_id: null,
      claimed_at: null,
      completed_at: null,
      payload,
      chain_id: 8453, // Base network
      execution_strategy: 'SAFE',
      idempotency_key: `service-activation-${serviceId}`,
      safe_tx_hash: null,
      tx_hash: null,
      error_code: null,
      error_message: null,
      source_job_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  /**
   * Create a transaction request for service staking
   */
  createServiceStakingTransaction(
    serviceId: number,
    requestId?: string
  ): TransactionRequest {
    if (!this.addresses.stakingContract) {
      throw new Error('Staking contract address is not configured');
    }

    const data = OlasContractHelpers.encodeServiceStaking(serviceId);

    const payload: TransactionPayload = {
      to: this.addresses.stakingContract,
      data,
      value: '0'
    };

    return {
      id: requestId || `service-stake-${serviceId}-${Date.now()}`,
      status: 'PENDING',
      attempt_count: 0,
      payload_hash: keccak256(toUtf8Bytes(JSON.stringify(payload))),
      worker_id: null,
      claimed_at: null,
      completed_at: null,
      payload,
      chain_id: 8453, // Base network
      execution_strategy: 'SAFE',
      idempotency_key: `service-staking-${serviceId}`,
      safe_tx_hash: null,
      tx_hash: null,
      error_code: null,
      error_message: null,
      source_job_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  /**
   * Create a transaction request for service unstaking
   */
  createServiceUnstakingTransaction(
    serviceId: number,
    requestId?: string
  ): TransactionRequest {
    if (!this.addresses.stakingContract) {
      throw new Error('Staking contract address is not configured');
    }

    const data = OlasContractHelpers.encodeServiceUnstaking(serviceId);

    const payload: TransactionPayload = {
      to: this.addresses.stakingContract,
      data,
      value: '0'
    };

    return {
      id: requestId || `service-unstake-${serviceId}-${Date.now()}`,
      status: 'PENDING',
      attempt_count: 0,
      payload_hash: keccak256(toUtf8Bytes(JSON.stringify(payload))),
      worker_id: null,
      claimed_at: null,
      completed_at: null,
      payload,
      chain_id: 8453, // Base network
      execution_strategy: 'SAFE',
      idempotency_key: `service-unstaking-${serviceId}`,
      safe_tx_hash: null,
      tx_hash: null,
      error_code: null,
      error_message: null,
      source_job_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  /**
   * Create a transaction request for rewards claiming
   */
  createRewardsClaimingTransaction(
    requestId?: string
  ): TransactionRequest {
    if (!this.addresses.stakingContract) {
      throw new Error('Staking contract address is not configured');
    }

    const data = OlasContractHelpers.encodeRewardsClaiming();

    const payload: TransactionPayload = {
      to: this.addresses.stakingContract,
      data,
      value: '0'
    };

    return {
      id: requestId || `rewards-claim-${Date.now()}`,
      status: 'PENDING',
      attempt_count: 0,
      payload_hash: keccak256(toUtf8Bytes(JSON.stringify(payload))),
      worker_id: null,
      claimed_at: null,
      completed_at: null,
      payload,
      chain_id: 8453, // Base network
      execution_strategy: 'SAFE',
      idempotency_key: `rewards-claiming-${Date.now()}`,
      safe_tx_hash: null,
      tx_hash: null,
      error_code: null,
      error_message: null,
      source_job_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  /**
   * Parse agent ID from transaction receipt
   */
  parseAgentIdFromReceipt(receipt: TransactionReceipt): number | null {
    return OlasContractHelpers.parseCreateAgentEvent(receipt);
  }

  /**
   * Parse service ID from transaction receipt
   */
  parseServiceIdFromReceipt(receipt: TransactionReceipt): number | null {
    return OlasContractHelpers.parseCreateServiceEvent(receipt);
  }


  /**
   * Check if an agent exists and get its details
   */
  async getAgentDetails(agentId: number): Promise<AgentDetails | null> {
    try {
      const contract = this.createAgentRegistryContract();

      const exists = await contract.exists(agentId);
      if (!exists) {
        return null;
      }

      const owner = await contract.ownerOf(agentId);
      const [numHashes, hashes] = await contract.getHashes(agentId);

      return {
        agentId,
        owner,
        exists: true,
        hashes: hashes.map((h: string) => h)
      };

    } catch (error) {
      contractLogger.error({ 
        error, 
        agentId 
      }, 'Failed to get agent details');
      return null;
    }
  }

  /**
   * Check if a service exists and get its details
   */
  async getServiceDetails(serviceId: number): Promise<ServiceDetails | null> {
    try {
      const contract = this.createServiceRegistryContract();

      const exists = await contract.exists(serviceId);
      if (!exists) {
        return null;
      }

      const owner = await contract.ownerOf(serviceId);
      const [serviceOwner, configHash, agentIds, agentParams, threshold, state] = 
        await contract.getService(serviceId);

      return {
        serviceId,
        owner: serviceOwner,
        configHash,
        agentIds: agentIds.map((id: bigint) => Number(id)),
        agentParams: agentParams.map((param: bigint) => Number(param)),
        threshold: Number(threshold),
        state: Number(state) as ServiceState
      };

    } catch (error) {
      contractLogger.error({ 
        error, 
        serviceId 
      }, 'Failed to get service details');
      return null;
    }
  }

  /**
   * Find services owned by a specific address that use a required agent ID
   */
  async findCompatibleServices(
    owner: string, 
    requiredAgentId: number
  ): Promise<ServiceDetails[]> {
    try {
      contractLogger.info({ 
        owner, 
        requiredAgentId 
      }, 'Searching for compatible services');

      // This is a simplified implementation
      // In a production system, you'd want to use event filtering or indexing
      const compatibleServices: ServiceDetails[] = [];

      // Check service IDs 1-1000 (this should be optimized with proper indexing)
      for (let serviceId = 1; serviceId <= 1000; serviceId++) {
        const serviceDetails = await this.getServiceDetails(serviceId);
        
        if (serviceDetails && 
            serviceDetails.owner.toLowerCase() === owner.toLowerCase() &&
            serviceDetails.agentIds.includes(requiredAgentId)) {
          compatibleServices.push(serviceDetails);
        }

        // Avoid rate limiting
        if (serviceId % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      contractLogger.info({ 
        owner, 
        requiredAgentId,
        foundServices: compatibleServices.length 
      }, 'Compatible service search completed');

      return compatibleServices;

    } catch (error) {
      contractLogger.error({ 
        error, 
        owner, 
        requiredAgentId 
      }, 'Failed to find compatible services');
      return [];
    }
  }

  /**
   * Get the provider instance for external use
   */
  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  /**
   * Get contract addresses
   */
  getAddresses(): ContractAddresses {
    return this.addresses;
  }

  /**
   * Check if a service is staked
   */
  async isServiceStaked(serviceId: number): Promise<boolean> {
    try {
      const contract = this.createStakingContract();
      if (!contract) {
        return false;
      }

      const [stakingState] = await contract.getServiceStakingState(serviceId);
      return Number(stakingState) === StakingState.Staked;

    } catch (error) {
      contractLogger.error({ 
        error, 
        serviceId 
      }, 'Failed to check service staking status');
      return false;
    }
  }

  /**
   * Get staked service IDs for an account
   */
  async getStakedServiceIds(account: string): Promise<number[]> {
    try {
      const contract = this.createStakingContract();
      if (!contract) {
        return [];
      }

      const serviceIds = await contract.getStakedServiceIds(account);
      return serviceIds.map((id: bigint) => Number(id));

    } catch (error) {
      contractLogger.error({ 
        error, 
        account 
      }, 'Failed to get staked service IDs');
      return [];
    }
  }
}
