/**
 * MechMarketplace Contract Interface
 * 
 * Provides contract interaction utilities for the OLAS MechMarketplace,
 * which deploys Mech contracts for staked services.
 * 
 * Part of JINN-196: Deploy mech contract for service #149 through middleware
 */

import { AbiCoder, Contract, Interface, JsonRpcProvider, Wallet, parseUnits, zeroPadValue, toBeHex } from 'ethers';
import { createRpcProvider } from '../../config/index.js';
import { logger } from '../../logging/index.js';

const mechLogger = logger.child({ component: 'MECH-MARKETPLACE' });

// MechMarketplace ABI (from middleware code)
export const MECH_MARKETPLACE_ABI = [
  // create function — third param is dynamic `bytes`, NOT bytes32
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "mechFactory",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "payload",
        "type": "bytes"
      }
    ],
    "name": "create",
    "outputs": [
      {
        "internalType": "address",
        "name": "mech",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  // CreateMech event
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "mech",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "serviceId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "mechFactory",
        "type": "address"
      }
    ],
    "name": "CreateMech",
    "type": "event"
  }
];

/**
 * MechFactory addresses by chain and marketplace
 * Extracted from olas-operate-middleware/operate/services/utils/mech.py
 */
export const MECH_FACTORY_ADDRESSES: Record<string, Record<string, Record<string, string>>> = {
  // Gnosis chain
  gnosis: {
    "0xad380C51cd5297FbAE43494dD5D407A2a3260b58": {
      "Native": "0x42f43be9E5E50df51b86C5c6427223ff565f40C6",
      "Token": "0x161b862568E900Dd9d8c64364F3B83a43792e50f",
      "Nevermined": "0xCB26B91B0E21ADb04FFB6e5f428f41858c64936A",
    },
    "0x735FAAb1c4Ec41128c367AFb5c3baC73509f70bB": {
      "Native": "0x8b299c20F87e3fcBfF0e1B86dC0acC06AB6993EF",
      "Token": "0x31ffDC795FDF36696B8eDF7583A3D115995a45FA",
      "Nevermined": "0x65fd74C29463afe08c879a3020323DD7DF02DA57",
    },
  },
  // Base chain - from ai-registry-mech globals_base_mainnet.json
  base: {
    "0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020": {
      "Native": "0x2E008211f34b25A7d7c102403c6C2C3B665a1abe",
      "Token": "0x97371B1C0cDA1D04dFc43DFb50a04645b7Bc9BEe",
      "Nevermined": "0x847bBE8b474e0820215f818858e23F5f5591855A",
    },
  },
};

/**
 * Default mech marketplace addresses by chain
 */
export const DEFAULT_MECH_MARKETPLACE_ADDRESSES: Record<string, string> = {
  gnosis: "0x735FAAb1c4Ec41128c367AFb5c3baC73509f70bB",
  base: "0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020",
};

export interface MechDeploymentParams {
  serviceId: number;
  mechType: 'Native' | 'Token' | 'Nevermined';
  requestPrice: string; // In wei
  marketplaceAddress?: string; // Optional, uses default if not provided
}

export interface MechDeploymentResult {
  mechAddress: string;
  txHash: string;
  blockNumber: number;
  gasUsed: string;
}

/**
 * MechMarketplace contract manager
 */
export class MechMarketplace {
  private provider: JsonRpcProvider;
  private chain: string;
  private marketplaceAddress: string;

  constructor(rpcUrl: string, chain: string, marketplaceAddress?: string) {
    this.provider = createRpcProvider(rpcUrl);
    this.chain = chain.toLowerCase();
    this.marketplaceAddress = marketplaceAddress || DEFAULT_MECH_MARKETPLACE_ADDRESSES[this.chain];

    if (!this.marketplaceAddress) {
      throw new Error(`No default MechMarketplace address configured for chain: ${chain}`);
    }

    mechLogger.info({
      chain: this.chain,
      marketplaceAddress: this.marketplaceAddress,
      rpcUrl
    }, 'MechMarketplace initialized');
  }

  /**
   * Get mech factory address for the given mech type
   */
  getMechFactory(mechType: string): string {
    const chainFactories = MECH_FACTORY_ADDRESSES[this.chain];
    if (!chainFactories) {
      throw new Error(`Chain ${this.chain} not supported for mech deployment`);
    }

    const marketplaceFactories = chainFactories[this.marketplaceAddress];
    if (!marketplaceFactories) {
      mechLogger.warn({
        marketplaceAddress: this.marketplaceAddress,
        chain: this.chain
      }, 'Marketplace address not found, using default');

      // Fallback to default marketplace for this chain
      const defaultMarketplace = DEFAULT_MECH_MARKETPLACE_ADDRESSES[this.chain];
      const defaultFactories = chainFactories[defaultMarketplace];

      if (!defaultFactories) {
        throw new Error(`No factory addresses configured for chain ${this.chain}`);
      }

      const factory = defaultFactories[mechType];
      if (!factory) {
        throw new Error(`Mech type ${mechType} not supported for chain ${this.chain}`);
      }

      return factory;
    }

    const factory = marketplaceFactories[mechType];
    if (!factory) {
      throw new Error(`Mech type ${mechType} not supported for marketplace ${this.marketplaceAddress} on chain ${this.chain}`);
    }

    return factory;
  }

  /**
   * Encode mech creation transaction data
   */
  encodeMechCreation(params: MechDeploymentParams): string {
    const mechFactory = this.getMechFactory(params.mechType);
    const iface = new Interface(MECH_MARKETPLACE_ABI);

    // Encode request price as ABI-encoded uint256 bytes payload
    const payload = AbiCoder.defaultAbiCoder().encode(['uint256'], [params.requestPrice]);

    return iface.encodeFunctionData('create', [
      params.serviceId,
      mechFactory,
      payload
    ]);
  }

  /**
   * Deploy a mech contract (direct EOA call - for reference only)
   * 
   * Note: This will fail on Base because create() requires the caller to be
   * the service owner or service multisig. Use middleware's deployMech() instead.
   */
  async deployMech(
    params: MechDeploymentParams,
    agentPrivateKey: string
  ): Promise<MechDeploymentResult> {
    mechLogger.info({
      serviceId: params.serviceId,
      mechType: params.mechType,
      requestPrice: params.requestPrice,
      marketplaceAddress: this.marketplaceAddress
    }, 'Deploying mech contract');

    try {
      // Create signer from private key
      const signer = new Wallet(agentPrivateKey, this.provider);
      const signerAddress = await signer.getAddress();

      mechLogger.info({ signerAddress }, 'Using agent key as signer');

      // Create contract instance
      const contract = new Contract(
        this.marketplaceAddress,
        MECH_MARKETPLACE_ABI,
        signer
      );

      // Get mech factory address
      const mechFactory = this.getMechFactory(params.mechType);
      const payload = AbiCoder.defaultAbiCoder().encode(['uint256'], [params.requestPrice]);

      mechLogger.info({
        serviceId: params.serviceId,
        mechFactory,
        requestPrice: params.requestPrice
      }, 'Calling MechMarketplace.create()');

      // Call create function
      const tx = await contract.create(
        params.serviceId,
        mechFactory,
        payload
      );

      mechLogger.info({ txHash: tx.hash }, 'Transaction submitted, waiting for confirmation');

      // Wait for transaction to be mined
      const receipt = await tx.wait();

      if (!receipt) {
        throw new Error('Transaction receipt is null');
      }

      mechLogger.info({
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed?.toString()
      }, 'Transaction confirmed');

      // Parse CreateMech event to extract mech address
      const mechAddress = this.parseMechAddressFromReceipt(receipt, params.serviceId);

      if (!mechAddress) {
        throw new Error('CreateMech event not found in transaction receipt');
      }

      mechLogger.info({
        mechAddress,
        serviceId: params.serviceId,
        txHash: receipt.hash
      }, 'Mech deployed successfully');

      return {
        mechAddress,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed?.toString() || '0'
      };

    } catch (error) {
      mechLogger.error({
        error: error instanceof Error ? error.message : String(error),
        serviceId: params.serviceId,
        mechType: params.mechType
      }, 'Failed to deploy mech');
      throw error;
    }
  }

  /**
   * Parse mech address from CreateMech event in transaction receipt
   */
  private parseMechAddressFromReceipt(receipt: any, expectedServiceId: number): string | null {
    const iface = new Interface(MECH_MARKETPLACE_ABI);

    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({
          topics: log.topics as string[],
          data: log.data
        });

        if (parsed && parsed.name === 'CreateMech') {
          const mechAddress = parsed.args.mech;
          const serviceId = Number(parsed.args.serviceId);

          if (serviceId === expectedServiceId) {
            mechLogger.info({
              mechAddress,
              serviceId
            }, 'Parsed CreateMech event');
            return mechAddress;
          }
        }
      } catch {
        // Not our event, continue
      }
    }

    return null;
  }

  /**
   * Verify that a mech contract exists at the given address
   */
  async verifyMechContract(mechAddress: string): Promise<boolean> {
    try {
      const code = await this.provider.getCode(mechAddress);
      const hasCode = code !== '0x' && code.length > 2;

      mechLogger.info({
        mechAddress,
        hasCode,
        codeLength: code.length
      }, 'Verified mech contract');

      return hasCode;
    } catch (error) {
      mechLogger.error({
        error: error instanceof Error ? error.message : String(error),
        mechAddress
      }, 'Failed to verify mech contract');
      return false;
    }
  }

  /**
   * Get the provider instance
   */
  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  /**
   * Get the marketplace address
   */
  getMarketplaceAddress(): string {
    return this.marketplaceAddress;
  }
}

export default MechMarketplace;
