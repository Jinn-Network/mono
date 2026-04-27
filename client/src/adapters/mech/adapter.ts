import { ZodError } from 'zod';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { keccak256 } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { ExecutionAdapter } from '../adapter.js';
import type {
  RestorationJob,
  RequestId,
  RestorationRequest,
  RestorationResult,
  DeliveredResult,
} from '../../types/index.js';
import { TransientError, PermanentError, parseRestorationJob } from '../../types/index.js';
import { createClients } from './safe.js';
import {
  buildRestorationJobPayload,
  buildResultPayload,
  uploadToIpfs,
  cidToDigestHex,
  fetchFromIpfs,
  fetchSignedIntentFromIpfs,
  fetchSignedEnvelopeFromIpfs,
  digestHexToGatewayUrl,
  parseRestorationJobFromPayload,
} from './ipfs.js';
import { canonicalJson } from '../../restorer/engine/canonical-json.js';
import { SignedEnvelopeSchema } from '../../types/envelope.js';
import {
  submitRestorationJob,
  submitEvaluationJob,
  claimDelivery,
  getMechDeliveryRate,
  getTimeoutBounds,
  decodeMarketplaceRequestLogs,
  decodeDeliverLogs,
  callDeliverToMarketplace,
  scanRestorationJobs,
  scanEvaluationJobs,
  scanLatestRequestDataByRid,
  scanLatestDeliveryDataByRid,
  findLatestDeliveryDataHexForRequest,
} from './contracts.js';
import { type MechAdapterConfig, MECH_MARKETPLACE_ABI } from './types.js';
import type { Store } from '../../store/store.js';
import { type ClaimPolicy, AcceptAllPolicy } from './claim-policy.js';
import { withRecoverableRetry } from '../../tx-retry.js';
import { formatRpcError } from '../../rpc-error-context.js';
import { RESTORATION_INTENT_CID_CONTEXT_KEY, RESTORATION_ENVELOPE_CID_CONTEXT_KEY } from '../../restorer/impls/evaluation-context.js';

export class MechAdapter implements ExecutionAdapter {
  readonly name = 'mech';

  private publicClient!: PublicClient;
  private walletClient!: WalletClient;
  private config: MechAdapterConfig;
  private stopped = false;
  private requestBlockCursor = 0n;
  private deliveryBlockCursor = 0n;
  private pendingEvaluations = new Map<string, import('../../types/index.js').RestorationJob>();
  private pendingEvaluationClaims = new Set<string>();
  // Restoration requests where claimDelivery succeeded but evaluation creation failed.
  // Swept on each poll cycle so they don't require a new Deliver event.
  private claimedButNotEvaluated = new Set<string>();
  // Restoration result content cached across evaluation-job retries so a transient
  // Safe/router failure does not silently strip evaluator context on the next poll.
  private pendingEvaluationResults = new Map<string, string>();
  // IPFS CID of the restoration envelope — threaded into evaluation context so
  // evaluators can populate restorationEnvelope.cid without a synchronous IPFS fetch.
  private pendingEvaluationResultCids = new Map<string, string>();
  // RIDs with no delivery found in backfill window; avoids repeated 500k-block rescans.
  private backfillMissRids = new Set<string>();
  // Original desired states keyed by request ID (restoration and evaluation)
  // so we can yield accurate restorationJob in DeliveredResult
  private originalStates = new Map<string, RestorationJob>();
  private store?: Store;
  private claimPolicy: ClaimPolicy;

  constructor(config: MechAdapterConfig, store?: Store) {
    this.config = config;
    this.store = store;
    this.claimPolicy = config.claimPolicy ?? new AcceptAllPolicy();
  }

  async initialize(): Promise<void> {
    const chain = this.config.chainId === 84532 ? baseSepolia : base;
    const clients = createClients(
      this.config.rpcUrl,
      this.config.agentEoaPrivateKey,
      chain,
    );
    this.publicClient = clients.publicClient;
    this.walletClient = clients.walletClient;

    const blockNumber = await withRecoverableRetry(
      async () => this.publicClient.getBlockNumber(),
      {
        onRetry: ({ attempt, message }) => {
          console.error(
            `[mech] getBlockNumber retry ${attempt}: ` +
            formatRpcError(message, {
              operation: 'getBlockNumber',
              chain: this.config.chainId === 84532 ? 'base-sepolia' : 'base',
              rpcUrl: this.config.rpcUrl,
            }),
          );
        },
      },
    );
    this.requestBlockCursor = blockNumber;
    this.deliveryBlockCursor = blockNumber;

    // Recover pending state from on-chain events
    if (this.store) {
      await this.recoverPendingState(blockNumber);
    }
  }

  private async recoverPendingState(currentBlock: bigint): Promise<void> {
    const fromBlock = this.store?.getLastProcessedBlock() ?? currentBlock;
    if (fromBlock >= currentBlock) return;

    console.error(`[mech] Recovering pending state from block ${fromBlock} to ${currentBlock}`);

    // Scan for restoration jobs this creator posted
    const restorations = await scanRestorationJobs(
      this.publicClient,
      this.config.routerAddress,
      this.config.safeAddress,
      fromBlock,
      currentBlock,
    );

    // Scan for evaluation jobs this creator posted
    const evaluations = await scanEvaluationJobs(
      this.publicClient,
      this.config.routerAddress,
      this.config.safeAddress,
      fromBlock,
      currentBlock,
    );

    // Build set of restoration IDs that already have evaluation jobs
    const hasEvaluation = new Set(evaluations.map(e => e.restorationRequestId));

    // Check each restoration's delivery status
    for (const restoration of restorations) {
      if (hasEvaluation.has(restoration.requestId)) {
        // Evaluation already created — check if eval delivery needs claiming
        const evalJob = evaluations.find(e => e.restorationRequestId === restoration.requestId);
        if (evalJob) {
          const evalInfo = await this.publicClient.readContract({
            address: this.config.mechMarketplaceAddress,
            abi: MECH_MARKETPLACE_ABI,
            functionName: 'mapRequestIdInfos',
            args: [evalJob.requestId as `0x${string}`],
          }) as [string, string, string, bigint, bigint, string];
          if (evalInfo[1] === '0x0000000000000000000000000000000000000000') {
            // Evaluation not yet delivered — track it
            this.pendingEvaluationClaims.add(evalJob.requestId);
          }
          // If delivered, fully complete — nothing to track
        }
        continue;
      }

      // No evaluation job yet — check delivery status
      const info = await this.publicClient.readContract({
        address: this.config.mechMarketplaceAddress,
        abi: MECH_MARKETPLACE_ABI,
        functionName: 'mapRequestIdInfos',
        args: [restoration.requestId as `0x${string}`],
      }) as [string, string, string, bigint, bigint, string];

      const deliveryMech = info[1];
      if (deliveryMech === '0x0000000000000000000000000000000000000000') {
        // Not delivered yet — track for evaluation after delivery
        this.pendingEvaluations.set(restoration.requestId, {
          id: restoration.requestId,
          description: '', // Original description not available from events, but not needed for evaluation creation
        });
      } else {
        // Delivered but no evaluation — needs claim + evaluation creation
        this.pendingEvaluations.set(restoration.requestId, {
          id: restoration.requestId,
          description: '',
        });
        this.claimedButNotEvaluated.add(restoration.requestId);
      }
    }

    // Set delivery block cursor to scan from recovery point
    this.deliveryBlockCursor = fromBlock;

    const latestRequestDataByRid = await scanLatestRequestDataByRid(
      this.publicClient,
      this.config.mechMarketplaceAddress,
      fromBlock,
      currentBlock,
    );
    const latestDeliveryDataByRid = await scanLatestDeliveryDataByRid(
      this.publicClient,
      this.config.mechContractAddress,
      fromBlock,
      currentBlock,
    );

    for (const { requestId } of restorations) {
      const pe = this.pendingEvaluations.get(requestId);
      if (!pe) continue;

      const requestDataHex = latestRequestDataByRid.get(requestId.toLowerCase());
      if (requestDataHex) {
        const d = String(requestDataHex);
        const digest = d.startsWith('0x') ? d.slice(2) : d;
        this.pendingEvaluations.set(requestId, {
          ...pe,
          context: { ...pe.context, [RESTORATION_INTENT_CID_CONTEXT_KEY]: `f01551220${digest}` },
        });
      }

      const deliveryDataHex = latestDeliveryDataByRid.get(requestId.toLowerCase());
      if (deliveryDataHex) {
        try {
          const d = String(deliveryDataHex);
          const dig = d.startsWith('0x') ? d.slice(2) : d;
          const envelopeCid = `f01551220${dig}`;
          const payload = (await fetchFromIpfs(
            this.config.ipfsGatewayUrl,
            envelopeCid,
          )) as Record<string, unknown>;
          this.pendingEvaluationResults.set(
            requestId,
            (payload.data as string) ?? JSON.stringify(payload),
          );
          this.pendingEvaluationResultCids.set(requestId, envelopeCid);
          this.backfillMissRids.delete(requestId);
        } catch (err) {
          console.error(`[mech] recovery: could not load restoration result IPFS for ${requestId}:`, err);
        }
      }
    }

    const recovered = this.pendingEvaluations.size + this.pendingEvaluationClaims.size + this.claimedButNotEvaluated.size;
    if (recovered > 0) {
      console.error(`[mech] Recovered: ${this.pendingEvaluations.size} pending evaluations, ${this.pendingEvaluationClaims.size} pending eval claims, ${this.claimedButNotEvaluated.size} claimed but not evaluated`);
    }
  }

  async postRestorationJob(state: RestorationJob): Promise<RequestId> {
    const restorationState: RestorationJob = {
      ...state,
      type: state.type ?? 'restoration',
      attemptId: state.attemptId,
      attemptNumber: state.attemptNumber,
    };
    // When a pre-built SignedIntentV1 is attached, upload it directly so the
    // on-chain CID points to the canonical signed intent document rather than
    // the legacy RestorationJobPayload shape.
    const ipfsDoc: unknown = state.intent ?? buildRestorationJobPayload(restorationState);
    const restorationCid = await uploadToIpfs(this.config.ipfsRegistryUrl, ipfsDoc);
    const restorationDataHex = cidToDigestHex(restorationCid);
    const digestNo0x = restorationDataHex.startsWith('0x') ? restorationDataHex.slice(2) : restorationDataHex;
    const restorationIntentCid = `f01551220${digestNo0x}`;

    const deliveryRate = await getMechDeliveryRate(this.publicClient, this.config.mechContractAddress);
    const { max: maxTimeout } = await getTimeoutBounds(this.publicClient, this.config.mechMarketplaceAddress);

    const restorationJob = await submitRestorationJob(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.routerAddress,
      this.config.mechContractAddress,
      restorationDataHex,
      deliveryRate,
      maxTimeout,
    );
    const restorationRequestIds = restorationJob.requestIds;

    if (restorationRequestIds.length === 0) {
      throw new PermanentError(
        'No request IDs returned from router ' +
        `(tx=${restorationJob.txHash}, router=${this.config.routerAddress}, safe=${this.config.safeAddress}, ` +
        `mech=${this.config.mechContractAddress}, receiptLogs=${restorationJob.receiptLogCount}, chainId=${this.config.chainId})`,
      );
    }

    const restorationRequestId = restorationRequestIds[0];

    // Store for evaluation creation after delivery is claimed. The evaluation
    // job’s IPFS CID is different from the restoration intended-state CID; evaluators
    // need the latter to verify submission.intent.cid (see context.restorationIntentCid).
    const stateForEval: RestorationJob = {
      ...state,
      context: { ...(state.context ?? {}), [RESTORATION_INTENT_CID_CONTEXT_KEY]: restorationIntentCid },
    };
    this.pendingEvaluations.set(restorationRequestId, stateForEval);
    this.originalStates.set(restorationRequestId, { ...stateForEval, type: 'restoration' });

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
          for (const { requestId, requestDataHex, priorityMech, transactionHash, blockNumber } of decoded) {
            if (!this.claimPolicy.shouldAccept({ requestId, requestDataHex, priorityMech })) {
              continue;
            }
            try {
              const digest = requestDataHex.startsWith('0x') ? requestDataHex.slice(2) : requestDataHex;
              // CIDv1 hex with raw codec (0x55) + sha2-256 (0x12) + 32-byte length (0x20).
              // The Autonolas registry returns raw-codec CIDs when uploading files with
              // cid-version=1 (Kubo default for files). This is confirmed by the existing
              // IPFS_GATEWAY_PREFIX constant (f01551220) which has worked in production.
              // If the gateway ever switches to dag-pb (0x70) the prefix would be f01701220.
              const intentCid = `f01551220${digest}`;
              // Try to parse as a typed SignedIntentV1 first (Plan B envelope).
              // Fall back to the legacy loose payload shape for older on-chain data.
              let restorationJob: RestorationJob;
              try {
                const signed = await fetchSignedIntentFromIpfs(this.config.ipfsGatewayUrl, intentCid);
                restorationJob = parseRestorationJob({ intent: signed });
              } catch (err) {
                if (!(err instanceof ZodError)) throw err;
                // Fallback: pre-envelope legacy payload. Will be removed in Plan C (one-shot cutover).
                console.debug(
                  `[adapters/mech] intent.v1 parse failed for CID ${intentCid}; falling back to legacy payload parser`,
                );
                const payload = (await fetchFromIpfs(this.config.ipfsGatewayUrl, intentCid)) as Record<string, unknown>;
                restorationJob = parseRestorationJobFromPayload(payload);
              }

              yield {
                requestId,
                restorationJob,
                intentCid,
                onchainCreationTx: transactionHash,
                onchainCreationBlock: blockNumber,
              };
            } catch (err) {
              console.error(`[mech] Failed to parse request ${requestId}:`, err);
            }
          }
        }
      } catch (err) {
        console.error('[mech] Error polling for requests:', formatRpcError(err, {
          operation: 'pollMarketplaceRequests',
          chain: this.config.chainId === 84532 ? 'base-sepolia' : 'base',
          rpcUrl: this.config.rpcUrl,
          contract: this.config.mechMarketplaceAddress,
          fromBlock: this.requestBlockCursor + 1n,
        }));
      }

      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async claimRequest(requestId: RequestId): Promise<void> {
    const allowed = await this.claimPolicy.confirmClaim(requestId);
    if (!allowed) {
      throw new PermanentError(`Claim policy rejected request ${requestId}`);
    }
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
            // Two concerns, independent:
            //   (a) Did this Safe DELIVER this? → claim it (counter credit goes to msg.sender)
            //       The Deliver event's mechAddress is mechServiceMultisig (the Safe that owns
            //       the mech), so we compare against this.config.safeAddress.
            //   (b) Did this Safe CREATE the underlying request? → act on the delivery
            //       (trigger eval creation for restoration deliveries; clean up for eval deliveries)
            const iDelivered = mechAddress.toLowerCase() === this.config.safeAddress.toLowerCase();
            const iCreatedRestoration = this.pendingEvaluations.has(requestId);
            const iCreatedEvaluation = this.pendingEvaluationClaims.has(requestId);
            if (!iDelivered && !iCreatedRestoration && !iCreatedEvaluation) continue;

            // (a) Claim delivery on the router so `restorationDeliveryClaimed[requestId]` is set
            // (required before createEvaluationJob can run).
            // - Same-operator: we delivered (iDelivered) → our Safe claims and gets counter credit.
            // - Cross-operator: we created the request (iCreatedRestoration) but another mech
            //   delivered (iDelivered is false) → the creator Safe must still call claimDelivery
            //   so the router flips `restorationDeliveryClaimed` for this requestId. Otherwise
            //   tryCreateEvaluationJob never unblocks. See JinnRouter.claimDelivery in contracts.
            const isCrossOperator = iCreatedRestoration && !iDelivered;
            const shouldClaimDelivery = iDelivered || isCrossOperator;
            if (shouldClaimDelivery) {
              try {
                const variant = this.config.routerClaimDeliveryVariant;
                let evidenceHash: `0x${string}` | undefined;
                if (variant === 'v2') {
                  if (iDelivered) {
                    // Same-operator path: we signed the envelope, hash is in store.
                    const stored = this.store?.getIntentEvidenceHash(requestId);
                    if (stored) {
                      evidenceHash = stored as `0x${string}`;
                    }
                  } else {
                    // Cross-operator path: we did NOT deliver, so no local store entry.
                    // Derive evidenceHash by fetching the delivered envelope from IPFS
                    // and recomputing keccak256(JCS(envelope - signature)).
                    // If derivation fails, skip claim and let the next watch loop retry.
                    try {
                      const deliveryDigest = deliveryDataHex.startsWith('0x')
                        ? deliveryDataHex.slice(2)
                        : deliveryDataHex;
                      const envelopeCid = `f01551220${deliveryDigest}`;
                      const rawEnvelope = await fetchSignedEnvelopeFromIpfs(
                        this.config.ipfsGatewayUrl,
                        envelopeCid,
                      );
                      const parsed = SignedEnvelopeSchema.parse(rawEnvelope);
                      // Strip signature to recompute the hash over the unsigned body.
                      const { signature, ...unsignedBody } = parsed;
                      const jcsBytes = new TextEncoder().encode(canonicalJson(unsignedBody));
                      const recomputed = keccak256(jcsBytes);
                      if (recomputed !== signature.hash) {
                        console.error(
                          `[mech] cross-operator claimDelivery skipped for ${requestId}: recomputed hash ${recomputed} !== envelope.signature.hash ${signature.hash}`,
                        );
                        continue;
                      }
                      evidenceHash = recomputed as `0x${string}`;
                    } catch (deriveErr) {
                      console.error(
                        `[mech] cross-operator evidenceHash derivation failed for ${requestId} — skipping claim, will retry on next loop:`,
                        deriveErr,
                      );
                      continue;
                    }
                  }
                }
                await claimDelivery(
                  this.publicClient,
                  this.walletClient,
                  this.config.safeAddress,
                  this.config.routerAddress,
                  requestId as `0x${string}`,
                  { variant, evidenceHash },
                );
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (message.includes('RequestNotFound')) {
                  console.error(`[mech] claimDelivery skipped (not a router request): ${requestId}`);
                  // fall through — creator actions below don't depend on our claim specifically
                } else if (/already.*claimed|alreadyClaimed/i.test(message)) {
                  // Idempotent: someone else raced us, fine.
                } else {
                  console.error(`[mech] claimDelivery failed for ${requestId}:`, err);
                  // Don't continue — may retry next poll via unchanged tracking
                  continue;
                }
              }
            }

            // (b) If I created the restoration, post the eval job once the claim is on-chain.
            //     The deliverer (someone else, or us if we also delivered) must have claimed first.
            //     tryCreateEvaluationJob calls verifyRestorationClaimed() which polls for the claim.
            if (iCreatedRestoration) {
              let restorationResultData: string | undefined;
              let restorationEnvelopeCid: string | undefined;
              try {
                const digest = deliveryDataHex.startsWith('0x') ? deliveryDataHex.slice(2) : deliveryDataHex;
                restorationEnvelopeCid = `f01551220${digest}`;
                const payload = await fetchFromIpfs(this.config.ipfsGatewayUrl, restorationEnvelopeCid) as Record<string, unknown>;
                restorationResultData = (payload.data as string) ?? JSON.stringify(payload);
                this.backfillMissRids.delete(requestId);
              } catch (err) {
                console.error(`[mech] Failed to fetch restoration result for evaluation: ${requestId}`, err);
              }
              await this.tryCreateEvaluationJob(requestId, restorationResultData, restorationEnvelopeCid);
            }

            // (c) If I created the evaluation, clean up tracking once delivered.
            if (iCreatedEvaluation) {
              this.pendingEvaluationClaims.delete(requestId);
            }

            // (d) Yield the delivery result.
            try {
              const deliveryDigest = deliveryDataHex.startsWith('0x') ? deliveryDataHex.slice(2) : deliveryDataHex;
              const resultPayload = await fetchFromIpfs(this.config.ipfsGatewayUrl, `f01551220${deliveryDigest}`) as Record<string, unknown>;

              const restorationResult: RestorationResult = {
                data: (resultPayload.data as string) ?? JSON.stringify(resultPayload),
                artifacts: resultPayload.artifacts as string[] | undefined,
              };

              // Use the original desired state — not the result payload
              const restorationJob = this.originalStates.get(requestId) ?? {
                id: requestId,
                description: '',
              };

              yield {
                requestId,
                restorationJob,
                result: restorationResult,
                deliveryMechAddress: mechAddress,
              };

              // Clean up after yielding
              this.originalStates.delete(requestId);
            } catch (err) {
              console.error(`[mech] Failed to parse delivery ${requestId}:`, err);
            }
          }
        }

        // After new Deliver events are processed (and `pendingEvaluationResults` may be warm),
        // retry evaluation creation. Doing this *before* deliver processing can upload an
        // evaluation desired state without `restorationResult` in context.
        for (const rid of [...this.claimedButNotEvaluated]) {
          await this.tryCreateEvaluationJob(rid);
        }
      } catch (err) {
        console.error('[mech] Error polling for deliveries:', formatRpcError(err, {
          operation: 'pollDeliveries',
          chain: this.config.chainId === 84532 ? 'base-sepolia' : 'base',
          rpcUrl: this.config.rpcUrl,
          contract: this.config.mechContractAddress,
          fromBlock: this.deliveryBlockCursor + 1n,
        }));
      }

      // Persist block cursor for crash recovery
      if (this.store && this.deliveryBlockCursor > 0n) {
        this.store.setLastProcessedBlock(this.deliveryBlockCursor);
      }

      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  private async backfillRestorationResultFromChain(requestId: string): Promise<string | undefined> {
    if (this.pendingEvaluationResults.has(requestId)) {
      return this.pendingEvaluationResults.get(requestId);
    }
    if (this.backfillMissRids.has(requestId)) {
      return undefined;
    }
    const currentBlock = await this.publicClient.getBlockNumber();
    const lookbackBlocks = this.config.mechDeliverBackfillLookbackBlocks ?? 500_000n;
    const from = currentBlock > lookbackBlocks
      ? currentBlock - lookbackBlocks
      : 1n;
    const dhex = await findLatestDeliveryDataHexForRequest(
      this.publicClient,
      this.config.mechContractAddress,
      requestId,
      from,
      currentBlock,
    );
    if (!dhex) {
      this.backfillMissRids.add(requestId);
      return undefined;
    }
    try {
      const d = String(dhex);
      const dig = d.startsWith('0x') ? d.slice(2) : d;
      const envelopeCid = `f01551220${dig}`;
      const payload = (await fetchFromIpfs(
        this.config.ipfsGatewayUrl,
        envelopeCid,
      )) as Record<string, unknown>;
      const data = (payload.data as string) ?? JSON.stringify(payload);
      this.pendingEvaluationResults.set(requestId, data);
      this.pendingEvaluationResultCids.set(requestId, envelopeCid);
      this.backfillMissRids.delete(requestId);
      return data;
    } catch (err) {
      console.error(`[mech] backfill: failed to load restoration result for ${requestId}:`, err);
      return undefined;
    }
  }

  private async tryCreateEvaluationJob(requestId: string, restorationResultData?: string, restorationEnvelopeCid?: string): Promise<void> {
    if (!this.pendingEvaluations.has(requestId)) return;
    const originalState = this.pendingEvaluations.get(requestId)!;
    if (restorationResultData) {
      this.pendingEvaluationResults.set(requestId, restorationResultData);
      this.backfillMissRids.delete(requestId);
    }
    if (restorationEnvelopeCid) {
      this.pendingEvaluationResultCids.set(requestId, restorationEnvelopeCid);
    }
    let cachedRestorationResultData = restorationResultData ?? this.pendingEvaluationResults.get(requestId);
    if (cachedRestorationResultData == null) {
      cachedRestorationResultData = await this.backfillRestorationResultFromChain(requestId);
    }
    if (cachedRestorationResultData == null) {
      this.claimedButNotEvaluated.add(requestId);
      console.error(
        `[mech] no restoration result yet for ${requestId} (evaluation job and IPFS upload deferred until Deliver or backfill)`,
      );
      return;
    }
    const cachedEnvelopeCid = restorationEnvelopeCid ?? this.pendingEvaluationResultCids.get(requestId);
    try {
      const evaluationState: RestorationJob = {
        ...originalState,
        type: 'evaluation',
        restorationRequestId: requestId,
        context: {
          ...originalState.context,
          restorationResult: cachedRestorationResultData,
          ...(cachedEnvelopeCid ? { [RESTORATION_ENVELOPE_CID_CONTEXT_KEY]: cachedEnvelopeCid } : {}),
        },
      };
      const evaluationPayload = buildRestorationJobPayload(evaluationState);
      const evaluationCid = await uploadToIpfs(this.config.ipfsRegistryUrl, evaluationPayload);
      const evaluationDataHex = cidToDigestHex(evaluationCid);

      // Verify the restoration claim landed on-chain before submitting.
      // RPC load balancers can serve stale state right after a write,
      // causing the router's restorationDeliveryClaimed check to fail
      // with RestorationNotClaimed (surfaces as Safe GS013).
      const isClaimed = await this.verifyRestorationClaimed(requestId as `0x${string}`);
      if (!isClaimed) {
        console.error(`[mech] restorationDeliveryClaimed not yet visible for ${requestId} — will retry`);
        this.claimedButNotEvaluated.add(requestId);
        return;
      }

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
        // Copy original state to evaluation request ID so delivery can use it
        const origState = this.originalStates.get(requestId);
        if (origState) {
          this.originalStates.set(evalRequestIds[0], { ...origState, type: 'evaluation' });
        }
      }

      // Success — clean up both tracking sets
      this.pendingEvaluations.delete(requestId);
      this.claimedButNotEvaluated.delete(requestId);
      this.pendingEvaluationResults.delete(requestId);
      this.pendingEvaluationResultCids.delete(requestId);
    } catch (err) {
      console.error(`[mech] Failed to create evaluation job for ${requestId}:`, err);
      // Track for retry on next poll cycle (doesn't require a new Deliver event)
      this.claimedButNotEvaluated.add(requestId);
    }
  }

  private async verifyRestorationClaimed(requestId: `0x${string}`): Promise<boolean> {
    // RPC / fork can lag right after claimDelivery; give more room than 5×2s so
    // tryCreateEvaluationJob succeeds on the first watchForDeliveries pass when possible.
    const MAX_POLLS = 12;
    const POLL_DELAY_MS = 1_500;
    const abi = [{
      type: 'function' as const,
      name: 'restorationDeliveryClaimed' as const,
      inputs: [{ name: 'requestId', type: 'bytes32' as const }],
      outputs: [{ name: '', type: 'bool' as const }],
      stateMutability: 'view' as const,
    }];

    for (let i = 0; i < MAX_POLLS; i++) {
      const claimed = await this.publicClient.readContract({
        address: this.config.routerAddress,
        abi,
        functionName: 'restorationDeliveryClaimed',
        args: [requestId],
      });
      if (claimed) return true;
      if (i < MAX_POLLS - 1) {
        await new Promise(r => setTimeout(r, POLL_DELAY_MS));
      }
    }
    return false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
