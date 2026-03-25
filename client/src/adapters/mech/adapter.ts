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
  submitMarketplaceRequest,
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
  private deferredEvaluations: Array<{ requestId: string; desiredState: import('../../types/index.js').DesiredState }> = [];

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
    // Post restoration request
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

    const restorationRequestIds = await submitMarketplaceRequest(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.mechMarketplaceAddress,
      this.config.mechContractAddress,
      restorationDataHex,
      deliveryRate,
      maxTimeout,
    );

    if (restorationRequestIds.length === 0) {
      throw new PermanentError('No request IDs returned from marketplace');
    }

    const restorationRequestId = restorationRequestIds[0];

    // Post linked evaluation request
    const evaluationState: DesiredState = {
      ...state,
      type: 'evaluation',
      attemptId: state.attemptId,
      attemptNumber: state.attemptNumber,
      restorationRequestId,
    };
    const evaluationPayload = buildDesiredStatePayload(evaluationState);
    const evaluationCid = await uploadToIpfs(this.config.ipfsRegistryUrl, evaluationPayload);
    const evaluationDataHex = cidToDigestHex(evaluationCid);

    await submitMarketplaceRequest(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.mechMarketplaceAddress,
      this.config.mechContractAddress,
      evaluationDataHex,
      deliveryRate,
      maxTimeout,
    );

    return restorationRequestId;
  }

  async *watchForRequests(): AsyncIterable<RestorationRequest> {
    while (!this.stopped) {
      try {
        console.error(`[mech] watchForRequests poll — deferred: ${this.deferredEvaluations.length}, cursor: ${this.requestBlockCursor}`);
        // Re-check deferred evaluation requests first
        if (this.deferredEvaluations.length > 0) {
          console.error(`[mech] Checking ${this.deferredEvaluations.length} deferred evaluation(s)`);
        }
        const stillDeferred: typeof this.deferredEvaluations = [];
        for (const deferred of this.deferredEvaluations) {
          const ready = await this.isEvaluationReady(deferred.desiredState);
          if (ready) {
            console.error(`[mech] Deferred evaluation ${deferred.requestId} is now ready`);
            yield { requestId: deferred.requestId, desiredState: deferred.desiredState };
          } else {
            stillDeferred.push(deferred);
          }
        }
        this.deferredEvaluations = stillDeferred;

        // Poll for new events
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

              // Evaluation requests: only yield after restoration has been delivered
              if (desiredState.type === 'evaluation' && desiredState.restorationRequestId) {
                if (await this.isEvaluationReady(desiredState)) {
                  yield { requestId, desiredState };
                } else {
                  // Defer — re-check on next poll
                  this.deferredEvaluations.push({ requestId, desiredState });
                }
                continue;
              }

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

  private async isEvaluationReady(desiredState: DesiredState): Promise<boolean> {
    if (!desiredState.restorationRequestId) return false;
    try {
      const info = await this.publicClient.readContract({
        address: this.config.mechMarketplaceAddress,
        abi: MECH_MARKETPLACE_ABI,
        functionName: 'mapRequestIdInfos',
        args: [desiredState.restorationRequestId as `0x${string}`],
      }) as [string, string, string, bigint, bigint, string];
      const deliveryMech = info[1];
      console.error(`[mech] isEvaluationReady: restorationRequestId=${desiredState.restorationRequestId.slice(0, 10)}... deliveryMech=${deliveryMech}`);
      return deliveryMech !== '0x0000000000000000000000000000000000000000';
    } catch (err) {
      console.error(`[mech] isEvaluationReady error:`, err);
      return false;
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
            try {
              // deliveryDataHex is the SHA256 digest of the result on IPFS
              const deliveryDigest = deliveryDataHex.startsWith('0x') ? deliveryDataHex.slice(2) : deliveryDataHex;
              const resultPayload = await fetchFromIpfs(this.config.ipfsGatewayUrl, `f01551220${deliveryDigest}`) as Record<string, unknown>;

              // We need the original desired state too — fetch from the request's data
              // The Deliver event includes the requestId but not the original requestData.
              // We look up the original request by scanning MarketplaceRequest events,
              // or we accept that the result payload includes enough context.
              const restorationResult: RestorationResult = {
                data: (resultPayload.data as string) ?? JSON.stringify(resultPayload),
                artifacts: resultPayload.artifacts as string[] | undefined,
              };

              // Construct a minimal desired state from the result payload
              // The result payload includes requestId which we can use to look up the state
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
