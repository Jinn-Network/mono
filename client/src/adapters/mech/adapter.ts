import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import type { ExecutionAdapter } from '../adapter.js';
import type {
  DesiredState,
  RequestId,
  RestorationRequest,
  RestorationResult,
  DeliveredResult,
} from '../../types/index.js';
import { TransientError, PermanentError } from '../../types/index.js';
import { createClients } from './safe.js';
import {
  buildDesiredStatePayload,
  buildResultPayload,
  uploadToIpfs,
  cidToDigestHex,
  fetchFromIpfs,
  digestHexToGatewayUrl,
  parseDesiredStateFromPayload,
} from './ipfs.js';
import {
  submitRestorationJob,
  submitEvaluationJob,
  claimDelivery,
  getMechDeliveryRate,
  getTimeoutBounds,
  decodeMarketplaceRequestLogs,
  decodeDeliverLogs,
  callDeliverToMarketplace,
} from './contracts.js';
import { type MechAdapterConfig, MECH_MARKETPLACE_ABI } from './types.js';

export class MechAdapter implements ExecutionAdapter {
  readonly name = 'mech';

  private publicClient!: PublicClient;
  private walletClient!: WalletClient;
  private config: MechAdapterConfig;
  private stopped = false;
  private requestBlockCursor = 0n;
  private deliveryBlockCursor = 0n;
  private pendingEvaluations = new Map<string, import('../../types/index.js').DesiredState>();
  private pendingEvaluationClaims = new Set<string>();

  constructor(config: MechAdapterConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const clients = createClients(
      this.config.rpcUrl,
      this.config.agentEoaPrivateKey,
    );
    this.publicClient = clients.publicClient;
    this.walletClient = clients.walletClient;

    const blockNumber = await this.publicClient.getBlockNumber();
    this.requestBlockCursor = blockNumber;
    this.deliveryBlockCursor = blockNumber;
  }

  async postDesiredState(state: DesiredState): Promise<RequestId> {
    const restorationState: DesiredState = {
      ...state,
      type: state.type ?? 'restoration',
      attemptId: state.attemptId,
      attemptNumber: state.attemptNumber,
    };
    const restorationPayload = buildDesiredStatePayload(restorationState);
    const restorationCid = await uploadToIpfs(this.config.ipfsRegistryUrl, restorationPayload);
    const restorationDataHex = cidToDigestHex(restorationCid);

    const deliveryRate = await getMechDeliveryRate(this.publicClient, this.config.mechContractAddress);
    const { max: maxTimeout } = await getTimeoutBounds(this.publicClient, this.config.mechMarketplaceAddress);

    const restorationRequestIds = await submitRestorationJob(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.routerAddress,
      this.config.mechContractAddress,
      restorationDataHex,
      deliveryRate,
      maxTimeout,
    );

    if (restorationRequestIds.length === 0) {
      throw new PermanentError('No request IDs returned from router');
    }

    const restorationRequestId = restorationRequestIds[0];

    // Store for evaluation creation after delivery is claimed
    this.pendingEvaluations.set(restorationRequestId, state);

    return restorationRequestId;
  }

  async *watchForRequests(): AsyncIterable<RestorationRequest> {
    while (!this.stopped) {
      try {
        const currentBlock = await this.publicClient.getBlockNumber();
        if (currentBlock > this.requestBlockCursor) {
          const logs = await this.publicClient.getLogs({
            address: this.config.mechMarketplaceAddress,
            fromBlock: this.requestBlockCursor + 1n,
            toBlock: currentBlock,
          });
          this.requestBlockCursor = currentBlock;

          const decoded = decodeMarketplaceRequestLogs(logs);
          for (const { requestId, requestDataHex } of decoded) {
            try {
              const digest = requestDataHex.startsWith('0x') ? requestDataHex.slice(2) : requestDataHex;
              const payload = await fetchFromIpfs(this.config.ipfsGatewayUrl, `f01551220${digest}`) as Record<string, unknown>;
              const desiredState = parseDesiredStateFromPayload(payload);

              yield { requestId, desiredState };
            } catch (err) {
              console.error(`[mech] Failed to parse request ${requestId}:`, err);
            }
          }
        }
      } catch (err) {
        console.error('[mech] Error polling for requests:', err);
      }

      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async claimRequest(_requestId: RequestId): Promise<void> {
    // Mech marketplace: claiming is implicit via delivery assignment
  }

  async submitResult(requestId: RequestId, result: RestorationResult): Promise<void> {
    const payload = buildResultPayload(requestId, result);
    const cid = await uploadToIpfs(this.config.ipfsRegistryUrl, payload);
    const deliveryDigest = cidToDigestHex(cid);

    // Safe → AgentMech.deliverToMarketplace() → Marketplace.deliverMarketplace()
    await callDeliverToMarketplace(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.mechContractAddress,
      [requestId as Hex],
      [deliveryDigest],
    );
  }

  async *watchForDeliveries(): AsyncIterable<DeliveredResult> {
    while (!this.stopped) {
      try {
        const currentBlock = await this.publicClient.getBlockNumber();
        if (currentBlock > this.deliveryBlockCursor) {
          const logs = await this.publicClient.getLogs({
            address: this.config.mechContractAddress,
            fromBlock: this.deliveryBlockCursor + 1n,
            toBlock: currentBlock,
          });
          this.deliveryBlockCursor = currentBlock;

          const decoded = decodeDeliverLogs(logs);
          for (const { requestId, deliveryDataHex, mechAddress } of decoded) {
            // Only claim deliveries for requests this client created
            const isOurs = this.pendingEvaluations.has(requestId) || this.pendingEvaluationClaims.has(requestId);
            if (!isOurs) continue;

            try {
              // Claim the delivery on the router
              await claimDelivery(
                this.publicClient,
                this.walletClient,
                this.config.safeAddress,
                this.config.routerAddress,
                requestId as `0x${string}`,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (message.includes('RequestNotFound')) {
                console.error(`[mech] claimDelivery skipped (not a router request): ${requestId}`);
                continue;
              }
              console.error(`[mech] claimDelivery failed for ${requestId}:`, err);
              // Don't remove from pending — will retry next poll
              continue;
            }

            // If this was a restoration delivery, post the evaluation job
            if (this.pendingEvaluations.has(requestId)) {
              const originalState = this.pendingEvaluations.get(requestId)!;
              try {
                const evaluationState: DesiredState = {
                  ...originalState,
                  type: 'evaluation',
                  restorationRequestId: requestId,
                };
                const evaluationPayload = buildDesiredStatePayload(evaluationState);
                const evaluationCid = await uploadToIpfs(this.config.ipfsRegistryUrl, evaluationPayload);
                const evaluationDataHex = cidToDigestHex(evaluationCid);

                const deliveryRate = await getMechDeliveryRate(this.publicClient, this.config.mechContractAddress);
                const { max: maxTimeout } = await getTimeoutBounds(this.publicClient, this.config.mechMarketplaceAddress);

                const evalRequestIds = await submitEvaluationJob(
                  this.publicClient,
                  this.walletClient,
                  this.config.safeAddress,
                  this.config.routerAddress,
                  requestId as `0x${string}`,
                  this.config.mechContractAddress,
                  evaluationDataHex,
                  deliveryRate,
                  maxTimeout,
                );

                if (evalRequestIds.length > 0) {
                  this.pendingEvaluationClaims.add(evalRequestIds[0]);
                }

                // Only remove after evaluation job succeeds
                this.pendingEvaluations.delete(requestId);
              } catch (err) {
                console.error(`[mech] Failed to create evaluation job for ${requestId}:`, err);
                // Don't remove from pendingEvaluations — will retry on next delivery detection
              }
            }

            // If this was an evaluation delivery, just clear the tracking
            if (this.pendingEvaluationClaims.has(requestId)) {
              this.pendingEvaluationClaims.delete(requestId);
            }

            // Parse and yield the delivery result
            try {
              const deliveryDigest = deliveryDataHex.startsWith('0x') ? deliveryDataHex.slice(2) : deliveryDataHex;
              const resultPayload = await fetchFromIpfs(this.config.ipfsGatewayUrl, `f01551220${deliveryDigest}`) as Record<string, unknown>;

              const restorationResult: RestorationResult = {
                data: (resultPayload.data as string) ?? JSON.stringify(resultPayload),
                artifacts: resultPayload.artifacts as string[] | undefined,
              };

              const desiredState: DesiredState = {
                id: (resultPayload.requestId as string) ?? requestId,
                description: (resultPayload.description as string) ?? '',
              };

              yield {
                requestId,
                desiredState,
                result: restorationResult,
                deliveryMechAddress: mechAddress,
              };
            } catch (err) {
              console.error(`[mech] Failed to parse delivery ${requestId}:`, err);
            }
          }
        }
      } catch (err) {
        console.error('[mech] Error polling for deliveries:', err);
      }

      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
