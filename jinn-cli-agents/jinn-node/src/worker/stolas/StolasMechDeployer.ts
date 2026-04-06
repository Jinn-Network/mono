/**
 * stOLAS Mech Deployer
 *
 * Deploys a mech contract via the service Safe by calling MechMarketplace.create().
 * The agent EOA (service Safe owner) signs + submits the Safe execTransaction.
 *
 * Same Safe tx pattern as MechMarketplaceRequester.ts — agent EOA is both signer
 * and submitter (pays gas).
 *
 * MechMarketplace.create(serviceId, mechFactory, payload)
 *   → emits CreateMech(address mech, uint256 serviceId, address mechFactory)
 *   → mech address parsed from receipt logs
 */

import { ethers } from 'ethers';
import { createRpcProvider } from '../../config/index.js';
import { logger } from '../../logging/index.js';
import {
  MECH_MARKETPLACE_ABI,
  MECH_FACTORY_ADDRESSES,
  DEFAULT_MECH_MARKETPLACE_ADDRESSES,
} from '../contracts/MechMarketplace.js';
import { DEFAULT_MECH_DELIVERY_RATE } from '../config/MechConfig.js';

const mechLogger = logger.child({ component: 'STOLAS-MECH-DEPLOYER' });

// Safe ABI — same subset as StolasServiceBootstrap.ts and MechMarketplaceRequester.ts
const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
];

export interface MechDeployConfig {
  rpcUrl: string;
  chain: string;
  serviceId: number;
  serviceSafeAddress: string;
  agentPrivateKey: string;        // plaintext hex — agent EOA is Safe owner
  mechType?: 'Native' | 'Token';
  requestPrice?: string;          // wei — defaults to DEFAULT_MECH_DELIVERY_RATE (99)
}

export interface MechDeployResult {
  success: boolean;
  mechAddress?: string;
  txHash?: string;
  error?: string;
}

/**
 * Deploy a mech contract by routing MechMarketplace.create() through the service Safe.
 *
 * The agent EOA must:
 *   - Be a signer on the service Safe (1-of-1 owner)
 *   - Have ETH for gas (minimum 0.001 ETH)
 *
 * Flow:
 *   1. Verify agent EOA has ETH for gas
 *   2. Encode MechMarketplace.create(serviceId, mechFactory, payload)
 *   3. Build Safe execTransaction (agent EOA signs + submits)
 *   4. Parse CreateMech event → mech address
 */
export async function deployMechViaSafe(config: MechDeployConfig): Promise<MechDeployResult> {
  const {
    rpcUrl,
    chain,
    serviceId,
    serviceSafeAddress,
    agentPrivateKey,
    mechType = 'Native',
    requestPrice = DEFAULT_MECH_DELIVERY_RATE,
  } = config;

  const chainLower = chain.toLowerCase();
  const marketplaceAddress = DEFAULT_MECH_MARKETPLACE_ADDRESSES[chainLower];
  if (!marketplaceAddress) {
    return { success: false, error: `No MechMarketplace address for chain: ${chain}` };
  }

  const chainFactories = MECH_FACTORY_ADDRESSES[chainLower];
  const factories = chainFactories?.[marketplaceAddress];
  const mechFactory = factories?.[mechType];
  if (!mechFactory) {
    return { success: false, error: `No ${mechType} MechFactory for ${chain} marketplace ${marketplaceAddress}` };
  }

  try {
    const provider = createRpcProvider(rpcUrl);
    const agentWallet = new ethers.Wallet(agentPrivateKey, provider);

    // 1. Verify agent EOA has ETH for gas
    const agentBalance = await provider.getBalance(agentWallet.address);
    const minGas = ethers.parseEther('0.001');
    if (agentBalance < minGas) {
      return {
        success: false,
        error: `Agent EOA ${agentWallet.address} has insufficient ETH for gas: ${ethers.formatEther(agentBalance)} ETH (need >= 0.001 ETH)`,
      };
    }

    mechLogger.info({
      serviceId,
      serviceSafe: serviceSafeAddress,
      agentEoa: agentWallet.address,
      agentBalance: ethers.formatEther(agentBalance),
      mechType,
      mechFactory,
      requestPrice,
    }, 'Deploying mech via service Safe');

    // 2. Encode MechMarketplace.create() calldata
    const marketplaceIface = new ethers.Interface(MECH_MARKETPLACE_ABI);
    // Payload is ABI-encoded uint256 (request price) — passed through to factory's createMech()
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [requestPrice]);
    const createCallData = marketplaceIface.encodeFunctionData('create', [
      serviceId,
      mechFactory,
      payload,
    ]);

    // 2b. Pre-flight: simulate the inner call to catch contract-level errors early
    try {
      const simResult = await provider.call({
        from: serviceSafeAddress,
        to: marketplaceAddress,
        data: createCallData,
      });
      const decodedAddr = ethers.AbiCoder.defaultAbiCoder().decode(['address'], simResult);
      mechLogger.info({ simulatedMech: decodedAddr[0] }, 'Pre-flight simulation succeeded');
    } catch (simErr) {
      const simMsg = simErr instanceof Error ? simErr.message : String(simErr);
      return {
        success: false,
        error: `Pre-flight simulation failed (inner call would revert): ${simMsg}`,
      };
    }

    // 3. Build, sign, and execute Safe transaction
    const safe = new ethers.Contract(serviceSafeAddress, SAFE_ABI, agentWallet);
    const safeNonce = await safe.nonce();

    mechLogger.debug({ safeNonce: Number(safeNonce) }, 'Service Safe nonce');

    const txHash = await safe.getTransactionHash(
      marketplaceAddress,           // to
      0,                            // value (no ETH sent)
      createCallData,               // data
      0,                            // operation (CALL)
      0,                            // safeTxGas
      0,                            // baseGas
      0,                            // gasPrice
      ethers.ZeroAddress,           // gasToken
      ethers.ZeroAddress,           // refundReceiver
      safeNonce,
    );

    // Sign with eth_sign format (v + 4 for Safe)
    const signature = await agentWallet.signMessage(ethers.getBytes(txHash));
    const sigBytes = ethers.getBytes(signature);
    const r = ethers.hexlify(sigBytes.slice(0, 32));
    const s = ethers.hexlify(sigBytes.slice(32, 64));
    const v = sigBytes[64] + 4;
    const adjustedSignature = ethers.concat([r, s, new Uint8Array([v])]);

    const tx = await safe.execTransaction(
      marketplaceAddress,
      0,
      createCallData,
      0,
      0,
      0,
      0,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      adjustedSignature,
      { gasLimit: 5_000_000 },
    );

    mechLogger.info({ txHash: tx.hash }, 'Safe execTransaction submitted, waiting for confirmation');
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      return {
        success: false,
        txHash: tx.hash,
        error: `Safe execTransaction reverted. txHash: ${tx.hash}`,
      };
    }

    // 4. Parse CreateMech event from receipt
    const mechAddress = parseMechAddressFromReceipt(receipt, serviceId);
    if (!mechAddress) {
      return {
        success: false,
        txHash: receipt.hash,
        error: 'Transaction succeeded but CreateMech event not found in logs',
      };
    }

    mechLogger.info({
      mechAddress,
      serviceId,
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
    }, 'Mech deployed successfully via service Safe');

    return {
      success: true,
      mechAddress,
      txHash: receipt.hash,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    mechLogger.error({ error: msg, serviceId }, 'Mech deployment failed');
    return { success: false, error: msg };
  }
}

/**
 * Parse mech address from CreateMech event in transaction receipt.
 * Same logic as MechMarketplace.ts:296-324.
 */
function parseMechAddressFromReceipt(receipt: ethers.TransactionReceipt, expectedServiceId: number): string | null {
  const iface = new ethers.Interface(MECH_MARKETPLACE_ABI);

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      if (parsed && parsed.name === 'CreateMech') {
        const mechAddress = parsed.args.mech;
        const serviceId = Number(parsed.args.serviceId);

        if (serviceId === expectedServiceId) {
          mechLogger.info({ mechAddress, serviceId }, 'Parsed CreateMech event');
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
 * Build the MECH_TO_CONFIG JSON value for a deployed mech address.
 * Matches the format used by services 378/379.
 */
export function buildMechToConfigValue(mechAddress: string): string {
  const config: Record<string, { use_dynamic_pricing: boolean; is_marketplace_mech: boolean }> = {
    [mechAddress]: {
      use_dynamic_pricing: false,
      is_marketplace_mech: true,
    },
  };
  return JSON.stringify(config);
}
