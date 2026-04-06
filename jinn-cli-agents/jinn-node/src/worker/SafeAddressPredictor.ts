/**
 * Safe Address Predictor
 * 
 * Predicts the address of a Gnosis Safe before it's deployed.
 * This is critical for funding operations - users can fund the predicted address
 * before deployment, avoiding the chicken-and-egg problem.
 * 
 * Based on Safe's CREATE2 deployment pattern.
 */

import { ethers } from 'ethers';
import { logger } from '../logging/index.js';

const predictorLogger = logger.child({ component: "SAFE-ADDRESS-PREDICTOR" });

export interface SafePrediction {
  predictedAddress: string;
  deployer: string;
  singleton: string;
  initializer: string;
  saltNonce: string;
}

export class SafeAddressPredictor {
  /**
   * Predict the address of a Safe before deployment
   * 
   * WARNING: This is a best-effort prediction based on Safe's standard deployment.
   * The actual address may differ if:
   * - The Safe factory uses a different singleton version
   * - The initialization parameters differ
   * - The salt nonce is different
   * 
   * @param owners Array of owner addresses (for 1/1 Safe, this is [agentKey])
   * @param threshold Signature threshold (for 1/1 Safe, this is 1)
   * @param factoryAddress Safe factory contract address
   * @param singletonAddress Safe singleton contract address
   * @param saltNonce Salt nonce for CREATE2 (default: 0)
   */
  static predictAddress(
    owners: string[],
    threshold: number,
    factoryAddress: string,
    singletonAddress: string,
    saltNonce: bigint = 0n
  ): SafePrediction {
    try {
      // Sort owners (Safe requires sorted owners)
      const sortedOwners = [...owners].sort((a, b) => {
        const aBig = BigInt(a);
        const bBig = BigInt(b);
        return aBig < bBig ? -1 : aBig > bBig ? 1 : 0;
      });

      // Build the Safe setup call
      const safeInterface = new ethers.Interface([
        'function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver)'
      ]);

      const initializer = safeInterface.encodeFunctionData('setup', [
        sortedOwners,
        threshold,
        ethers.ZeroAddress, // to
        '0x', // data
        ethers.ZeroAddress, // fallbackHandler
        ethers.ZeroAddress, // paymentToken
        0, // payment
        ethers.ZeroAddress // paymentReceiver
      ]);

      // Build the proxy deployment data (minimal proxy pattern)
      const proxyCreationCode = this.buildProxyCreationCode(singletonAddress);

      // Build the full deployment data (creation code + initializer)
      const deploymentData = ethers.concat([
        proxyCreationCode,
        ethers.AbiCoder.defaultAbiCoder().encode(['bytes'], [initializer])
      ]);

      // Calculate the salt
      const salt = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'uint256'],
          [ethers.keccak256(initializer), saltNonce]
        )
      );

      // Calculate the CREATE2 address
      const predictedAddress = ethers.getCreate2Address(
        factoryAddress,
        salt,
        ethers.keccak256(deploymentData)
      );

      predictorLogger.info({
        predictedAddress,
        owners: sortedOwners,
        threshold,
        factory: factoryAddress,
        singleton: singletonAddress,
        saltNonce: saltNonce.toString()
      }, "Predicted Safe address");

      return {
        predictedAddress,
        deployer: factoryAddress,
        singleton: singletonAddress,
        initializer,
        saltNonce: saltNonce.toString()
      };
    } catch (error) {
      predictorLogger.error({ error }, "Failed to predict Safe address");
      throw error;
    }
  }

  /**
   * Build the proxy creation code for a minimal proxy (EIP-1167)
   * This follows the pattern used by Safe's GnosisSafeProxyFactory
   */
  private static buildProxyCreationCode(singleton: string): string {
    // EIP-1167 minimal proxy bytecode
    // 0x3d602d80600a3d3981f3363d3d373d3d3d363d73{singleton}5af43d82803e903d91602b57fd5bf3
    const singletonAddress = singleton.toLowerCase().replace('0x', '');
    
    return ethers.concat([
      '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
      ethers.getBytes(`0x${singletonAddress}`),
      '0x5af43d82803e903d91602b57fd5bf3'
    ]);
  }

  /**
   * Get Safe contract addresses for a given chain
   * These are the canonical Safe v1.3.0 deployments
   */
  static getSafeAddresses(chainId: number): {
    factory: string;
    singleton: string;
  } {
    // Safe v1.3.0 addresses (same across most chains via CREATE2)
    const SAFE_SINGLETON_ADDRESS = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552';
    const SAFE_FACTORY_ADDRESS = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2';

    // Chain-specific overrides if needed
    const chainSpecific: Record<number, { factory: string; singleton: string }> = {
      // Add chain-specific addresses here if they differ
    };

    if (chainSpecific[chainId]) {
      return chainSpecific[chainId];
    }

    return {
      factory: SAFE_FACTORY_ADDRESS,
      singleton: SAFE_SINGLETON_ADDRESS
    };
  }
}

/**
 * Helper function to predict a 1/1 Safe address (most common case for OLAS agents)
 */
export function predict1of1SafeAddress(
  agentKey: string,
  chain: 'base' | 'gnosis' | 'ethereum',
  saltNonce: bigint = 0n
): SafePrediction {
  const chainIds = {
    base: 8453,
    gnosis: 100,
    ethereum: 1
  };

  const chainId = chainIds[chain];
  const { factory, singleton } = SafeAddressPredictor.getSafeAddresses(chainId);

  return SafeAddressPredictor.predictAddress(
    [agentKey], // Single owner
    1,          // 1/1 multisig
    factory,
    singleton,
    saltNonce
  );
}
