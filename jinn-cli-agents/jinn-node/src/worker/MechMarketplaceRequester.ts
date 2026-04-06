/**
 * Mech Marketplace Requester
 * 
 * Implements Safe-based marketplace requests using the mech-client-ts Safe SDK.
 * Based on the proven pattern from scripts/submit-marketplace-request-165.ts.
 * 
 * JINN-209: Safe-based mech marketplace request/deliver flow
 *
 * Used by:
 * - heartbeat.ts: submits heartbeat requests with `prompt` string
 * - safe-dispatch.ts: submits dispatch requests with pre-built `requestData`
 */

import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../logging/index.js';
import { createRpcProvider } from '../config/index.js';
import { pushMetadataToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import { acquireSafeLock } from './safeTxMutex.js';
import { DEFAULT_MECH_DELIVERY_RATE } from './config/MechConfig.js';

const requestLogger = logger.child({ component: 'MECH-MARKETPLACE-REQUESTER' });

// Native payment type hash (keccak256 of native payment identifier)
const NATIVE_PAYMENT_TYPE = '0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1';

export interface MarketplaceRequestParams {
  // Service configuration
  serviceSafeAddress: string;
  agentEoaPrivateKey: string;
  mechContractAddress: string;
  mechMarketplaceAddress: string;

  // Request parameters — provide either prompt (IPFS upload) or requestData (pre-built hex)
  prompt?: string;
  requestData?: string; // Pre-built request data hex — skips IPFS upload when provided
  requestPriceWei?: string; // Optional, defaults to mech's maxDeliveryRate

  // Optional extra attributes to include in IPFS payload (e.g. workstreamId, jobName)
  ipfsExtraAttributes?: Record<string, unknown>;

  // Network configuration
  rpcUrl: string;
  chainId?: number;

  // Optional dispatch parameters
  responseTimeout?: number; // Seconds — clamped to contract [min, max] bounds
  validateNativePayment?: boolean; // When true, throw if mech payment type is not native
}

export interface MarketplaceRequestResult {
  success: boolean;
  transactionHash?: string;
  requestId?: string;
  requestIds?: string[]; // All request IDs parsed from MarketplaceRequest event
  gasUsed?: string;
  blockNumber?: number;
  error?: string;
}

// ABIs
const MECH_MARKETPLACE_ABI = [
  'function request(bytes memory requestData, uint256 maxDeliveryRate, bytes32 paymentType, address priorityMech, uint256 responseTimeout, bytes memory paymentData) external payable returns (bytes32 requestId)',
  'function minResponseTimeout() view returns (uint256)',
  'function maxResponseTimeout() view returns (uint256)',
  'event MarketplaceRequest(address indexed priorityMech, address indexed requester, uint256 numRequests, bytes32[] requestIds, bytes[] requestDatas)',
];

const MECH_ABI = [
  'function paymentType() view returns (bytes32)',
  'function maxDeliveryRate() view returns (uint256)',
];

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
];

/**
 * Submit a marketplace request via Safe
 * 
 * Uses the same Safe transaction pattern as deliverViaSafe in mech-client-ts
 */
/**
 * Parse MarketplaceRequest event from a transaction receipt to extract request IDs.
 */
function extractRequestIds(receipt: ethers.TransactionReceipt): string[] {
  const iface = new ethers.Interface(MECH_MARKETPLACE_ABI);
  const requestIds: string[] = [];

  for (const eventLog of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: eventLog.topics as string[], data: eventLog.data });
      if (parsed?.name === 'MarketplaceRequest') {
        const ids = parsed.args.requestIds || parsed.args[3];
        if (Array.isArray(ids)) {
          for (const id of ids) {
            requestIds.push(String(id));
          }
        }
      }
    } catch {
      // Not a MarketplaceRequest event — skip
    }
  }

  return requestIds;
}

/**
 * Submit a marketplace request via Safe.
 *
 * Supports two modes:
 * - **Prompt mode** (heartbeat): provide `prompt` — uploads to IPFS via pushMetadataToIpfs
 * - **RequestData mode** (dispatch): provide `requestData` — uses pre-built hex directly
 *
 * Uses the same Safe transaction pattern as deliverViaSafe in mech-client-ts.
 */
export async function submitMarketplaceRequest(
  params: MarketplaceRequestParams
): Promise<MarketplaceRequestResult> {
  const {
    serviceSafeAddress,
    agentEoaPrivateKey,
    mechContractAddress,
    mechMarketplaceAddress,
    prompt,
    requestPriceWei,
    rpcUrl,
  } = params;

  if (!params.prompt && !params.requestData) {
    return { success: false, error: 'Either prompt or requestData must be provided' };
  }

  try {
    requestLogger.info({
      serviceSafeAddress,
      mechContractAddress,
      mechMarketplaceAddress,
      mode: params.requestData ? 'requestData' : 'prompt',
    }, 'Submitting marketplace request via Safe');

    // 1. Setup provider and wallet
    const provider = createRpcProvider(rpcUrl);
    const agentWallet = new ethers.Wallet(agentEoaPrivateKey, provider);

    // 2. Check Safe balance
    const serviceSafeBalance = await provider.getBalance(serviceSafeAddress);
    requestLogger.debug({
      serviceSafeAddress,
      balance: ethers.formatEther(serviceSafeBalance),
    }, 'Service Safe balance');

    // 3. Build request data — either from prompt (IPFS upload) or pre-built hex
    let requestData: string;
    if (params.requestData) {
      requestData = params.requestData;
      requestLogger.debug('Using pre-built requestData (skipping IPFS upload)');
    } else {
      requestLogger.info({ promptLength: prompt!.length }, 'Uploading prompt to IPFS');
      const [digestHex, ipfsHash] = await pushMetadataToIpfs(prompt!, 'openai-gpt-4', {
        requestTimestamp: Date.now(),
        mechAddress: mechContractAddress,
        ...params.ipfsExtraAttributes,
      });
      requestData = digestHex;
      requestLogger.info({
        requestData,
        ipfsHash,
        ipfsUrl: `https://gateway.autonolas.tech/ipfs/${ipfsHash}`
      }, 'Prompt uploaded to IPFS');
    }

    // 4. Query mech for payment type and max delivery rate
    const mech = new ethers.Contract(mechContractAddress, MECH_ABI, provider);
    const [mechPaymentType, mechMaxDeliveryRate] = await Promise.all([
      mech.paymentType(),
      mech.maxDeliveryRate(),
    ]);

    // Validate native payment type if requested
    if (params.validateNativePayment) {
      const paymentTypeHex = String(mechPaymentType).toLowerCase();
      if (paymentTypeHex !== NATIVE_PAYMENT_TYPE) {
        return {
          success: false,
          error: `Unsupported payment type: ${paymentTypeHex}. Only native (${NATIVE_PAYMENT_TYPE}) is supported.`,
        };
      }
    }

    requestLogger.debug({
      mechPaymentType,
      mechMaxDeliveryRate: mechMaxDeliveryRate.toString(),
    }, 'Mech parameters');

    // JINN-449: Warn if priority mech's on-chain rate differs from our hardcoded rate.
    // External mechs in the staking pool may have rate != 99.
    if (mechMaxDeliveryRate !== BigInt(DEFAULT_MECH_DELIVERY_RATE)) {
      requestLogger.warn({
        mechRate: mechMaxDeliveryRate.toString(),
        requestRate: DEFAULT_MECH_DELIVERY_RATE,
        mechContractAddress,
      }, 'Priority mech on-chain rate differs from request rate — using hardcoded rate');
    }

    // Use provided price or mech's max delivery rate
    const finalPrice = requestPriceWei ? BigInt(requestPriceWei) : mechMaxDeliveryRate;

    // Check if Safe has sufficient balance
    if (serviceSafeBalance < finalPrice) {
      return {
        success: false,
        error: `Insufficient balance in Safe. Available: ${ethers.formatEther(serviceSafeBalance)} ETH, Needed: ${ethers.formatEther(finalPrice)} ETH`,
      };
    }

    // 5. Query marketplace for timeout bounds and clamp
    const marketplace = new ethers.Contract(mechMarketplaceAddress, MECH_MARKETPLACE_ABI, provider);
    const [minTimeout, maxTimeout] = await Promise.all([
      marketplace.minResponseTimeout(),
      marketplace.maxResponseTimeout(),
    ]);

    const minT = Number(minTimeout);
    const maxT = Number(maxTimeout);
    // Use caller's timeout if provided, otherwise use maxTimeout (existing behavior)
    const requestedTimeout = params.responseTimeout ?? maxT;
    const clampedTimeout = Math.max(minT, Math.min(maxT, requestedTimeout));

    if (clampedTimeout !== requestedTimeout) {
      requestLogger.debug({ requested: requestedTimeout, clamped: clampedTimeout, min: minT, max: maxT },
        'Response timeout clamped to contract bounds');
    }

    // 6. Encode marketplace request call
    // JINN-449: Use our hardcoded rate (99), NOT the priority mech's on-chain rate.
    // External mechs in the staking pool may have rate 100, which would allow
    // any mech with rate ≤ 100 to deliver — bypassing our rate constraint.
    const requestMaxDeliveryRate = BigInt(DEFAULT_MECH_DELIVERY_RATE);
    const marketplaceCallData = marketplace.interface.encodeFunctionData('request', [
      requestData,              // bytes (single request data)
      requestMaxDeliveryRate,   // uint256 — hardcoded to 99 (JINN-449)
      mechPaymentType,          // bytes32
      mechContractAddress,      // address (priority mech)
      clampedTimeout,           // uint256
      '0x',                     // bytes (payment data)
    ]);

    // 7. Build and sign Safe transaction (under mutex to prevent nonce collisions)
    const releaseLock = await acquireSafeLock(serviceSafeAddress);
    try {
      const safe = new ethers.Contract(serviceSafeAddress, SAFE_ABI, agentWallet);
      const safeNonce = await safe.nonce();
      requestLogger.debug({ safeNonce: Number(safeNonce) }, 'Safe nonce');

      const txHash = await safe.getTransactionHash(
        mechMarketplaceAddress,
        finalPrice,
        marketplaceCallData,
        0,                        // operation (CALL)
        0,                        // safeTxGas
        0,                        // baseGas
        0,                        // gasPrice
        ethers.ZeroAddress,       // gasToken
        ethers.ZeroAddress,       // refundReceiver
        safeNonce,
      );

      // Sign (eth_sign format — v + 4 for Safe)
      const signature = await agentWallet.signMessage(ethers.getBytes(txHash));
      const sigBytes = ethers.getBytes(signature);
      const r = ethers.hexlify(sigBytes.slice(0, 32));
      const s = ethers.hexlify(sigBytes.slice(32, 64));
      const v = sigBytes[64] + 4;
      const adjustedSignature = ethers.concat([r, s, new Uint8Array([v])]);

      // 8. Execute Safe transaction
      const tx = await safe.execTransaction(
        mechMarketplaceAddress,
        finalPrice,
        marketplaceCallData,
        0,                        // operation
        0,                        // safeTxGas
        0,                        // baseGas
        0,                        // gasPrice
        ethers.ZeroAddress,       // gasToken
        ethers.ZeroAddress,       // refundReceiver
        adjustedSignature,
      );

      requestLogger.info({ transactionHash: tx.hash }, 'Transaction sent, waiting for confirmation');
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        return {
          success: false,
          error: 'Transaction failed',
          transactionHash: tx.hash,
        };
      }

      // 9. Parse request IDs from MarketplaceRequest event
      const requestIds = extractRequestIds(receipt);

      requestLogger.info({
        transactionHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
        requestIds,
      }, 'Marketplace request submitted successfully');

      return {
        success: true,
        transactionHash: receipt.hash,
        requestIds,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
      };
    } finally {
      releaseLock();
    }

  } catch (error) {
    requestLogger.error({
      error: error instanceof Error ? error.message : String(error),
      serviceSafeAddress,
    }, 'Failed to submit marketplace request');

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Load agent EOA private key from middleware .operate/keys directory
 */
export async function loadAgentPrivateKey(
  middlewarePath: string,
  agentEoaAddress: string
): Promise<string | null> {
  try {
    const keyPath = join(middlewarePath, '.operate', 'keys', agentEoaAddress);
    const keyContent = await fs.readFile(keyPath, 'utf-8');
    const keyData = JSON.parse(keyContent);
    const privateKey = keyData.private_key;

    if (!privateKey || typeof privateKey !== 'string') {
      requestLogger.error({
        agentEoaAddress,
        hasKey: !!privateKey,
        keyType: typeof privateKey,
      }, 'Private key not found or invalid format');
      return null;
    }

    return privateKey;
  } catch (error) {
    requestLogger.error({
      error: error instanceof Error ? error.message : String(error),
      agentEoaAddress,
    }, 'Failed to load agent private key');
    return null;
  }
}

