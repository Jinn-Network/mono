import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  JINN_ROUTER_V3_ABI,
  MECH_ABI,
  MECH_MARKETPLACE_ABI,
  MECH_OPERATOR_ABI,
  SAFE_ABI,
  TASK_COORDINATOR_ABI,
  createFilePostingIntentStore,
  createRegistryPinPort,
  executeSafeTransaction,
  makeMarketplaceBackend,
  rawCodecCidFromSha256Digest,
  type MarketplaceChainConfig,
  type MarketplaceObservePort,
  type PostingIntentStore,
  type PostingOutcome,
  type PostingTerms,
} from '@jinn-network/marketplace-binding';
import {
  createBaseVenue,
  createChainLogSource,
  createProjectorObservePort,
  createSqlitePostingIntentStore,
  DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS,
  encodePreValidatedSignature,
  openVenueState,
  type BaseVenue,
  type ChainLogSource,
} from '@jinn-network/marketplace-venue-base';
import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  keccak256,
  toFunctionSelector,
  zeroAddress,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type {
  NativeInfrastructureFactoryInput,
  NativeInfrastructurePrimitives,
  NativeEvaluatorReadPrimitives,
  NativePublicEndpointOwner,
  NativePublicRecordTransport,
  NativeReadOnlyVenuePrimitives,
  NativeRequesterReadPrimitives,
  NativeSolverReadPrimitives,
  NativeTargetInspection,
  NativeWriteSession,
} from './native-infrastructure-bundle.js';
import type {
  NativeFinalizedAnchorReadClient,
  NativeSettlementOwnershipReadClient,
} from './native-trust-catalog.js';
import type { CanonicalTaskCreated, CanonicalTaskCreatedRead } from '../native-requester/requester.js';
import { createJinnPublicClient, createJinnWalletClient } from '../earning/viem-clients.js';
import { decryptMnemonic, deriveAgentSigner, deriveMasterSigner } from '../earning/wallet.js';
import type { NativeClaimBroadcastPort } from './native-claim-coordinator.js';

export interface NativeBaseSepoliaTargetReadClient {
  chainId(): Promise<number>;
  code(address: `0x${string}`): Promise<Hex | undefined>;
  balance(address: `0x${string}`): Promise<bigint>;
  block(tag: 'latest' | 'finalized'): Promise<{
    readonly number: bigint;
    readonly hash: Hex;
    readonly timestamp: bigint;
  }>;
  marketplaceAgentAuthorization(input: {
    readonly marketplace: `0x${string}`;
    readonly agent: `0x${string}`;
    readonly safe: `0x${string}`;
  }): Promise<boolean>;
}

const DEFAULT_RECORD_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_PUBLIC_REQUEST_BYTES = 1024 * 1024;

// #30: every public-record fetch is bounded so an unpinned CID's kubo `block/get` DHT lookup (which
// never returns) cannot hang the single-threaded solver work loop for minutes. The IPFS bound is
// short — a locally-pinned block resolves in milliseconds, and an unpinned CID must be abandoned FAST
// so the eval-spec resolver's #2559 HTTP-locator fallback engages on the timeout the same way it does
// on a clean miss. The HTTP bound is larger because a legitimately large record served over HTTP can
// take longer. Both are WELL below the fleet worker lease TTL (30s) so a bounded fetch cannot lapse
// the lease. `0` disables a bound (unbounded); an unset/invalid env value falls back to the default.
const DEFAULT_IPFS_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_HTTP_FETCH_TIMEOUT_MS = 20_000;

function resolveFetchTimeoutMs(explicit: number | undefined, envName: string, fallback: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
const SELECTORS = {
  claimTask: toFunctionSelector('claimTask(uint256,address)'),
  claimEvaluation: toFunctionSelector('claimEvaluation(uint256,uint32,address,bytes32)'),
  claimSolutionDelivery: toFunctionSelector('claimSolutionDelivery(bytes32,bytes32)'),
  claimVerdictDelivery: toFunctionSelector('claimVerdictDelivery(bytes32,bytes32,uint8)'),
  deliverToMarketplace: toFunctionSelector('deliverToMarketplace(bytes32[],bytes[])'),
} as const;

function operationGasCap(
  input: NativeInfrastructureFactoryInput,
  data: Hex,
): bigint {
  const selector = data.slice(0, 10).toLowerCase();
  if (input.role === 'solver') {
    if (selector === SELECTORS.claimTask.toLowerCase()) return BigInt(input.transactionCaps.claimMaxWei);
    if (selector === SELECTORS.claimSolutionDelivery.toLowerCase()
      || selector === SELECTORS.deliverToMarketplace.toLowerCase()) {
      return BigInt(input.transactionCaps.solutionSettlementMaxWei);
    }
  }
  if (input.role === 'evaluator') {
    if (selector === SELECTORS.claimEvaluation.toLowerCase()) return BigInt(input.transactionCaps.evaluationClaimMaxWei);
    if (selector === SELECTORS.claimVerdictDelivery.toLowerCase()
      || selector === SELECTORS.deliverToMarketplace.toLowerCase()) {
      return BigInt(input.transactionCaps.verdictSettlementMaxWei);
    }
  }
  throw new Error(`native ${input.role} broadcast selector ${selector} has no configured transaction cap`);
}

async function requestBody(request: import('node:http').IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.byteLength;
    if (length > MAX_PUBLIC_REQUEST_BYTES) throw new Error('native public source request exceeds size limit');
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function mountBaseSepoliaPublicSource(input: {
  readonly listen: { readonly host: string; readonly port: number };
  readonly publicBaseUrl: string;
  readonly handler: (request: Request) => Promise<Response>;
}): Promise<NativePublicEndpointOwner> {
  let closed = false;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const body = await requestBody(incoming);
        const response = await input.handler(new Request(
          new URL(incoming.url ?? '/', input.publicBaseUrl),
          {
            method: incoming.method ?? 'GET',
            headers,
            ...(body === undefined ? {} : { body: Buffer.from(body) }),
          },
        ));
        outgoing.statusCode = response.status;
        for (const [name, value] of response.headers) outgoing.setHeader(name, value);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        if (!outgoing.headersSent) outgoing.statusCode = 500;
        outgoing.end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (cause: Error) => reject(cause);
    server.once('error', failed);
    server.listen(input.listen.port, input.listen.host, () => {
      server.off('error', failed);
      resolve();
    });
  });
  return {
    async ready() { return !closed && server.listening; },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause)));
    },
  };
}

export function createBaseSepoliaRecordTransport(input: {
  readonly ipfsApiUrl: string;
  readonly fetchImpl: (request: string | URL, init?: RequestInit) => Promise<Response>;
  readonly maxBytes?: number;
  readonly ipfsFetchTimeoutMs?: number;
  readonly httpFetchTimeoutMs?: number;
}): NativePublicRecordTransport {
  const maxBytes = input.maxBytes ?? DEFAULT_RECORD_LIMIT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('native public record size limit must be a positive safe integer');
  }
  const ipfsTimeoutMs = resolveFetchTimeoutMs(
    input.ipfsFetchTimeoutMs, 'JINN_NATIVE_IPFS_FETCH_TIMEOUT_MS', DEFAULT_IPFS_FETCH_TIMEOUT_MS);
  const httpTimeoutMs = resolveFetchTimeoutMs(
    input.httpFetchTimeoutMs, 'JINN_NATIVE_HTTP_FETCH_TIMEOUT_MS', DEFAULT_HTTP_FETCH_TIMEOUT_MS);

  // A hung fetch is abandoned via an AbortSignal AND an independent timeout race, so even a transport
  // that ignores the signal cannot leave the caller waiting past the bound. A timeout REJECTS (it is
  // a miss/error, never valid empty bytes), so the digest check below still guards every byte that
  // does arrive — fail-closed is preserved.
  const fetchWithTimeout = async (url: URL, timeoutMs: number, init?: RequestInit): Promise<Response> => {
    if (timeoutMs <= 0) return input.fetchImpl(url, init);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`native public record fetch timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([input.fetchImpl(url, { ...init, signal: controller.signal }), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const fetchBytes = async (url: URL, timeoutMs: number, init?: RequestInit): Promise<Uint8Array> => {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('native public record locations must use HTTP(S)');
    }
    const response = await fetchWithTimeout(url, timeoutMs, init);
    if (!response.ok) throw new Error(`native public record retrieval failed with status ${response.status}`);
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > maxBytes) {
      throw new Error(`native public record exceeds the ${maxBytes}-byte size limit`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`native public record exceeds the ${maxBytes}-byte size limit`);
    }
    return bytes;
  };

  const byRawCid = async (cid: string): Promise<Uint8Array> => {
    if (!/^[a-z0-9]+$/u.test(cid)) throw new Error('native raw CID contains invalid characters');
    const url = new URL('/api/v0/block/get', input.ipfsApiUrl);
    url.searchParams.set('arg', cid);
    return fetchBytes(url, ipfsTimeoutMs, { method: 'POST' });
  };

  return {
    byLocation: async (location) => fetchBytes(new URL(location), httpTimeoutMs),
    byRawCid,
    async byDigest(digest) {
      const bytes = await byRawCid(rawCodecCidFromSha256Digest(digest));
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (`sha256:${actual}` !== digest) {
        throw new Error(`native public record digest mismatch: expected ${digest}, got sha256:${actual}`);
      }
      return bytes;
    },
  };
}

export interface NativeBaseSepoliaAnchorReadClient {
  transaction(hash: `0x${string}`): Promise<{
    readonly hash: `0x${string}`;
    readonly to: `0x${string}` | null;
    readonly input: `0x${string}`;
    readonly blockHash: `0x${string}` | null;
    readonly blockNumber: bigint | null;
  } | null>;
  receipt(hash: `0x${string}`): Promise<{
    readonly status: 'success' | 'reverted';
    readonly blockHash: `0x${string}`;
    readonly blockNumber: bigint;
  } | null>;
  block(number: bigint): Promise<{
    readonly number: bigint;
    readonly hash: `0x${string}`;
    readonly timestamp: bigint;
  } | null>;
  finalizedBlockNumber(): Promise<bigint>;
}

export function createViemBaseSepoliaReadClients(publicClient: PublicClient): {
  readonly target: NativeBaseSepoliaTargetReadClient;
  readonly anchor: NativeBaseSepoliaAnchorReadClient;
  readonly settlementOwnership: NativeSettlementOwnershipReadClient;
} {
  const target: NativeBaseSepoliaTargetReadClient = {
    chainId: () => publicClient.getChainId(),
    code: (address) => publicClient.getBytecode({ address }),
    balance: (address) => publicClient.getBalance({ address }),
    async block(tag) {
      const block = await publicClient.getBlock({ blockTag: tag });
      if (block.number === null || block.hash === null) {
        throw new Error(`native Base Sepolia ${tag} block has no canonical identity`);
      }
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    async marketplaceAgentAuthorization(input) {
      const factory = await publicClient.readContract({
        address: input.marketplace,
        abi: MECH_MARKETPLACE_ABI,
        functionName: 'mapAgentMechFactories',
        args: [input.agent],
      });
      if (String(factory).toLowerCase() === zeroAddress) return false;
      const operator = await publicClient.readContract({
        address: input.agent,
        abi: MECH_OPERATOR_ABI,
        functionName: 'getOperator',
      });
      return String(operator).toLowerCase() === input.safe.toLowerCase();
    },
  };
  const anchor: NativeBaseSepoliaAnchorReadClient = {
    async transaction(hash) {
      try {
        const value = await publicClient.getTransaction({ hash });
        return {
          hash: value.hash,
          to: value.to,
          input: value.input,
          blockHash: value.blockHash,
          blockNumber: value.blockNumber,
        };
      } catch {
        return null;
      }
    },
    async receipt(hash) {
      try {
        const value = await publicClient.getTransactionReceipt({ hash });
        return {
          status: value.status,
          blockHash: value.blockHash,
          blockNumber: value.blockNumber,
        };
      } catch {
        return null;
      }
    },
    async block(number) {
      try {
        const value = await publicClient.getBlock({ blockNumber: number });
        if (value.hash === null) return null;
        return { number: value.number, hash: value.hash, timestamp: value.timestamp };
      } catch {
        return null;
      }
    },
    async finalizedBlockNumber() {
      const value = await publicClient.getBlock({ blockTag: 'finalized' });
      return value.number;
    },
  };
  // The settlement-authority association's one chain read (spec/2026-08-07 §2.3c step 5). No new
  // dependency: `SAFE_ABI`'s `isOwner(address) → bool` is the ABI the daemon already carries. A
  // revert or transport failure propagates — `verifyOnchainAuthority` turns it into a refusal.
  const settlementOwnership: NativeSettlementOwnershipReadClient = {
    async isOwner(safe, candidate) {
      return publicClient.readContract({
        address: safe,
        abi: SAFE_ABI,
        functionName: 'isOwner',
        args: [candidate],
      });
    },
  };
  return { target, anchor, settlementOwnership };
}

function sameHex(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

interface ExpectedTodayTaskCreated {
  readonly chainId: number;
  readonly coordinator: `0x${string}`;
  readonly creator: `0x${string}`;
  readonly taskId: bigint;
  readonly taskDigest: `sha256:${string}`;
  readonly txHash: `0x${string}`;
  readonly terms: PostingTerms;
  readonly maxClaims: 1;
}

interface TodayTaskCreatedFacts {
  readonly transaction: {
    readonly hash: `0x${string}`;
    readonly blockNumber: bigint;
    readonly blockHash: `0x${string}`;
    readonly status: 'success' | 'reverted';
  };
  readonly canonicalBlockHash: `0x${string}`;
  readonly finalizedBlock: bigint;
  readonly event: {
    readonly creator: `0x${string}`;
    readonly taskId: bigint;
    readonly taskDigest: `sha256:${string}`;
    readonly maxClaims: number;
    readonly solutionBudget: bigint;
    readonly verdictBudget: bigint;
  };
  readonly task: {
    readonly creator: `0x${string}`;
    readonly taskDigest: `sha256:${string}`;
    readonly maxClaims: number;
    readonly allowSolverSelfEvaluation: boolean;
  };
  readonly payment: {
    readonly creator: `0x${string}`;
    readonly taskDigest: `sha256:${string}`;
    readonly solutionMaxDeliveryRateWei: bigint;
    readonly verdictMaxDeliveryRateWei: bigint;
    readonly responseTimeoutSeconds: bigint;
  };
}

/**
 * ## Waiting for finality is not evidence of tampering (#2531 F4)
 *
 * `blockNumber > finalizedBlock` used to sit in the same `||` chain as every mismatch predicate
 * below, so a freshly-mined post -- correct in every respect, just young -- was indistinguishable
 * from a reverted transaction or a forged taskId. Both returned `null`; the requester raised both
 * as "refuses non-canonical or mismatched TaskCreated association".
 *
 * It is now evaluated LAST and on its own. Order is the whole point: every mismatch predicate is
 * checked first, so anything genuinely non-canonical still returns `null` and still refuses
 * loudly, and `awaiting-finality` is reachable ONLY for an association that already agrees with
 * the durable draft on chain id, transaction hash, canonical block hash, creator, task id, task
 * digest, maxClaims, both budgets, self-evaluation policy, both delivery rates and the response
 * timeout. A tampered association can never present itself as merely pending.
 */
export function verifyCanonicalTodayTaskCreated(
  expected: ExpectedTodayTaskCreated,
  facts: TodayTaskCreatedFacts,
): CanonicalTaskCreatedRead {
  const sameAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  const terms = expected.terms;
  if (expected.chainId !== 84532
    || facts.transaction.status !== 'success'
    || !sameHex(facts.transaction.hash, expected.txHash)
    || !sameHex(facts.transaction.blockHash, facts.canonicalBlockHash)
    || !sameAddress(facts.event.creator, expected.creator)
    || facts.event.taskId !== expected.taskId
    || facts.event.taskDigest !== expected.taskDigest
    || facts.event.maxClaims !== expected.maxClaims
    || facts.event.solutionBudget !== terms.solutionMaxDeliveryRateWei * BigInt(expected.maxClaims)
    || facts.event.verdictBudget !== terms.verdictMaxDeliveryRateWei * BigInt(expected.maxClaims)
    || !sameAddress(facts.task.creator, expected.creator)
    || facts.task.taskDigest !== expected.taskDigest
    || facts.task.maxClaims !== expected.maxClaims
    || facts.task.allowSolverSelfEvaluation !== terms.allowSolverSelfEvaluation
    || !sameAddress(facts.payment.creator, expected.creator)
    || facts.payment.taskDigest !== expected.taskDigest
    || facts.payment.solutionMaxDeliveryRateWei !== terms.solutionMaxDeliveryRateWei
    || facts.payment.verdictMaxDeliveryRateWei !== terms.verdictMaxDeliveryRateWei
    || facts.payment.responseTimeoutSeconds !== terms.responseTimeoutSeconds) {
    return null;
  }
  if (facts.transaction.blockNumber > facts.finalizedBlock) {
    return {
      canonical: false,
      pending: 'awaiting-finality',
      blockNumber: facts.transaction.blockNumber,
      finalizedBlock: facts.finalizedBlock,
    };
  }
  return { canonical: true, ...expected };
}

function sha256Digest(value: Hex): `sha256:${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new Error('expected a bytes32 digest');
  return `sha256:${value.slice(2).toLowerCase()}`;
}

/**
 * The only two fields the canonical READ primitives take off the infrastructure factory input:
 * this operator's Safe (whose claims they filter to) and the chain identity they refuse outside
 * of. Named separately (one-swap M2, umbrella #2461) so the ONE fleet daemon can build the same
 * readers from its shape-v2 `config.json` and the pinned `BASE_SEPOLIA_TODAY` deployment, without
 * assembling the full `NativeInfrastructureFactoryInput` — most of which describes write custody,
 * a public listener and an IPFS API that the read path never touches.
 * `NativeInfrastructureFactoryInput` satisfies this structurally, so `createNativeInfrastructure`
 * keeps passing exactly what it always passed.
 */
export interface NativeCanonicalReadIdentity {
  readonly safeAddress: `0x${string}`;
  readonly chain: NativeInfrastructureFactoryInput['chain'];
}

function marketplaceChain(input: NativeCanonicalReadIdentity): MarketplaceChainConfig {
  return {
    chainId: input.chain.chainId,
    generation: input.chain.generation,
    taskCoordinator: input.chain.contracts.taskCoordinator as `0x${string}`,
    jinnRouter: input.chain.contracts.jinnRouter as `0x${string}`,
    mechMarketplace: input.chain.contracts.mechMarketplace as `0x${string}`,
    activityChecker: input.chain.contracts.activityChecker as `0x${string}`,
  };
}

async function canonicalTodayTaskCreated(
  publicClient: PublicClient,
  chain: MarketplaceChainConfig,
  expected: Parameters<NativeRequesterReadPrimitives['canonicalTaskCreated']>[0],
): Promise<CanonicalTaskCreatedRead> {
  if (expected.chainId !== chain.chainId
    || !sameHex(expected.coordinator, chain.taskCoordinator)) return null;
  let receipt;
  try { receipt = await publicClient.getTransactionReceipt({ hash: expected.txHash }); } catch { return null; }
  const [canonicalBlock, finalizedBlock] = await Promise.all([
    publicClient.getBlock({ blockNumber: receipt.blockNumber }),
    publicClient.getBlock({ blockTag: 'finalized' }),
  ]);
  if (canonicalBlock.hash === null) return null;

  const matching = receipt.logs.flatMap((log) => {
    if (!sameHex(log.address, chain.jinnRouter)) return [];
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_V3_ABI,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (decoded.eventName !== 'TaskCreated') return [];
      const args = decoded.args as unknown as {
        readonly creator: `0x${string}`;
        readonly taskId: bigint;
        readonly taskCidDigest: Hex;
        readonly maxClaims: number;
        readonly solutionBudget: bigint;
        readonly verdictBudget: bigint;
      };
      return [{
        creator: args.creator,
        taskId: args.taskId,
        taskDigest: sha256Digest(args.taskCidDigest),
        maxClaims: Number(args.maxClaims),
        solutionBudget: args.solutionBudget,
        verdictBudget: args.verdictBudget,
      }];
    } catch {
      return [];
    }
  });
  if (matching.length !== 1) return null;

  const [taskValue, paymentValue] = await Promise.all([
    publicClient.readContract({
      address: chain.taskCoordinator,
      abi: TASK_COORDINATOR_ABI,
      functionName: 'getTask',
      args: [expected.taskId],
    }),
    publicClient.readContract({
      address: chain.jinnRouter,
      abi: JINN_ROUTER_V3_ABI,
      functionName: 'taskPayments',
      args: [expected.taskId],
    }),
  ]);
  const task = taskValue as unknown as {
    readonly creator: `0x${string}`;
    readonly taskCidDigest: Hex;
    readonly policy: { readonly maxClaims: number; readonly allowSolverSelfEvaluation: boolean };
  };
  const payment = paymentValue as unknown as readonly [
    `0x${string}`, Hex, Hex, bigint, bigint, bigint, bigint, bigint, boolean, boolean,
  ];
  return verifyCanonicalTodayTaskCreated(expected, {
    transaction: {
      hash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      status: receipt.status,
    },
    canonicalBlockHash: canonicalBlock.hash,
    finalizedBlock: finalizedBlock.number,
    event: matching[0]!,
    task: {
      creator: task.creator,
      taskDigest: sha256Digest(task.taskCidDigest),
      maxClaims: Number(task.policy.maxClaims),
      allowSolverSelfEvaluation: task.policy.allowSolverSelfEvaluation,
    },
    payment: {
      creator: payment[0],
      taskDigest: sha256Digest(payment[1]),
      solutionMaxDeliveryRateWei: payment[3],
      verdictMaxDeliveryRateWei: payment[4],
      responseTimeoutSeconds: payment[5],
    },
  });
}

async function blockAtOrBefore(publicClient: PublicClient, timestamp: bigint): Promise<bigint> {
  let low = 0n;
  let high = await publicClient.getBlockNumber();
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    // eslint-disable-next-line no-await-in-loop -- bounded binary search over canonical block time.
    const block = await publicClient.getBlock({ blockNumber: mid });
    if (block.timestamp <= timestamp) low = mid;
    else high = mid - 1n;
  }
  return low;
}

async function latestAuthorityTime(publicClient: PublicClient) {
  const block = await publicClient.getBlock({ blockTag: 'finalized' });
  if (block.hash === null) throw new Error('finalized Base Sepolia authority block has no hash');
  return {
    chainId: 84532 as const,
    blockNumber: block.number.toString(10),
    blockHash: block.hash,
    timestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
    finalized: true as const,
  };
}

async function verifyAuthorityTime(
  publicClient: PublicClient,
  anchor: import('../native-requester/requester.js').NativeAuthorityTimeAnchor,
): Promise<boolean> {
  if (anchor.chainId !== 84532 || anchor.finalized !== true || !/^(?:0|[1-9][0-9]*)$/u.test(anchor.blockNumber)) {
    return false;
  }
  const number = BigInt(anchor.blockNumber);
  const [block, finalized] = await Promise.all([
    publicClient.getBlock({ blockNumber: number }).catch(() => undefined),
    publicClient.getBlock({ blockTag: 'finalized' }),
  ]);
  return block !== undefined
    && block.hash !== null
    && number <= finalized.number
    && sameHex(block.hash, anchor.blockHash)
    && new Date(Number(block.timestamp) * 1_000).toISOString() === anchor.timestamp;
}

/**
 * Canonical, finalized Base authority-time reads over a plain viem `PublicClient`.
 *
 * Exported for the same reason `createSolverReads` is (one-swap M3, #2461): the native discovery
 * decode needs `verifyFinalized`, and the ONE fleet daemon owns a `PublicClient` and no
 * `NativeInfrastructurePrimitives`. Same two functions `createNativeInfrastructure` has always
 * installed on `authorityTime` — this names them rather than duplicating them.
 */
export function createBaseSepoliaAuthorityTime(publicClient: PublicClient): {
  readonly latestFinalized: () => Promise<import('../native-requester/requester.js').NativeAuthorityTimeAnchor>;
  readonly verifyFinalized: (
    anchor: import('../native-requester/requester.js').NativeAuthorityTimeAnchor,
  ) => Promise<boolean>;
} {
  return {
    latestFinalized: () => latestAuthorityTime(publicClient),
    verifyFinalized: (anchor) => verifyAuthorityTime(publicClient, anchor),
  };
}

function createRequesterReads(input: {
  readonly config: NativeInfrastructureFactoryInput;
  readonly publicClient: PublicClient;
}): { readonly reads: NativeRequesterReadPrimitives; readonly intents: ReturnType<typeof createFilePostingIntentStore> } {
  const chain = marketplaceChain(input.config);
  const intents = createFilePostingIntentStore(join(input.config.stateDir, 'posting-intents'));
  return {
    intents,
    reads: {
      authorityTime: () => latestAuthorityTime(input.publicClient),
      async recoverPosting(draft): Promise<PostingOutcome | null> {
        const key = {
          creatorSafe: draft.creatorSafe,
          taskCidDigest: draft.taskDigest,
          submissionDigest: draft.submissionDigest,
        };
        const before = await intents.lookup(key);
        if (before?.resolved !== undefined) return before.resolved;
        // `TaskCreated` anchors only creator + Task digest. It cannot prove which Submission
        // landed, even when a scan finds one result, so a legacy unresolved file WAL remains an
        // explicit operator-reconciliation hold and is never auto-completed here.
        return null;
      },
      canonicalTaskCreated: (expected) => canonicalTodayTaskCreated(input.publicClient, chain, expected),
    },
  };
}

export function createBaseSepoliaEvaluatorReads(input: {
  readonly config: NativeCanonicalReadIdentity;
  readonly publicClient: PublicClient;
  readonly records: NativePublicRecordTransport;
}): NativeEvaluatorReadPrimitives {
  const { publicClient } = input;
  const chain = marketplaceChain(input.config);
  return {
    canonicalTaskCreated: (expected) => canonicalTodayTaskCreated(publicClient, chain, expected),
    async readCanonicalSolutionDelivery(expected) {
      if (expected.chainId !== 84532
        || !sameHex(expected.coordinator, chain.taskCoordinator)
        || !sameHex(expected.router, chain.jinnRouter)
        || !Number.isSafeInteger(expected.attemptIndex)
        || expected.attemptIndex < 0) return null;

      const latest = await publicClient.getBlockNumber();
      const fromBlock = latest > DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS
        ? latest - DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS
        : 0n;
      const routerEvents = await publicClient.getContractEvents({
        address: chain.jinnRouter,
        abi: JINN_ROUTER_V3_ABI,
        eventName: 'SolutionDeliveryClaimed',
        args: {
          operator: expected.operator,
          requestId: expected.requestId,
          taskId: expected.taskId,
        },
        fromBlock,
        toBlock: 'latest',
      });
      const routerMatches = routerEvents.filter((event) => {
        const args = event.args as unknown as { readonly attemptIndex?: number };
        return Number(args.attemptIndex) === expected.attemptIndex
          && event.transactionHash !== null
          && event.blockHash !== null
          && event.blockNumber !== null;
      });
      if (routerMatches.length !== 1) return null;
      const router = routerMatches[0]!;
      const routerCanonical = await canonicalTransactionBlock({
        publicClient,
        blockNumber: router.blockNumber!,
        blockHash: router.blockHash!,
      });
      if (!routerCanonical.canonical || !routerCanonical.finalized) return null;

      const requestInfo = await publicClient.readContract({
        address: chain.mechMarketplace,
        abi: MECH_MARKETPLACE_ABI,
        functionName: 'mapRequestIdInfos',
        args: [expected.requestId],
      }) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, bigint, bigint, `0x${string}`];
      const deliveryMech = requestInfo[1];
      if (sameHex(deliveryMech, zeroAddress)) return null;
      const [mechOperator, registeredFactory] = await Promise.all([
        publicClient.readContract({
          address: deliveryMech,
          abi: MECH_OPERATOR_ABI,
          functionName: 'getOperator',
        }),
        publicClient.readContract({
          address: chain.mechMarketplace,
          abi: MECH_MARKETPLACE_ABI,
          functionName: 'mapAgentMechFactories',
          args: [deliveryMech],
        }),
      ]);
      if (!sameHex(String(mechOperator), expected.operator)
        || sameHex(String(registeredFactory), zeroAddress)) return null;

      const mechEvents = await publicClient.getContractEvents({
        address: deliveryMech,
        abi: MECH_ABI,
        eventName: 'Deliver',
        fromBlock,
        toBlock: router.blockNumber!,
      });
      const expectedRawDigest = `0x${expected.advertisedDeliveryDigest.slice('sha256:'.length)}`;
      const mechMatches = mechEvents.filter((event) => {
        const args = event.args as unknown as {
          readonly requestId?: `0x${string}`;
          readonly mechServiceMultisig?: `0x${string}`;
          readonly data?: `0x${string}`;
        };
        return args.requestId !== undefined
          && args.mechServiceMultisig !== undefined
          && args.data !== undefined
          && sameHex(args.requestId, expected.requestId)
          && sameHex(args.mechServiceMultisig, expected.operator)
          && sameHex(args.data, expectedRawDigest)
          && event.blockHash !== null
          && event.blockNumber !== null;
      });
      if (mechMatches.length !== 1) return null;
      const mech = mechMatches[0]!;
      const mechCanonical = await canonicalTransactionBlock({
        publicClient,
        blockNumber: mech.blockNumber!,
        blockHash: mech.blockHash!,
      });
      if (!mechCanonical.canonical || !mechCanonical.finalized) return null;

      // Fetch the exact public payload after the on-chain raw digest agrees. Native solution
      // records are published only to the operator's HTTP records plane and are never pinned to
      // IPFS (#2559 sibling), so try the delivery card's advertised HTTP locations first and fall
      // back to the marketplace IPFS plane. Every plane is digest-verified against
      // `advertisedDeliveryDigest` — which is bound to the on-chain `SolutionDeliveryClaimed`/Mech
      // `Deliver` event above — so a substituted response is rejected exactly as a tampered IPFS
      // block is; the transport stays untrusted. A total transient failure still throws so the
      // caller holds its checkpoint rather than skipping the engagement.
      const matchesDigest = (bytes: Uint8Array): boolean =>
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` === expected.advertisedDeliveryDigest;
      let resolved = false;
      for (const location of expected.deliveryPublicLocations ?? []) {
        try {
          // eslint-disable-next-line no-await-in-loop -- alternate content-addressed public replicas.
          if (matchesDigest(await input.records.byLocation(location))) { resolved = true; break; }
        } catch { /* serving-plane miss/failure — try the next location, then the IPFS plane */ }
      }
      if (!resolved && !matchesDigest(await input.records.byDigest(expected.advertisedDeliveryDigest))) {
        return null;
      }

      return {
        transactionHash: router.transactionHash!,
        blockHash: router.blockHash!,
        blockNumber: router.blockNumber!,
        finalized: true,
      };
    },
    chain: {
      async isFinalized(transaction) {
        let receipt;
        try { receipt = await publicClient.getTransactionReceipt({ hash: transaction.hash }); }
        catch { return false; }
        if (receipt.status !== 'success'
          || receipt.blockNumber !== transaction.blockNumber
          || !sameHex(receipt.blockHash, transaction.blockHash)) return false;
        const [canonical, finalized] = await Promise.all([
          publicClient.getBlock({ blockNumber: receipt.blockNumber }),
          publicClient.getBlock({ blockTag: 'finalized' }),
        ]);
        return canonical.hash !== null
          && sameHex(canonical.hash, receipt.blockHash)
          && receipt.blockNumber <= finalized.number;
      },
      async transactionStatus(txHash) {
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
          const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
          if (receipt.status !== 'success' || canonical.hash === null || !sameHex(canonical.hash, receipt.blockHash)) {
            return { kind: 'orphaned', reason: 'transaction receipt is reverted or non-canonical' };
          }
          return { kind: 'canonical' };
        } catch {
          try {
            await publicClient.getTransaction({ hash: txHash });
            return { kind: 'pending' };
          } catch {
            return { kind: 'orphaned', reason: 'transaction is absent from the canonical RPC view' };
          }
        }
      },
    },
    async preSettlementClaimTime() {
      const block = await publicClient.getBlock({ blockTag: 'finalized' });
      return new Date(Number(block.timestamp) * 1_000).toISOString();
    },
    async blockTime(blockNumber) {
      const block = await publicClient.getBlock({ blockNumber });
      if (block.hash === null) throw new Error(`native block ${blockNumber} has no canonical hash`);
      return new Date(Number(block.timestamp) * 1_000).toISOString();
    },
  };
}

function hashValue(value: string | null): value is `0x${string}` {
  return value !== null && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

async function canonicalTransactionBlock(input: {
  readonly publicClient: PublicClient;
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
}): Promise<{ readonly canonical: boolean; readonly finalized: boolean; readonly finalizedHead: bigint }> {
  const [block, finalized] = await Promise.all([
    input.publicClient.getBlock({ blockNumber: input.blockNumber }),
    input.publicClient.getBlock({ blockTag: 'finalized' }),
  ]);
  return {
    canonical: block.hash !== null && sameHex(block.hash, input.blockHash),
    finalized: input.blockNumber <= finalized.number,
    finalizedHead: finalized.number,
  };
}

/**
 * Canonical, finalized-only solver reads over a plain viem `PublicClient`. Exported (one-swap M2)
 * so the ONE fleet daemon builds the SAME readers the native solver host does rather than a second
 * implementation of "is this claim canonical" — the fleet path already owns a `PublicClient` and
 * has no `NativeInfrastructurePrimitives`.
 */
export function createSolverReads(input: {
  readonly config: NativeCanonicalReadIdentity;
  readonly publicClient: PublicClient;
  readonly records: NativePublicRecordTransport;
}): NativeSolverReadPrimitives {
  const chain = marketplaceChain(input.config);
  const exactDelivery = createBaseSepoliaEvaluatorReads(input).readCanonicalSolutionDelivery;
  const fromOperation = async (createdAt: string) => {
    const parsed = Date.parse(createdAt);
    if (!Number.isFinite(parsed)) throw new Error('native chain operation has invalid creation time');
    return blockAtOrBefore(input.publicClient, BigInt(Math.max(0, Math.floor(parsed / 1_000) - 900)));
  };
  return {
    canonicalTaskCreated: (expected) => canonicalTodayTaskCreated(input.publicClient, chain, expected),
    claimCanonical: {
      async read({ operation, engagement }) {
        const fromBlock = await fromOperation(operation.createdAt);
        const events = await input.publicClient.getContractEvents({
          address: chain.jinnRouter,
          abi: JINN_ROUTER_V3_ABI,
          eventName: 'TaskAttemptCreated',
          args: { taskId: engagement.taskId },
          fromBlock,
          toBlock: 'latest',
        });
        const mine = events.filter((event) => {
          const args = event.args as unknown as { readonly operator?: `0x${string}` };
          return args.operator !== undefined && sameHex(args.operator, input.config.safeAddress);
        });
        const event = mine.at(-1);
        if (event === undefined || event.transactionHash === null
          || event.blockHash === null || event.blockNumber === null) {
          if (hashValue(operation.txHash)) {
            try {
              const receipt = await input.publicClient.getTransactionReceipt({ hash: operation.txHash });
              const canonical = await canonicalTransactionBlock({
                publicClient: input.publicClient,
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
              });
              return canonical.canonical
                ? { kind: 'lost', reason: 'claim transaction has no matching TaskAttemptCreated event' }
                : { kind: 'orphaned', txHash: operation.txHash, reason: 'claim receipt block is non-canonical' };
            } catch {
              try {
                await input.publicClient.getTransaction({ hash: operation.txHash });
                return { kind: 'broadcast', txHash: operation.txHash };
              } catch {
                return { kind: 'orphaned', txHash: operation.txHash, reason: 'claim transaction is absent' };
              }
            }
          }
          const finalized = await input.publicClient.getBlock({ blockTag: 'finalized' });
          return { kind: 'absent', checkedAtBlock: finalized.number };
        }
        const args = event.args as unknown as {
          readonly attemptIndex: number | bigint;
          readonly requestId?: `0x${string}`;
        };
        const fact = {
          txHash: event.transactionHash,
          blockHash: event.blockHash,
          blockNumber: event.blockNumber,
          attemptIndex: Number(args.attemptIndex),
          ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
        } as const;
        if (hashValue(operation.txHash) && !sameHex(operation.txHash, event.transactionHash)) {
          return { kind: 'replaced', priorTxHash: operation.txHash, txHash: event.transactionHash };
        }
        const canonical = await canonicalTransactionBlock({
          publicClient: input.publicClient,
          blockNumber: event.blockNumber,
          blockHash: event.blockHash,
        });
        if (!canonical.canonical) {
          return { kind: 'orphaned', txHash: event.transactionHash, reason: 'claim event block is non-canonical' };
        }
        return canonical.finalized ? { kind: 'finalized', ...fact } : { kind: 'observed-safe', ...fact };
      },
    },
    async solutionSettlementCanonical({ operation, engagement, deliveryPublicLocations }) {
      if (!hashValue(engagement.requestId)) {
        return { kind: 'absent', checkedAtBlock: (await input.publicClient.getBlock({ blockTag: 'finalized' })).number };
      }
      const fromBlock = await fromOperation(operation.createdAt);
      const events = await input.publicClient.getContractEvents({
        address: chain.jinnRouter,
        abi: JINN_ROUTER_V3_ABI,
        eventName: 'SolutionDeliveryClaimed',
        args: { requestId: engagement.requestId, taskId: engagement.taskId },
        fromBlock,
        toBlock: 'latest',
      });
      const event = events.find((candidate) => {
        const args = candidate.args as unknown as { readonly attemptIndex?: number | bigint };
        return args.attemptIndex !== undefined && Number(args.attemptIndex) === engagement.attemptIndex;
      });
      if (event === undefined || event.transactionHash === null
        || event.blockHash === null || event.blockNumber === null) {
        if (hashValue(operation.txHash)) return { kind: 'broadcast', txHash: operation.txHash };
        return { kind: 'absent', checkedAtBlock: (await input.publicClient.getBlock({ blockTag: 'finalized' })).number };
      }
      if (hashValue(operation.txHash) && !sameHex(operation.txHash, event.transactionHash)) {
        return { kind: 'replaced', priorTxHash: operation.txHash, txHash: event.transactionHash };
      }
      const canonical = await canonicalTransactionBlock({
        publicClient: input.publicClient,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
      });
      if (!canonical.canonical) {
        return { kind: 'orphaned', txHash: event.transactionHash, reason: 'solution settlement event block is non-canonical' };
      }
      // Bind the Safe outer transaction to the expected inner router request identity.
      const transaction = await input.publicClient.getTransaction({ hash: event.transactionHash });
      try {
        const outer = decodeFunctionData({ abi: SAFE_ABI, data: transaction.input });
        if (outer.functionName !== 'execTransaction') throw new Error('not a Safe execution');
        const innerData = outer.args[2] as Hex;
        const inner = decodeFunctionData({ abi: JINN_ROUTER_V3_ABI, data: innerData });
        if (inner.functionName !== 'claimSolutionDelivery'
          || !sameHex(String(inner.args[0]), engagement.requestId)) {
          throw new Error('wrong solution request identity');
        }
      } catch {
        return { kind: 'orphaned', txHash: event.transactionHash, reason: 'solution settlement calldata is not bound to the request' };
      }
      if (canonical.finalized) {
        const detail = operation.detail as { readonly deliveryDigest?: unknown };
        if (typeof detail?.deliveryDigest !== 'string'
          || !/^sha256:[0-9a-f]{64}$/u.test(detail.deliveryDigest)) {
          return { kind: 'orphaned', txHash: event.transactionHash, reason: 'solution operation has no exact Delivery digest' };
        }
        const correspondence = await exactDelivery({
          chainId: 84532,
          coordinator: chain.taskCoordinator,
          router: chain.jinnRouter,
          taskId: engagement.taskId,
          attemptIndex: engagement.attemptIndex!,
          requestId: engagement.requestId,
          operator: input.config.safeAddress,
          advertisedDeliveryDigest: detail.deliveryDigest as `sha256:${string}`,
          // The solver published this Delivery record to its OWN HTTP serving plane and never
          // pinned it to IPFS (#2561 sibling), so hand the reader the solver's advertised locations
          // for the digest-verified re-fetch; the IPFS plane stays the fallback. Every plane is
          // verified against `advertisedDeliveryDigest`, bound to the on-chain settlement above.
          deliveryPublicLocations,
        });
        if (correspondence === null || !sameHex(correspondence.transactionHash, event.transactionHash)) {
          return { kind: 'orphaned', txHash: event.transactionHash, reason: 'solution settlement does not bind the exact public Delivery' };
        }
      }
      return canonical.finalized
        ? {
            kind: 'finalized',
            txHash: event.transactionHash,
            blockHash: event.blockHash,
            blockNumber: event.blockNumber,
          }
        : { kind: 'broadcast', txHash: event.transactionHash };
    },
  };
}

/**
 * Resolves a trust anchor only when the exact digest bytes occur at the declared transaction
 * input offset and the successful transaction is still canonical below the finalized head.
 */
export function createBaseSepoliaFinalizedAnchorClient(
  client: NativeBaseSepoliaAnchorReadClient,
): NativeFinalizedAnchorReadClient {
  return {
    async lookupFinalizedAnchor(input) {
      if (input.locator.chainId !== 84532) return null;
      const transactionHash = input.locator.transactionHash as `0x${string}`;
      const contractAddress = input.locator.contractAddress as `0x${string}`;
      const [transaction, receipt, finalizedBlock] = await Promise.all([
        client.transaction(transactionHash),
        client.receipt(transactionHash),
        client.finalizedBlockNumber(),
      ]);
      if (transaction === null
        || receipt === null
        || receipt.status !== 'success'
        || !sameHex(transaction.hash, transactionHash)
        || !sameHex(transaction.to, contractAddress)
        || transaction.blockNumber === null
        || transaction.blockHash === null
        || transaction.blockNumber !== receipt.blockNumber
        || !sameHex(transaction.blockHash, receipt.blockHash)
        || transaction.blockNumber > finalizedBlock) {
        return null;
      }
      const digestHex = input.digest.slice('sha256:'.length);
      const start = 2 + input.locator.inputByteOffset * 2;
      if (transaction.input.slice(start, start + digestHex.length).toLowerCase() !== digestHex) {
        return null;
      }
      const block = await client.block(transaction.blockNumber);
      if (block === null
        || block.number !== transaction.blockNumber
        || !sameHex(block.hash, transaction.blockHash)) {
        return null;
      }
      return {
        digest: input.digest,
        anchorTime: new Date(Number(block.timestamp) * 1_000).toISOString(),
        chainId: 84532,
        transactionHash,
        blockHash: block.hash,
        blockNumber: block.number,
        finalized: true,
      };
    },
  };
}

export async function inspectBaseSepoliaNativeTarget(
  input: NativeInfrastructureFactoryInput,
  client: NativeBaseSepoliaTargetReadClient,
): Promise<NativeTargetInspection> {
  const chainId = await client.chainId();
  if (chainId !== input.chain.chainId || chainId !== 84532) {
    throw new Error(`native Base Sepolia target expected chain 84532, got ${chainId}`);
  }
  const contractEntries = await Promise.all(
    (Object.entries(input.chain.contracts) as Array<[
      keyof NativeInfrastructureFactoryInput['chain']['contracts'],
      `0x${string}`,
    ]>).map(async ([name, address]) => {
      const typedAddress = address as `0x${string}`;
      const code = await client.code(typedAddress);
      if (code === undefined || code === '0x') {
        throw new Error(`native Base Sepolia ${name} has no contract code at ${address}`);
      }
      return [name, { address: typedAddress, codeHash: keccak256(code) }] as const;
    }),
  );
  const [ownerBalanceWei, safeBalanceWei, canonical, finalized] = await Promise.all([
    client.balance(input.evmCustody.expectedOwnerAddress as `0x${string}`),
    client.balance(input.safeAddress),
    client.block('latest'),
    client.block('finalized'),
  ]);
  if (finalized.number > canonical.number) {
    throw new Error('native Base Sepolia finalized height is ahead of the canonical head');
  }

  const escrowRequiredWei = input.role === 'requester'
    ? (() => {
        if (input.postingTerms === undefined) {
          throw new Error('native requester target inspection requires structured posting terms');
        }
        return BigInt(input.postingTerms.solutionMaxDeliveryRateWei)
          + BigInt(input.postingTerms.verdictMaxDeliveryRateWei);
      })()
    : 0n;
  // No operation calldata exists during startup inspection. Do not mislabel caps as estimates;
  // exact-call gas estimates are enforced by the activated requester/Safe broadcasters.
  const estimatedMaximumWei = {};
  let marketplaceAgentAuthorized: boolean | undefined;
  if (input.marketplaceAgentAddress !== undefined) {
    marketplaceAgentAuthorized = await client.marketplaceAgentAuthorization({
      marketplace: input.chain.contracts.mechMarketplace as `0x${string}`,
      agent: input.marketplaceAgentAddress,
      safe: input.safeAddress,
    });
  }

  return {
    chainId,
    contracts: Object.fromEntries(contractEntries) as NativeTargetInspection['contracts'],
    safeAddress: input.safeAddress as `0x${string}`,
    ...(input.marketplaceAgentAddress === undefined
      ? {}
      : { marketplaceAgentAddress: input.marketplaceAgentAddress, marketplaceAgentAuthorized }),
    ownerBalanceWei,
    safeBalanceWei,
    escrowRequiredWei,
    estimatedMaximumWei,
    canonicalBlock: canonical.number,
    finalizedBlock: finalized.number,
  };
}

function venuePrimitives(input: {
  readonly logSource: ChainLogSource;
  readonly publicClient: PublicClient;
  readonly closeOwned: () => void;
}): NativeReadOnlyVenuePrimitives {
  let closed = false;
  return {
    rawLogSource: input.logSource,
    async health() {
      const [canonical, finalized] = await Promise.all([
        input.publicClient.getBlock({ blockTag: 'latest' }),
        input.publicClient.getBlock({ blockTag: 'finalized' }),
      ]);
      const cursor = input.logSource.cursor();
      return {
        canonicalBlock: canonical.number,
        finalizedBlock: finalized.number,
        caughtUp: cursor !== undefined && cursor.blockNumber >= canonical.number,
      };
    },
    readFinalizedBlockNumber() {
      return input.logSource.finalizedCheckpoint()?.blockNumber ?? 0n;
    },
    async readCanonicalBlockHash(blockNumber) {
      try { return (await input.publicClient.getBlock({ blockNumber })).hash ?? undefined; }
      catch { return undefined; }
    },
    async close() {
      if (closed) return;
      closed = true;
      input.closeOwned();
    },
  };
}

function requesterVenue(input: {
  readonly config: NativeInfrastructureFactoryInput;
  readonly publicClient: PublicClient;
}): NativeReadOnlyVenuePrimitives & {
  readonly intents: PostingIntentStore;
  readonly observe: MarketplaceObservePort;
} {
  const state = openVenueState(join(input.config.stateDir, 'requester-venue.sqlite'));
  try {
    const chain = marketplaceChain(input.config);
    const logSource = createChainLogSource({
      chain,
      // The packed venue package owns a distinct viem installation. Its
      // runtime client contract is identical; narrow the cast at that package
      // boundary instead of leaking duplicate viem nominal types throughout
      // the native composition.
      publicClient: input.publicClient as Parameters<typeof createChainLogSource>[0]['publicClient'],
      state,
      addresses: [chain.jinnRouter, chain.taskCoordinator, chain.mechMarketplace],
    });
    const observe = createProjectorObservePort({
      chain,
      state,
      logSource,
      observations: async () => [],
    });
    return {
      ...venuePrimitives({
      logSource,
      publicClient: input.publicClient,
      closeOwned() {
        try { logSource.close(); } finally { state.close(); }
      },
      }),
      intents: createSqlitePostingIntentStore(state),
      observe,
    };
  } catch (cause) {
    state.close();
    throw cause;
  }
}

function postingTerms(config: NativeInfrastructureFactoryInput): PostingTerms {
  const value = config.postingTerms;
  if (config.role !== 'requester' || value === undefined) {
    throw new Error('native requester write activation requires structured posting terms');
  }
  return {
    solutionMaxDeliveryRateWei: BigInt(value.solutionMaxDeliveryRateWei),
    verdictMaxDeliveryRateWei: BigInt(value.verdictMaxDeliveryRateWei),
    responseTimeoutSeconds: BigInt(value.responseTimeoutSeconds),
    allowSolverSelfEvaluation: value.allowSolverSelfEvaluation,
  };
}

async function requesterPostingOutcome(input: {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly config: NativeInfrastructureFactoryInput;
  readonly request: { readonly safeAddress: `0x${string}`; readonly to: `0x${string}`; readonly value: bigint; readonly data: Hex };
}): Promise<PostingOutcome> {
  const chain = marketplaceChain(input.config);
  if (!sameHex(input.request.safeAddress, input.config.safeAddress)
    || !sameHex(input.request.to, chain.jinnRouter)) {
    throw new Error('native requester Safe broadcast target does not match structured deployment');
  }
  const account = input.walletClient.account;
  if (account === undefined) throw new Error('native requester wallet has no account');
  const feeEstimate = await input.publicClient.estimateFeesPerGas().catch(async () => ({
    gasPrice: await input.publicClient.getGasPrice(),
  }));
  const feePerGas = 'maxFeePerGas' in feeEstimate
    ? feeEstimate.maxFeePerGas
    : feeEstimate.gasPrice;
  if (feePerGas === undefined) throw new Error('native requester fee estimate is unavailable');
  const signature = encodePreValidatedSignature(account.address);
  const gas = await input.publicClient.estimateContractGas({
    address: input.request.safeAddress,
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [input.request.to, input.request.value, input.request.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature],
    account: account.address,
    value: input.request.value,
  });
  const exactMaximumWei = gas * feePerGas;
  const cap = BigInt(input.config.transactionCaps.createTaskMaxWei);
  if (cap <= 0n || exactMaximumWei > cap) {
    throw new Error(`native createTask exact gas maximum ${exactMaximumWei} exceeds configured cap ${cap}`);
  }
  const txHash = await executeSafeTransaction(
    input.publicClient as Parameters<typeof executeSafeTransaction>[0],
    input.walletClient as Parameters<typeof executeSafeTransaction>[1],
    input.request,
  );
  const receipt = await input.publicClient.getTransactionReceipt({ hash: txHash });
  const taskIds = receipt.logs.flatMap((log) => {
    if (!sameHex(log.address, chain.jinnRouter)) return [];
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_V3_ABI,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (decoded.eventName !== 'TaskCreated') return [];
      return [(decoded.args as unknown as { readonly taskId: bigint }).taskId];
    } catch { return []; }
  });
  if (taskIds.length !== 1) {
    throw new Error(`native requester transaction ${txHash} has ${taskIds.length} TaskCreated events`);
  }
  return { taskId: taskIds[0]!, txHash };
}

async function loadConfiguredWallet(input: {
  readonly config: NativeInfrastructureFactoryInput;
  readonly password: string;
  readonly expectedOwnerAddress: `0x${string}`;
  readonly accountIndex: number;
}): Promise<WalletClient> {
  if (!sameHex(input.expectedOwnerAddress, input.config.evmCustody.expectedOwnerAddress)
    || input.accountIndex !== input.config.evmCustody.accountIndex) {
    throw new Error('native EVM activation request does not equal structured custody authority');
  }
  const mnemonic = await decryptMnemonic(
    await readFile(input.config.evmCustody.keystorePath, 'utf8'),
    input.password,
  );
  const account = input.accountIndex === 0
    ? deriveMasterSigner(mnemonic)
    : deriveAgentSigner(mnemonic, input.accountIndex);
  if (!sameHex(getAddress(account.address), input.expectedOwnerAddress)) {
    throw new Error('native EVM keystore/account index does not derive the configured owner');
  }
  return createJinnWalletClient(input.config.rpcUrl, 'base-sepolia', account);
}

/** First-party Base Sepolia I/O owner selected by native-production-deployment. */
export async function createNativeInfrastructure(
  input: NativeInfrastructureFactoryInput,
): Promise<NativeInfrastructurePrimitives> {
  if (input.network !== 'testnet' || input.chain.chainId !== 84532 || input.chain.generation !== 'today') {
    throw new Error('first-party native infrastructure supports only Base Sepolia today mode');
  }
  const publicClient = createJinnPublicClient(input.rpcUrl, 'base-sepolia');
  const viemReads = createViemBaseSepoliaReadClients(publicClient);
  const anchorClient = createBaseSepoliaFinalizedAnchorClient(viemReads.anchor);
  const records = createBaseSepoliaRecordTransport({
    ipfsApiUrl: input.ipfs.apiUrl,
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
  const requester = input.role === 'requester'
    ? createRequesterReads({ config: input, publicClient })
    : undefined;
  const evaluator = input.role === 'evaluator'
    ? createBaseSepoliaEvaluatorReads({ config: input, publicClient, records })
    : undefined;
  const solver = input.role === 'solver' ? createSolverReads({ config: input, publicClient, records }) : undefined;
  const endpoints = new Set<NativePublicEndpointOwner>();
  let active: NativeWriteSession | undefined;
  let closed = false;

  return {
    inspectTarget: () => inspectBaseSepoliaNativeTarget(input, viemReads.target),
    anchorClient,
    settlementOwnership: viemReads.settlementOwnership,
    authorityTime: createBaseSepoliaAuthorityTime(publicClient),
    records,
    ...(requester === undefined ? {} : { requester: requester.reads }),
    ...(evaluator === undefined ? {} : { evaluator }),
    ...(solver === undefined ? {} : { solver }),
    async mountPublicSource(handler) {
      if (closed) throw new Error('native infrastructure is closed');
      const owner = await mountBaseSepoliaPublicSource({
        listen: input.publicListen,
        publicBaseUrl: input.publicBaseUrl,
        handler,
      });
      endpoints.add(owner);
      return {
        ready: owner.ready,
        async close() {
          endpoints.delete(owner);
          await owner.close();
        },
      };
    },
    async activateWrites(activation) {
      if (closed) throw new Error('native infrastructure is closed');
      if (active !== undefined) throw new Error('native infrastructure write authority is already activated');
      if (activation.role !== input.role) throw new Error('native infrastructure cannot activate another product role');
      const walletClient = await loadConfiguredWallet({
        config: input,
        password: activation.password,
        expectedOwnerAddress: activation.expectedOwnerAddress,
        accountIndex: activation.accountIndex,
      });
      const pin = createRegistryPinPort({
        registryUrl: input.ipfs.apiUrl,
        fetchImpl: globalThis.fetch.bind(globalThis),
      });
      if (input.role === 'requester') {
        if (requester === undefined) throw new Error('native requester read owner is unavailable');
        const venue = requesterVenue({ config: input, publicClient });
        const terms = postingTerms(input);
        const posting = {
          ipfs: pin,
          intents: venue.intents,
          safe: {
            broadcastCreateTask: (request: Parameters<typeof requesterPostingOutcome>[0]['request']) => requesterPostingOutcome({
              publicClient,
              walletClient,
              config: input,
              request,
            }),
          },
        };
        const session: NativeWriteSession = {
          writes: {
            role: 'requester',
            postingTerms: terms,
            requesterBackend: makeMarketplaceBackend(marketplaceChain(input), {
              creatorSafe: input.safeAddress,
              terms,
              posting,
              observe: venue.observe,
            }),
          },
          venue,
          close: venue.close,
        };
        active = session;
        return session;
      }
      if (activation.venueAuthority === undefined || input.marketplaceAgentAddress === undefined) {
        throw new Error('native solver/evaluator activation requires product venue authority and marketplace agent');
      }
      const chain = marketplaceChain(input);
      const baseVenue: BaseVenue = createBaseVenue({
        chain,
        publicClient: publicClient as Parameters<typeof createBaseVenue>[0]['publicClient'],
        walletClient: walletClient as Parameters<typeof createBaseVenue>[0]['walletClient'],
        safeAddress: input.safeAddress,
        stateDbPath: join(input.stateDir, 'venue.sqlite'),
        priorityMech: input.marketplaceAgentAddress,
        pin: pin.pin,
        verifySettlementGrade: activation.venueAuthority.verifySettlementGrade,
        isAuthorizedMechOrigin: activation.venueAuthority.isAuthorizedMechOrigin,
        observations: activation.venueAuthority.observations,
        broadcast: {
          maxCostWei: (request) => operationGasCap(input, request.data),
        },
      });
      const venue = venuePrimitives({
        logSource: baseVenue.logSource,
        publicClient,
        closeOwned: baseVenue.close,
      });
      const writes = input.role === 'solver'
        ? {
            role: 'solver' as const,
            claim: {
              priorityMech: input.marketplaceAgentAddress,
              async broadcast(request: Parameters<NativeClaimBroadcastPort['broadcast']>[0]) {
                return baseVenue.claim.claimTask({
                  taskId: request.taskId,
                  priorityMech: request.priorityMech,
                  operationId: request.operationId,
                });
              },
            },
            deliveryBroadcaster: baseVenue.safe,
            settlement: baseVenue.settlement,
          }
        : {
            role: 'evaluator' as const,
            verdict: baseVenue.verdict ?? (() => { throw new Error('today venue has no verdict ports'); })(),
          };
      const session = { writes, venue, close: venue.close } as NativeWriteSession;
      active = session;
      return session;
    },
    async close() {
      if (closed) return;
      closed = true;
      await active?.close();
      await Promise.all([...endpoints].map((owner) => owner.close()));
      endpoints.clear();
    },
  };
}
