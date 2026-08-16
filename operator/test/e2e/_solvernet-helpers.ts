/**
 * Helpers shared by the SolverNet creation/launch e2e phase.
 *
 * Keeps `task-first-helpers.ts` from ballooning while running the manifest-
 * driven path against a Base Sepolia anvil fork (Task: e2e SolverNet
 * creation + launch + lifecycle).
 *
 * What lives here:
 *   - buildSignedSolverNetManifestV1   — assembles + signs an unsigned
 *     `SolverNetManifestV1` from the launcher operator's bootstrap output
 *     (agent EOA + agentId + Safe).
 *   - createForkMetadataPublisher      — viem-backed `MetadataPublisher`
 *     that calls `IdentityRegistry.setMetadata` on the anvil fork using the
 *     launcher's agent EOA.
 *   - createInMemorySubgraphClient     — stub `SubgraphClient` whose event
 *     list the test pushes to manually after each `setMetadata` write
 *     (no real subgraph indexer runs in-fork).
 *   - createInMemoryIpfsClient         — `IpfsClient` returning deterministic
 *     content-addressed CIDs without hitting any IPFS network.
 */

import { createHash } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { IDENTITY_REGISTRY_SET_METADATA_ABI } from '../../src/erc8004/abis.js';
import { canonicalJson } from '../../src/util/canonical-json.js';
import {
  signManifest,
  type UnsignedSolverNetManifestV1,
} from '../../src/solvernets/manifest.js';
import type {
  IpfsClient,
  MetadataPublisher,
  SetMetadataPublishResult,
  SubgraphClient,
} from '../../src/solvernets/launch-publisher.js';
import type { SetMetadataEvent } from '../../src/solvernets/most-recent-wins.js';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';

// ── Manifest builder ────────────────────────────────────────────────────────

export interface BuildSignedManifestOptions {
  solverNetId: string;
  name: string;
  description?: string;
  /** Master Safe address for the launcher (from earning bootstrap). */
  safeAddress: Address;
  /** Agent EOA address (derived from the launcher's mnemonic). */
  agentEoa: Address;
  /** Decimal-string `agentId` minted in the IdentityRegistry. */
  agentId: string;
  /** Agent EOA private key — used to EIP-191 sign the manifest. */
  agentEoaPrivateKey: Hex;
  /** Optional ISO-string overrides for createdAt/launchedAt (deterministic tests). */
  createdAt?: string;
  launchedAt?: string;
  /** Wei-as-decimal-string fees for solution / verdict. */
  solutionPriceWei?: string;
  verdictPriceWei?: string;
}

/**
 * Build and EIP-191 sign a minimal-but-valid `SolverNetManifestV1` whose
 * `contract.schemas` are placeholder JSON Schemas (`{ type: 'object' }`).
 *
 * The e2e test only needs the launch + lifecycle paths; the contract block's
 * shape need not echo the real `PREDICTION_V1_SOLVER_NET_CONTRACT` JSON
 * Schema — it just needs to be valid against `SolverNetManifestV1Schema`.
 * The full schema-mirror story is unit-tested elsewhere.
 */
export async function buildSignedSolverNetManifestV1(
  opts: BuildSignedManifestOptions,
): Promise<SolverNetManifestV1> {
  const unsigned: UnsignedSolverNetManifestV1 = {
    schemaVersion: 'solvernet.manifest.v1',
    solverNetId: opts.solverNetId,
    network: 'base-sepolia',
    name: opts.name,
    description: opts.description ?? 'E2E SolverNet manifest fixture.',
    launcher: {
      safeAddress: opts.safeAddress,
      agentEoa: opts.agentEoa,
      agentId: opts.agentId,
    },
    contract: {
      id: 'prediction',
      version: 'v1',
      schemas: {
        task: { type: 'object' },
        solution: { type: 'object' },
        verdict: { type: 'object' },
      },
      claimPolicyDefaults: {
        mode: 'parallel',
        maxClaims: 25,
        maxClaimsPerOperator: 1,
        claimLeaseTtlSeconds: 600,
      },
      credentialRequirements: { creator: [], solver: [], evaluator: [] },
      evaluationFunction: {
        id: 'prediction.brier-loss.v1',
        deterministic: true,
        inputs: ['solution', 'resolution'],
        output: 'verdict',
        implementation: 'operator/src/harnesses/impls/prediction-v1-evaluator',
      },
      aggregationFunction: {
        id: 'prediction.trailing-mean-brier-spread.v1',
        deterministic: true,
        inputs: ['verdict[]'],
        output: 'score',
        windowDays: 84,
      },
    },
    solutionPriceWei: opts.solutionPriceWei ?? '1000000000000',
    verdictPriceWei: opts.verdictPriceWei ?? '500000000000',
    openRoles: ['solver', 'evaluator'],
    createdAt: opts.createdAt ?? '2026-05-06T00:00:00.000Z',
    launchedAt: opts.launchedAt ?? '2026-05-06T00:01:00.000Z',
  };

  return signManifest(unsigned, opts.agentEoaPrivateKey);
}

// ── In-memory IPFS adapter ──────────────────────────────────────────────────

/**
 * `IpfsClient` whose `upload` deterministically derives a `bafy<sha256>`-style
 * CID from the canonical JSON of the supplied object, and whose `fetch`
 * returns the parsed JSON body for a previously-uploaded CID.
 *
 * Re-uploading the same logical content yields the same CID — required so
 * the launch state machine's `existingEvents` / cache hits work the same way
 * a real IPFS pinner would.
 */
export function createInMemoryIpfsClient(): IpfsClient {
  const store = new Map<string, unknown>();
  return {
    async upload(data) {
      const canonical = canonicalJson(data as Record<string, unknown>);
      const hex = createHash('sha256').update(canonical).digest('hex');
      const cid = `bafy${hex.slice(0, 52)}`;
      store.set(cid, JSON.parse(canonical));
      return cid;
    },
    async fetch(cid) {
      const data = store.get(cid);
      if (data === undefined) throw new Error(`InMemoryIpfsClient: cid not found: ${cid}`);
      return data;
    },
  };
}

// ── Stub SubgraphClient ─────────────────────────────────────────────────────

/**
 * In-memory subgraph stub — a real subgraph indexer is not running against
 * the anvil fork during e2e. The state machine consults the subgraph mainly
 * for mempool-drop recovery; the happy-path tests never hit those branches,
 * so an empty events list is a truthful baseline.
 *
 * Tests that need to assert "the subgraph saw event X" can append to
 * `events` directly.
 */
export interface InMemorySubgraphClient extends SubgraphClient {
  readonly events: SetMetadataEvent[];
  push(event: SetMetadataEvent): void;
}

export function createInMemorySubgraphClient(): InMemorySubgraphClient {
  const events: SetMetadataEvent[] = [];
  return {
    events,
    push(event) {
      events.push(event);
    },
    async fetchSetMetadataEvents(args) {
      return events.filter((e) => e.key.startsWith(args.keyPrefix));
    },
    async fetchSetMetadataEventsForCid(args) {
      return events.filter((e) => e.key === `solvernet-manifest:${args.manifestCid}`);
    },
  };
}

// ── viem-backed MetadataPublisher for the fork ──────────────────────────────

/**
 * Build a `MetadataPublisher` that calls `IdentityRegistry.setMetadata` on
 * the anvil fork using the launcher's agent EOA. Mirrors the production
 * `createMetadataPublisherFromViem` helper in `daemon-init.ts`, plus a
 * `calls` array so tests can assert key+value bytes without re-decoding the
 * tx.
 */
export interface ForkMetadataPublisherOptions {
  rpcUrl: string;
  identityRegistryAddress: Address;
  agentEoaPrivateKey: Hex;
}

export interface ForkMetadataPublisher extends MetadataPublisher {
  readonly calls: Array<{
    agentId: string;
    key: string;
    value: Uint8Array;
    txHash: Hex;
    blockNumber: number;
  }>;
}

export function createForkMetadataPublisher(
  opts: ForkMetadataPublisherOptions,
): ForkMetadataPublisher {
  const account = privateKeyToAccount(opts.agentEoaPrivateKey);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(opts.rpcUrl),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(opts.rpcUrl),
  });

  const calls: ForkMetadataPublisher['calls'] = [];

  return {
    calls,
    async setMetadata({ agentId, key, value }): Promise<SetMetadataPublishResult> {
      const txHash = await walletClient.writeContract({
        address: opts.identityRegistryAddress,
        abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
        functionName: 'setMetadata',
        args: [BigInt(agentId), key, uint8ArrayToHex(value)],
        account,
        chain: baseSepolia,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new Error(`setMetadata tx ${txHash} reverted on fork`);
      }
      const blockNumber = Number(receipt.blockNumber);
      const record = { agentId, key, value, txHash, blockNumber };
      calls.push(record);
      return { txHash, blockNumber };
    },
  };
}

// ── Misc ────────────────────────────────────────────────────────────────────

/**
 * Lift `Uint8Array` to `0x`-prefixed hex bytes string. Mirrors the helper in
 * `daemon-init.ts`; duplicated here to keep the e2e helper file portable.
 */
export function uint8ArrayToHex(bytes: Uint8Array): Hex {
  let hex = '0x';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex as Hex;
}

/**
 * `keccak256(toBytes(<cid>))` — the manifestDigest convention the Task-first
 * creation path uses when a Task is bound to a launched manifest CID.
 * Surfaced here so the e2e phase can pass it to `createTask`.
 */
export function manifestDigestForCid(cid: string): Hex {
  return keccak256(toBytes(cid));
}
