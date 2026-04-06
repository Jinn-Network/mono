/**
 * Transaction delivery: wrap mech-client deliver logic, including Safe/Operate adjustments
 */

import { deliverViaSafe } from '@jinn-network/mech-client-ts/dist/post_deliver.js';
import { Web3 } from 'web3';
import { workerLogger } from '../../logging/index.js';
import { getMechAddress, getServiceSafeAddress, getServicePrivateKey, getMechChainConfig } from '../../env/operate-profile.js';
import { getActiveMechAddress } from '../rotation/ActiveServiceContext.js';
import { acquireSafeLock } from '../safeTxMutex.js';
import type { UnclaimedRequest, AgentExecutionResult, FinalStatus, IpfsMetadata, RecognitionPhaseResult, ReflectionResult } from '../types.js';
import { buildDeliveryPayload } from './payload.js';
import { checkDeliveryStatusViaPonder } from './ponderVerification.js';
import { registerArtifactsOnChain } from './onchainRegister.js';
import { config, secrets } from '../../config/index.js';

/**
 * Known Safe error codes for decoding revert reasons
 */
const SAFE_ERROR_CODES: Record<string, string> = {
  GS000: 'Could not finish initialization',
  GS001: 'Threshold needs to be defined',
  GS010: 'Not enough gas to execute Safe transaction',
  GS011: 'Could not pay gas costs with ether',
  GS012: 'Could not pay gas costs with token',
  GS013: 'Safe transaction failed when gasPrice and safeTxGas were 0',
  GS020: 'Signatures data too short',
  GS021: 'Invalid contract signature location: inside static part',
  GS022: 'Invalid contract signature location: length not present',
  GS023: 'Invalid contract signature provided',
  GS024: 'Invalid owner provided by ecrecover (address(0))',
  GS025: 'Invalid owner provided by ecrecover (not an owner)',
  GS026: 'Invalid owner provided',
  GS030: 'Only owners can approve a hash',
  GS031: 'Method can only be called from this Safe',
};

/**
 * Decode revert data from a failed Safe transaction.
 * Returns a human-readable string or null if decoding fails.
 */
function decodeSafeRevertData(data: string | undefined): string | null {
  if (!data || data === '0x') return null;

  // Check for standard Error(string) selector: 0x08c379a0
  if (data.startsWith('0x08c379a0') && data.length >= 138) {
    try {
      const web3 = new Web3();
      const decoded = web3.eth.abi.decodeParameter('string', '0x' + data.slice(10));
      const reason = String(decoded);
      const safeExplanation = SAFE_ERROR_CODES[reason] || '';
      return safeExplanation ? `${reason}: ${safeExplanation}` : reason;
    } catch { /* fall through */ }
  }

  // Check for Panic(uint256) selector: 0x4e487b71
  if (data.startsWith('0x4e487b71') && data.length >= 74) {
    try {
      const web3 = new Web3();
      const code = web3.eth.abi.decodeParameter('uint256', '0x' + data.slice(10));
      return `Panic(${code})`;
    } catch { /* fall through */ }
  }

  // Check for custom error selectors (first 4 bytes)
  const selector = data.slice(0, 10);
  return `Unknown revert (selector: ${selector}, data length: ${data.length} bytes)`;
}

/**
 * Custom error for RPC verification failures
 */
export class RpcVerificationError extends Error {
  constructor(message: string, public metadata: Record<string, any>) {
    super(message);
    this.name = 'RpcVerificationError';
  }
}

/**
 * Delivery context for transaction
 */
export interface DeliveryTransactionContext {
  requestId: string;
  request: UnclaimedRequest;
  result: AgentExecutionResult;
  finalStatus: FinalStatus;
  metadata: IpfsMetadata;
  recognition?: RecognitionPhaseResult | null;
  reflection?: ReflectionResult | null;
  workerTelemetry?: any;
  measurementCoverage?: any;
  artifactsForDelivery?: Array<{ cid: string; topic: string; name?: string; type?: string; documentType?: string; contentPreview?: string }>;
}

/**
 * Track pending delivery transactions to prevent duplicates
 * Maps requestId -> { txHash, timestamp }
 */
const pendingDeliveries = new Map<string, { txHash: string; timestamp: number }>();

/**
 * Clear stale pending deliveries (older than 3 minutes)
 */
function clearStalePendingDeliveries(): void {
  const now = Date.now();
  const staleThreshold = 180000; // 3 minutes

  for (const [requestId, delivery] of pendingDeliveries.entries()) {
    if (now - delivery.timestamp > staleThreshold) {
      workerLogger.debug({ requestId, staleTxHash: delivery.txHash, ageMs: now - delivery.timestamp }, 'Clearing stale pending delivery');
      pendingDeliveries.delete(requestId);
    }
  }
}

/**
 * Check if request is undelivered on-chain
 */
export async function isUndeliveredOnChain(params: {
  mechAddress: string;
  requestIdHex: string;
  rpcHttpUrl?: string;
  maxRetries?: number;
}): Promise<boolean> {
  const { mechAddress, requestIdHex, rpcHttpUrl, maxRetries = 5 } = params; // Increase default retries

  if (!rpcHttpUrl) return true; // best-effort: if no RPC provided, don't block delivery

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const agentMechArtifact = await import('@jinn-network/mech-client-ts/dist/abis/AgentMech.json', { with: { type: 'json' } });
      const raw = (agentMechArtifact as any)?.default || agentMechArtifact;
      const abi: any = raw?.abi || (Array.isArray(raw) ? raw : null);
      if (!abi) {
        workerLogger.warn({ keys: Object.keys(raw || {}) }, 'Could not extract ABI from AgentMech artifact');
        return false;
      }
      const web3 = new Web3(rpcHttpUrl);
      const contract = new (web3 as any).eth.Contract(abi, mechAddress);

      const BATCH_SIZE = 100;
      let offset = 0;
      let isUndelivered = false;
      let totalFetched = 0;

      while (true) {
        const ids: string[] = await contract.methods.getUndeliveredRequestIds(BATCH_SIZE, offset).call();
        const batchSize = ids ? ids.length : 0;
        totalFetched += batchSize;

        const set = new Set((ids || []).map((x: string) => String(x).toLowerCase()));
        if (set.has(String(requestIdHex).toLowerCase())) {
          isUndelivered = true;
          break;
        }

        if (batchSize < BATCH_SIZE) break;

        offset += BATCH_SIZE;
        if (offset > 20000) {
          workerLogger.warn({ requestIdHex, offset }, 'Exceeded safety limit while paging undelivered requests; assuming delivered');
          break;
        }
      }

      if (!isUndelivered) {
        workerLogger.info({ requestIdHex, totalChecked: totalFetched }, 'RPC check: request not in undelivered set');
      }

      return isUndelivered;
    } catch (error: any) {
      lastError = error;

      if (attempt < maxRetries) {
        // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s
        const baseBackoff = Math.pow(2, attempt - 1) * 1000;
        const jitter = Math.random() * 500; // Add 0-500ms jitter
        const backoffMs = baseBackoff + jitter;

        workerLogger.warn({
          error: error?.message,
          attempt,
          maxRetries,
          backoffMs,
          requestIdHex
        }, `RPC delivery check failed (attempt ${attempt}/${maxRetries}, backoff ${Math.round(backoffMs)}ms): ${error?.message || 'unknown error'}`);

        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  // After RPC retries exhausted, don't throw yet - let caller decide fallback strategy
  workerLogger.error({
    error: lastError?.message,
    attempts: maxRetries,
    requestIdHex
  }, `RPC verification failed after ${maxRetries} attempts: ${lastError?.message || 'unknown error'}`);

  throw new RpcVerificationError(
    `RPC verification failed: ${lastError?.message}`,
    { attempts: maxRetries, lastError }
  );
}

/**
 * Check if a transaction emitted a RevokeRequest event
 */
export async function wasRequestRevoked(params: {
  txHash: string;
  requestIdHex: string;
  mechAddress: string;
  rpcHttpUrl?: string;
}): Promise<boolean> {
  const { txHash, requestIdHex, mechAddress, rpcHttpUrl } = params;
  try {
    if (!rpcHttpUrl) return false;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const agentMechArtifact = await import('@jinn-network/mech-client-ts/dist/abis/AgentMech.json', { with: { type: 'json' } });
    const raw = (agentMechArtifact as any)?.default || agentMechArtifact;
    const abi: any = raw?.abi || (Array.isArray(raw) ? raw : null);
    if (!abi) {
      workerLogger.warn({ keys: Object.keys(raw || {}) }, 'Could not extract ABI from AgentMech artifact');
      return false;
    }
    const web3 = new Web3(rpcHttpUrl);

    // Get transaction receipt
    const receipt = await web3.eth.getTransactionReceipt(txHash);
    if (!receipt || !receipt.logs) {
      workerLogger.debug({ txHash, hasReceipt: !!receipt, hasLogs: !!receipt?.logs }, 'No logs in receipt');
      return false;
    }

    // Parse logs for RevokeRequest event
    // Event signature: RevokeRequest(bytes32 requestId) - requestId is not indexed, so it's in data
    const contract = new (web3 as any).eth.Contract(abi, mechAddress);
    const revokeEventSignature = web3.utils.keccak256('RevokeRequest(bytes32)');

    workerLogger.debug({
      txHash,
      totalLogs: receipt.logs.length,
      revokeEventSignature,
      mechAddress
    }, 'Checking logs for RevokeRequest');

    for (const log of receipt.logs) {
      workerLogger.debug({
        logAddress: log.address,
        logTopics: log.topics,
        logData: log.data,
        matchesAddress: log.address.toLowerCase() === mechAddress.toLowerCase(),
        matchesSignature: log.topics[0] === revokeEventSignature
      }, 'Inspecting log');

      if (log.topics[0] === revokeEventSignature &&
        log.address.toLowerCase() === mechAddress.toLowerCase()) {
        // Decode the requestId from the data field (not topics, since it's not indexed)
        // data field is the raw bytes32 requestId
        const decodedRequestId = log.data;
        workerLogger.debug({ decodedRequestId, expectedRequestId: requestIdHex }, 'Found RevokeRequest event, checking requestId');
        if (decodedRequestId.toLowerCase() === requestIdHex.toLowerCase()) {
          workerLogger.warn({ txHash, requestId: requestIdHex }, 'RevokeRequest event detected for this request');
          return true;
        }
      }
    }
    workerLogger.debug({ txHash }, 'No RevokeRequest event found for this request');
    return false;
  } catch (e: any) {
    workerLogger.warn({ txHash, error: e?.message }, 'Failed to check for RevokeRequest event');
    return false;
  }
}

/**
 * Verify delivery using multiple strategies: RPC (fast) + Ponder (authoritative)
 * Returns true if request is still undelivered, false if already delivered
 */
async function verifyUndeliveredStatus(params: {
  mechAddress: string;
  requestIdHex: string;
  requestId: string;
  rpcHttpUrl?: string;
}): Promise<boolean> {
  const { mechAddress, requestIdHex, requestId, rpcHttpUrl } = params;

  // Strategy 1: Try RPC first (faster)
  try {
    const isUndelivered = await isUndeliveredOnChain({
      mechAddress,
      requestIdHex,
      rpcHttpUrl,
      maxRetries: 5,
    });

    workerLogger.info({ requestId, isUndelivered, method: 'rpc' },
      'Delivery status verified via RPC');
    return isUndelivered;

  } catch (error: any) {
    if (error instanceof RpcVerificationError) {
      workerLogger.warn({ requestId, error: error.message },
        'RPC verification failed; falling back to Ponder');

      // Strategy 2: Fallback to Ponder
      try {
        const ponderResult = await checkDeliveryStatusViaPonder({
          requestId,
          maxRetries: 3,
        });

        if (ponderResult.error) {
          workerLogger.error({ requestId, error: ponderResult.error },
            'Ponder verification also failed');
          throw new Error(`Both RPC and Ponder verification failed. RPC: ${error.message}, Ponder: ${ponderResult.error}`);
        }

        const isUndelivered = !ponderResult.delivered;
        workerLogger.info({ requestId, isUndelivered, method: 'ponder', txHash: ponderResult.txHash },
          'Delivery status verified via Ponder (fallback)');
        return isUndelivered;

      } catch (ponderError: any) {
        workerLogger.error({ requestId, rpcError: error.message, ponderError: ponderError.message },
          'Both RPC and Ponder verification failed');
        throw new Error(`Unable to verify delivery status via any method`);
      }
    }
    throw error;
  }
}

/**
 * Deliver result via Safe transaction
 */
export async function deliverViaSafeTransaction(
  context: DeliveryTransactionContext
): Promise<{ tx_hash?: string; status?: string }> {
  workerLogger.info({ requestId: context.requestId }, '[DELIVERY_START] Function entered');
  const chainConfig = getMechChainConfig() || 'base';
  const rpcHttpUrl = secrets.rpcUrl;

  // Always deliver through our own mech. The marketplace allows any mech to
  // deliver after cooldown, so we use the active service's mech + Safe regardless
  // of which mech the request was originally dispatched to.
  let targetMechAddress = getActiveMechAddress() ?? getMechAddress();
  const safeAddress = getServiceSafeAddress();
  const privateKey = getServicePrivateKey();

  if (!targetMechAddress) {
    workerLogger.warn('Missing mech delivery configuration; skipping on-chain delivery');
    throw new Error('Missing mech delivery configuration');
  }

  const isCrossMech = context.request.mech.toLowerCase() !== targetMechAddress.toLowerCase();
  if (isCrossMech) {
    workerLogger.info({
      requestId: context.requestId,
      requestMech: context.request.mech,
      deliveryMech: targetMechAddress,
    }, 'Cross-mech delivery: delivering via own mech');
  }

  workerLogger.info({ requestId: context.requestId, hasRpc: !!rpcHttpUrl, isCrossMech }, '[DELIVERY_START] Config loaded');

  if (!safeAddress || !privateKey) {
    workerLogger.warn({ safeAddress: !!safeAddress, privateKey: !!privateKey }, 'Missing Safe delivery configuration; skipping on-chain delivery');
    throw new Error('Missing Safe delivery configuration');
  }

  // Cross-mech delivery: if request's priority mech differs from ours, we can still
  // deliver after the responseTimeout expires. The on-chain MechMarketplace allows any
  // registered mech to deliver once the priority window has passed. We route the delivery
  // through OUR mech's deliverToMarketplace (which has onlyOperator for our Safe).
  const ownMechAddress = getMechAddress();
  if (ownMechAddress && targetMechAddress.toLowerCase() !== ownMechAddress.toLowerCase()) {
    // Check if the priority window has expired via the request's responseTimeout
    const responseTimeout = context.request.responseTimeout;
    const now = Math.floor(Date.now() / 1000);

    if (responseTimeout && now > responseTimeout) {
      workerLogger.info({
        requestId: context.requestId,
        priorityMech: targetMechAddress,
        ownMech: ownMechAddress,
        responseTimeout,
        secondsPastTimeout: now - responseTimeout,
      }, 'Cross-mech delivery: priority window expired — routing through own mech');
      // Override targetMechAddress to our own mech so deliverViaSafe calls
      // OUR mech's deliverToMarketplace (onlyOperator passes for our Safe).
      // The marketplace will accept this since the timeout has expired.
      targetMechAddress = ownMechAddress;
    } else {
      workerLogger.error({
        requestId: context.requestId,
        targetMech: targetMechAddress,
        ownMech: ownMechAddress,
        responseTimeout,
        now,
      }, 'Mech mismatch: request still within priority window or missing timeout data. Skipping delivery.');
      throw new Error(`Mech mismatch: request mech ${targetMechAddress} != worker mech ${ownMechAddress} (priority window not expired)`);
    }
  }

  // Check Safe deployment
  if (safeAddress && rpcHttpUrl) {
    try {
      const web3 = new Web3(rpcHttpUrl);
      const code = await web3.eth.getCode(safeAddress);
      if (!code || code === '0x' || code.length <= 2) {
        workerLogger.warn({ safeAddress }, 'Safe address has no contract code; skipping Safe delivery (use direct EOA delivery or deploy Safe first)');
        throw new Error('Safe address has no contract code');
      }
    } catch (deploymentCheckError: any) {
      workerLogger.warn({ safeAddress, error: deploymentCheckError?.message }, 'Failed to check Safe deployment; skipping Safe delivery');
      throw deploymentCheckError;
    }
  }

  // Preflight check: ensure request is undelivered
  const requestIdHex = String(context.requestId).startsWith('0x')
    ? String(context.requestId)
    : '0x' + BigInt(String(context.requestId)).toString(16);

  // Clear stale pending deliveries before checking
  clearStalePendingDeliveries();

  // Check if there's already a pending delivery for this request
  const pendingDelivery = pendingDeliveries.get(context.requestId);
  if (pendingDelivery) {
    const age = Date.now() - pendingDelivery.timestamp;
    workerLogger.warn({
      requestId: context.requestId,
      pendingTxHash: pendingDelivery.txHash,
      ageSeconds: Math.floor(age / 1000)
    }, 'Delivery already in progress for this request; will verify on-chain state');

    // Try to get the transaction receipt to see if it actually succeeded
    try {
      const web3 = new Web3(rpcHttpUrl);
      const receipt = await web3.eth.getTransactionReceipt(pendingDelivery.txHash);
      if (receipt) {
        // Transaction completed, clear from pending and check if successful
        pendingDeliveries.delete(context.requestId);
        workerLogger.info({
          requestId: context.requestId,
          txHash: pendingDelivery.txHash,
          status: receipt.status
        }, 'Previous pending transaction completed');

        if (receipt.status) {
          return { tx_hash: pendingDelivery.txHash, status: 'confirmed' };
        }
      } else {
        // Transaction still pending, reject duplicate
        workerLogger.warn({ requestId: context.requestId, pendingTxHash: pendingDelivery.txHash }, 'Previous transaction still pending');
        throw new Error('Delivery transaction already pending');
      }
    } catch (receiptError: any) {
      // Couldn't check receipt, be conservative and reject
      workerLogger.warn({ requestId: context.requestId, error: receiptError?.message }, 'Failed to check pending transaction status');
      throw new Error('Delivery transaction already pending (status unknown)');
    }
  }

  // For undelivered verification, always check the PRIORITY mech's undelivered list
  // (not our own mech, which wouldn't have the request in its list for cross-mech cases)
  const verifyMechAddress = context.request.mech;
  workerLogger.info({ requestId: context.requestId }, '[DELIVERY_VERIFY] Starting verification');
  const isUndelivered = await verifyUndeliveredStatus({
    mechAddress: verifyMechAddress,
    requestIdHex,
    requestId: context.requestId,
    rpcHttpUrl,
  });
  workerLogger.info({ requestId: context.requestId, isUndelivered }, '[DELIVERY_VERIFY] Verification complete');

  if (!isUndelivered) {
    workerLogger.info({ requestId: context.requestId, requestIdHex }, 'Delivery preflight: request already delivered or revoked; skipping new Safe tx');
    throw new Error('Request already delivered');
  }

  // Build delivery payload
  const resultContent = buildDeliveryPayload({
    requestId: context.requestId,
    result: context.result,
    metadata: context.metadata,
    recognition: context.recognition,
    reflection: context.reflection,
    workerTelemetry: context.workerTelemetry,
    finalStatus: context.finalStatus,
    measurementCoverage: context.measurementCoverage,
  });

  // Add artifacts if provided
  if (context.artifactsForDelivery && context.artifactsForDelivery.length > 0) {
    resultContent.artifacts = context.artifactsForDelivery;
  }

  const payload = {
    chainConfig,
    requestId: String(context.requestId),
    resultContent,
    targetMechAddress,
    safeAddress,
    privateKey,
    ...(rpcHttpUrl ? { rpcHttpUrl } : {}),
    wait: true,
  } as const;

  workerLogger.info({ requestId: context.requestId }, '[DELIVERY_DEBUG] Starting delivery transaction attempt');

  // Get agent wallet address for nonce debugging
  const web3ForNonce = new Web3(rpcHttpUrl || secrets.rpcUrl);
  const agentAccount = web3ForNonce.eth.accounts.privateKeyToAccount(privateKey);
  const agentAddress = agentAccount.address;

  let delivery: any;
  // Increased retries for nonce issues - sometimes pending tx backlog needs time to clear
  const maxRetries = 5;
  let lastError: Error | undefined;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Fetch fresh nonce before each attempt for debugging (DEBUG level - see Blood Written Rule #31)
      try {
        const latestNonce = await web3ForNonce.eth.getTransactionCount(agentAddress, 'latest');
        const pendingNonce = await web3ForNonce.eth.getTransactionCount(agentAddress, 'pending');
        workerLogger.debug({
          requestId: context.requestId,
          attempt,
          agentAddress,
          latestNonce: Number(latestNonce),
          pendingNonce: Number(pendingNonce),
          pendingTxCount: Number(pendingNonce) - Number(latestNonce),
        }, 'Pre-delivery nonce check');
      } catch (nonceErr: any) {
        workerLogger.debug({ requestId: context.requestId, error: nonceErr.message }, 'Failed to fetch nonce for debug');
      }

      if (attempt > 0) {
        // Longer backoff for nonce issues: 15s, 30s, 60s, 120s, 240s
        const backoffMs = Math.min(Math.pow(2, attempt) * 7500, 240000);
        workerLogger.info({ requestId: context.requestId, attempt, backoffMs, maxRetries }, 'Retrying Safe delivery');
        await new Promise(r => setTimeout(r, backoffMs));

        // Re-check delivery status before retry
        try {
          const isUndelivered = await verifyUndeliveredStatus({
            mechAddress: targetMechAddress,
            requestIdHex,
            requestId: context.requestId,
            rpcHttpUrl,
          });
          if (!isUndelivered) {
            workerLogger.info({ requestId: context.requestId }, 'Request already delivered on retry check');
            return { status: 'confirmed' };
          }
        } catch (e: any) {
          // If we can't verify state on retry, fail fast
          workerLogger.error({ requestId: context.requestId, error: e.message }, 'Cannot verify delivery state on retry; aborting');
          throw new Error(`Unable to verify delivery state: ${e.message}`);
        }
      }

      try {
        workerLogger.info({ requestId: context.requestId, attempt }, '[DELIVERY_DEBUG] Calling deliverViaSafe');
        // Acquire per-Safe mutex so delivery and dispatch never overlap nonces
        const releaseDeliveryLock = await acquireSafeLock(safeAddress);
        try {
          delivery = await (deliverViaSafe as any)(payload);
        } finally {
          releaseDeliveryLock();
        }
        workerLogger.info({ requestId: context.requestId, txHash: delivery?.tx_hash, status: delivery?.status }, '[DELIVERY_DEBUG] deliverViaSafe returned');

        // Track the transaction hash immediately after submission
        if (delivery?.tx_hash) {
          pendingDeliveries.set(context.requestId, {
            txHash: delivery.tx_hash,
            timestamp: Date.now()
          });
          workerLogger.debug({ requestId: context.requestId, txHash: delivery.tx_hash }, 'Tracking delivery transaction');
        }

        break; // Success
      } catch (e: any) {
        lastError = e;

        // Extract detailed error info for debugging
        const rawRevertData = e.data || e.innerError?.data || e.cause?.data;
        const decodedRevert = decodeSafeRevertData(rawRevertData);
        const errorDetails = {
          message: e.message,
          code: e.code,
          reason: e.reason,
          data: e.data,
          rawRevertData,
          decodedRevert,
          // Web3 specific
          innerError: e.innerError?.message,
          innerErrorData: e.innerError?.data,
          cause: e.cause?.message,
          causeData: e.cause?.data,
          // Transaction details if available
          receipt: e.receipt ? { status: e.receipt.status, gasUsed: e.receipt.gasUsed?.toString() } : undefined,
          // Stack trace (first 500 chars)
          stack: e.stack?.slice(0, 500),
        };
        workerLogger.error({ requestId: context.requestId, attempt, errorDetails },
          `Safe delivery error: ${decodedRevert || e.message}`);

        // GS013-specific diagnostic: inner call to deliverToMarketplace reverted
        if (e.message?.includes('GS013')) {
          workerLogger.error({
            requestId: context.requestId,
            safeAddress,
            targetMech: targetMechAddress,
            activeMech: getActiveMechAddress(),
            isCrossMech,
          }, 'GS013: Inner call to deliverToMarketplace reverted. Likely mech↔safe authorization mismatch — the Safe calling the mech is not its operator.');
        }

        // Only retry on specific transient errors
        if (e.message?.includes('nonce too low') || e.message?.includes('replacement transaction underpriced')) {
          // Extract nonce info from error for debugging
          const nonceMatch = e.message?.match(/next nonce (\d+), tx nonce (\d+)/);
          const expectedNonce = nonceMatch ? nonceMatch[1] : 'unknown';
          const usedNonce = nonceMatch ? nonceMatch[2] : 'unknown';
          workerLogger.warn({
            requestId: context.requestId,
            error: e.message,
            expectedNonce,
            usedNonce,
            nonceGap: nonceMatch ? parseInt(nonceMatch[1]) - parseInt(nonceMatch[2]) : 'unknown',
            attempt,
            remainingRetries: maxRetries - attempt
          }, 'Safe delivery nonce issue; will retry');
          continue;
        }

        // Handle "Transaction not found" - check if it actually succeeded on-chain
        if (e.message?.includes('Transaction not found')) {
          workerLogger.warn({ requestId: context.requestId, error: e.message }, 'Transaction not found error; verifying on-chain status');
          try {
            const stillUndelivered = await verifyUndeliveredStatus({
              mechAddress: targetMechAddress,
              requestIdHex,
              requestId: context.requestId,
              rpcHttpUrl,
            });

            if (!stillUndelivered) {
              workerLogger.info({ requestId: context.requestId }, 'Recovered from Transaction not found - verified delivered via hybrid check');
              // We don't have the hash, but we know it succeeded
              return { status: 'confirmed', tx_hash: undefined };
            }
          } catch (verifyErr: any) {
            workerLogger.error({ requestId: context.requestId, error: verifyErr.message }, 'Hybrid verification failed after Transaction not found');
            throw verifyErr; // Propagate the error instead of continuing
          }
        }

        throw e; // Fail fast on other errors (no more timeout retries since we have 60s wait)
      }
    }

    if (!delivery && lastError) throw lastError;

    workerLogger.info({ requestId: context.requestId, tx: delivery?.tx_hash, status: delivery?.status }, '[DELIVERY_DEBUG] Delivered via Safe - SUCCESS PATH');

    // Check if the transaction actually revoked the request instead of delivering
    if (delivery?.tx_hash) {
      const wasRevoked = await wasRequestRevoked({
        txHash: delivery.tx_hash,
        requestIdHex,
        mechAddress: targetMechAddress,
        rpcHttpUrl,
      });

      if (wasRevoked) {
        workerLogger.error({ requestId: context.requestId, tx: delivery.tx_hash }, 'Request was REVOKED instead of delivered - likely contract state issue');
        throw new Error('Request was revoked by the Mech contract during delivery');
      }
    }

    // Best-effort ADW on-chain registration (non-blocking, never throws)
    if (context.artifactsForDelivery && context.artifactsForDelivery.length > 0) {
      registerArtifactsOnChain(context.artifactsForDelivery).catch(() => { });
    }

    workerLogger.info({ requestId: context.requestId, txHash: delivery?.tx_hash }, '[DELIVERY_DEBUG] About to return from deliverViaSafeTransaction');
    return {
      tx_hash: delivery?.tx_hash,
      status: delivery?.status,
    };
  } finally {
    // Clean up pending delivery tracking on completion (success or failure)
    if (context.requestId && pendingDeliveries.has(context.requestId)) {
      pendingDeliveries.delete(context.requestId);
      workerLogger.debug({ requestId: context.requestId }, 'Cleared pending delivery tracking');
    }
    workerLogger.info({ requestId: context.requestId }, '[DELIVERY_DEBUG] Exiting finally block');
  }
}
