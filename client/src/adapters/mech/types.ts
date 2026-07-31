import type { Address, WalletClient } from 'viem';
import type { VenueBroadcaster } from './safe.js';
import type { DiscoveryAPI } from '../../discovery/types.js';
import type {
  AutopilotMutationResult,
  JinnRepoAutopilotSessionTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import type {
  AutopilotEvaluationContextObservation,
} from '../../harnesses/impls/jinn-repo-evaluator/autopilot-evaluation-context.js';

export interface EvictionRecoveryConfig {
  serviceId: number;
  stakingProxyAddress: Address;
  distributorAddress: Address;
  masterWalletClient: WalletClient;
}

export interface MechAdapterConfig {
  /**
   * Base RPC endpoint(s). Accepts string OR array — when an array, the mech
   * adapter builds a viem `fallback()` chain via buildFallbackTransport.
   * Single-string form remains the back-compat default.
   */
  rpcUrl: string | readonly string[];
  mechMarketplaceAddress: `0x${string}`;
  routerAddress: `0x${string}`;  // JinnRouter proxy on Base
  mechContractAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  agentEoaPrivateKey: `0x${string}`;
  ipfsRegistryUrl: string;  // Upload endpoint (e.g., https://registry.autonolas.tech)
  ipfsGatewayUrl: string;   // Read endpoint (e.g., https://gateway.autonolas.tech)
  /**
   * Controls the public IPFS fallback used by JSON/raw IPFS reads.
   * - omit → production default (`ipfs.io` via `fetchFromIpfs`)
   * - false → primary gateway only (hermetic e2e / mock IPFS)
   * - string → alternate fallback gateway base
   */
  ipfsFallbackGatewayUrl?: string | false;
  pollIntervalMs: number;
  /** Optional cap for delivery-log scans; omit for full-history recovery. */
  mechDeliverBackfillLookbackBlocks?: bigint;
  /**
   * Optional task-discovery index. The subgraph is a candidate source only:
   * the adapter still verifies claimability on-chain before yielding work.
   */
  taskDiscovery?: {
    /**
     * DiscoveryAPI instance for finding claimable tasks. When provided,
     * replaces direct subgraph calls in discoverSubgraphRestorationTasks.
     */
    discoveryApi?: DiscoveryAPI;
    solverNetManifestCids?: string[];
    /**
     * Lower bound for the canonical on-chain TaskCreated scan. The subgraph is
     * only an acceleration path; this scan is the correctness path.
     */
    onchainFromBlock?: number | bigint;
    /** Optional release/acceptance guard: only discover these on-chain task ids. */
    allowedTaskIds?: string[];
    pageSize?: number;
    maxPages?: number;
    fetchImpl?: typeof fetch;
  };
  chainId: number;
  /** Base mainnet V1, Phase 1b V2, or Task-native V3 delivery claim ABI. */
  routerClaimDeliveryVariant: 'v1' | 'v2' | 'v3';
  evictionRecovery?: EvictionRecoveryConfig;
  /**
   * Whether this operator holds the `evaluator` role in a joined SolverNet.
   * Omitted ⇒ enabled (opt-out default): a bare construction site keeps the
   * historical scan-everything behaviour. Production callers (main.ts,
   * join-applier.ts) always pass an explicit boolean. Gates three surfaces:
   * ingest of delivery-claimed logs into the pending-evaluation set, the boot
   * rehydrate of that set, and the per-cycle scan of evaluation opportunities.
   * Ref #547.
   */
  evaluatorEnabled?: boolean;
  /**
   * The single Safe broadcaster this operator's Safe transactions route through (finding E16 /
   * the C2 ruling: per-daemon state, not a process-global). May be supplied at construction when
   * the host already has one (CLI verbs); the daemon path (main.ts) supplies it later via
   * `MechAdapter.setBroadcaster` once the composition root has built one, since composition is
   * assembled after this adapter today. Left undefined when no composition exists (mainnet:
   * `TaskCoordinator`/`JinnRouterV3` are not deployed there yet) — Safe-writing calls then fail
   * loudly with `executeSafeTransaction`'s "no venue broadcaster supplied" error, same as before
   * this ruling, just per-call rather than via an unset process-global.
   */
  broadcaster?: VenueBroadcaster;
  /**
   * Optional lifecycle read port for Autopilot evaluation admission. The
   * adapter never fabricates an adoption receipt: without an accepted,
   * correlation-exact observation the Solution remains pending.
   */
  autopilotEvaluationContextResolver?: {
    resolve(input: {
      task: JinnRepoAutopilotSessionTask;
      solution: AutopilotMutationResult;
      taskId: string;
      attemptIndex: number;
      requestId: string;
      solutionEnvelopeCid: string;
      solutionOperatorSafe: string;
      evaluatorOperatorSafe: string;
    }): Promise<AutopilotEvaluationContextObservation | undefined>;
  };
}

export const MECH_MARKETPLACE_ABI = [
  {
    name: 'request',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'requestData', type: 'bytes' },
      { name: 'maxDeliveryRate', type: 'uint256' },
      { name: 'paymentType', type: 'bytes32' },
      { name: 'priorityMech', type: 'address' },
      { name: 'responseTimeout', type: 'uint256' },
      { name: 'paymentData', type: 'bytes' },
    ],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    name: 'mapRequestCounts',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requester', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'minResponseTimeout',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'maxResponseTimeout',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'mapRequestIdInfos',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [
      { name: 'priorityMech', type: 'address' },
      { name: 'deliveryMech', type: 'address' },
      { name: 'requester', type: 'address' },
      { name: 'responseTimeout', type: 'uint256' },
      { name: 'deliveryRate', type: 'uint256' },
      { name: 'paymentType', type: 'bytes32' },
    ],
  },
  {
    name: 'MarketplaceRequest',
    type: 'event',
    inputs: [
      { name: 'priorityMech', type: 'address', indexed: true },
      { name: 'requester', type: 'address', indexed: true },
      { name: 'numRequests', type: 'uint256', indexed: false },
      { name: 'requestIds', type: 'bytes32[]', indexed: false },
      { name: 'requestDatas', type: 'bytes[]', indexed: false },
    ],
  },
] as const;

export const MECH_ABI = [
  {
    name: 'paymentType',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    name: 'maxDeliveryRate',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'deliverToMarketplace',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestIds', type: 'bytes32[]' },
      { name: 'datas', type: 'bytes[]' },
    ],
    outputs: [{ name: 'deliveredRequests', type: 'bool[]' }],
  },
  {
    name: 'isOperator',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'getOperator',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'Deliver',
    type: 'event',
    inputs: [
      { name: 'mech', type: 'address', indexed: true },
      { name: 'mechServiceMultisig', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: false },
      { name: 'deliveryRate', type: 'uint256', indexed: false },
      { name: 'data', type: 'bytes', indexed: false },
    ],
  },
] as const;

export const MECH_MARKETPLACE_DELIVER_ABI = [
  {
    name: 'deliverMarketplace',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestIds', type: 'bytes32[]' },
      { name: 'deliveryRates', type: 'uint256[]' },
    ],
    outputs: [{ name: 'deliveredRequests', type: 'bool[]' }],
  },
] as const;

/** JinnRouter V1 (Base mainnet deployment). */
export const JINN_ROUTER_CLAIM_DELIVERY_V1_ABI = [
  {
    name: 'claimDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

/** JinnRouter V2 (testnet / evidence hash). */
export const JINN_ROUTER_CLAIM_DELIVERY_V2_ABI = [
  {
    name: 'claimDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestId', type: 'bytes32' },
      { name: 'evidenceHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

export const JINN_ROUTER_ABI = [
  {
    name: 'taskCoordinator',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'createTask',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'taskCidDigest', type: 'bytes32' },
      { name: 'manifestDigest', type: 'bytes32' },
      {
        // Tokenless-OLAS pivot: TaskCoordinator.TaskPolicy is `maxClaims` plus
        // `allowSolverSelfEvaluation` (default false → self-evaluation blocked,
        // the independent-evaluation invariant; a testnet SolverNet sets it true
        // so one operator can close the loop solo). Off-chain scheduling intent
        // (windows / lease / quorum) stays off-chain in the task.v1 `claimPolicy`.
        name: 'policy',
        type: 'tuple',
        components: [
          { name: 'maxClaims', type: 'uint32' },
          { name: 'allowSolverSelfEvaluation', type: 'bool' },
        ],
      },
      { name: 'solutionMaxDeliveryRate', type: 'uint256' },
      { name: 'verdictMaxDeliveryRate', type: 'uint256' },
      { name: 'responseTimeout', type: 'uint256' },
    ],
    outputs: [{ name: 'taskId', type: 'uint256' }],
  },
  {
    name: 'claimTask',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'taskId', type: 'uint256' },
      { name: 'priorityMech', type: 'address' },
    ],
    outputs: [
      { name: 'attemptIndex', type: 'uint32' },
      { name: 'requestId', type: 'bytes32' },
    ],
  },
  {
    name: 'TaskCreated',
    type: 'event',
    inputs: [
      { name: 'creator', type: 'address', indexed: true },
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'manifestDigest', type: 'bytes32', indexed: true },
      { name: 'taskCidDigest', type: 'bytes32', indexed: false },
      { name: 'maxClaims', type: 'uint32', indexed: false },
      { name: 'solutionBudget', type: 'uint256', indexed: false },
      { name: 'verdictBudget', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'TaskAttemptCreated',
    type: 'event',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'operator', type: 'address', indexed: false },
      { name: 'priorityMech', type: 'address', indexed: false },
      { name: 'deliveryRate', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'claimEvaluation',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'taskId', type: 'uint256' },
      { name: 'attemptIndex', type: 'uint32' },
      { name: 'evaluatorMech', type: 'address' },
      { name: 'evaluationTaskCidDigest', type: 'bytes32' },
    ],
    outputs: [
      { name: 'verdictIndex', type: 'uint32' },
      { name: 'verdictRequestId', type: 'bytes32' },
    ],
  },
  {
    name: 'EvaluationAttemptCreated',
    type: 'event',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: true },
      { name: 'verdictIndex', type: 'uint32', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: false },
      { name: 'evaluator', type: 'address', indexed: false },
      { name: 'priorityMech', type: 'address', indexed: false },
      { name: 'deliveryRate', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'claimSolutionDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requestId', type: 'bytes32' },
      { name: 'solutionDigest', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'claimVerdictDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'verdictRequestId', type: 'bytes32' },
      { name: 'verdictDigest', type: 'bytes32' },
      { name: 'verdictCode', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    name: 'SolutionDeliveryClaimed',
    type: 'event',
    inputs: [
      { name: 'operator', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: false },
    ],
  },
  {
    name: 'VerdictDeliveryClaimed',
    type: 'event',
    inputs: [
      { name: 'evaluator', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: false },
      { name: 'verdictIndex', type: 'uint32', indexed: false },
      { name: 'verdictCode', type: 'uint8', indexed: false },
    ],
  },
  {
    name: 'claimed',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export { SAFE_ABI } from '../../contracts/abis.js';

// Safe deployment ABIs
export const SAFE_SETUP_ABI = [
  {
    name: 'setup',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
] as const;

export const SAFE_PROXY_FACTORY_ABI = [
  {
    name: 'createProxyWithNonce',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
] as const;

export const SAFE_SINGLETON_ADDRESS: `0x${string}` = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552';
export const SAFE_PROXY_FACTORY_ADDRESS: `0x${string}` = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2';

export const NATIVE_PAYMENT_TYPE = '0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1' as const;

// Autonolas IPFS gateway — constructs URLs from raw SHA256 multihash digests
// Format: f01551220{32-byte-hex-digest}
// 0x55 = raw codec (CIDv1 from Autonolas registry), 0x1220 = sha2-256 multihash
export const IPFS_GATEWAY_PREFIX = 'https://gateway.autonolas.tech/ipfs/f01551220' as const;
