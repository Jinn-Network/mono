import type { Address, WalletClient } from 'viem';
import type { VenueBroadcaster } from './safe.js';
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

export {
  JINN_ROUTER_ABI,
  MECH_MARKETPLACE_ABI,
  MECH_ABI,
  MECH_MARKETPLACE_DELIVER_ABI,
} from "@jinn-network/contract-abis/operator";

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
