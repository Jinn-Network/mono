import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { EvidenceRecordReference } from '@jinn-network/evidence-repository';
import type {
  MarketplaceChainConfig,
  MarketplaceRequesterBackend,
  PostingOutcome,
  PostingTerms,
  SettlementPorts,
} from '@jinn-network/marketplace-binding';
import type { MarketplaceProtocolObservation } from '@jinn-network/marketplace-projector';
import type {
  BaseVenueSafeBroadcaster,
  ChainLogSource,
  VerdictPorts,
} from '@jinn-network/marketplace-venue-base';
import type { ProtocolObservation } from '@jinn-network/task-execution-protocol';
import type { Address, Hex } from 'viem';
import type {
  CanonicalTaskCreated,
  CanonicalTaskCreatedRead,
  NativeAuthorityTimeAnchor,
} from '../native-requester/requester.js';
import type {
  NativeClaimBroadcastPort,
  NativeClaimCanonicalReader,
} from './native-claim-coordinator.js';
import type { NativeSolutionSettlementPort } from './native-solution-coordinator.js';
import type {
  NativeEvaluatorChainReconciliationPort,
} from './native-evaluator-coordinator.js';
import type { NativeOperatorConfig } from './native-product-config.js';

const ALLOWED_PACKAGES = new Set([
  'viem',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-repository',
  '@jinn-network/marketplace-binding',
  '@jinn-network/marketplace-projector',
  '@jinn-network/marketplace-venue-base',
  '@jinn-network/record-discovery-transport-http',
  '@jinn-network/task-execution-workspace',
]);

const FORBIDDEN_AUTHORITY_MARKERS = [
  'createNativeOperatorHost',
  'RoleIdentitySet',
  'IdentityStore',
  'verifyEnvelopeBinding',
  'evaluateNativeClaim',
  'NativeClaimCoordinator',
  'NativeSolutionCoordinator',
  'NativeEvaluatorCoordinator',
  'gateVerdictObservation',
  'capabilityGrants',
  'signerHandle',
] as const;

export class NativeInfrastructureBundleError extends Error {
  override readonly name = 'NativeInfrastructureBundleError';
}

export interface NativeInfrastructureFactoryInput {
  readonly network: 'testnet';
  readonly rpcUrl: string;
  readonly role: NativeOperatorConfig['role'];
  readonly safeAddress: `0x${string}`;
  readonly marketplaceAgentAddress?: `0x${string}`;
  readonly evmCustody: NativeOperatorConfig['evmCustody'];
  readonly publicBaseUrl: string;
  readonly publicListen: NativeOperatorConfig['publicListen'];
  readonly ipfs: NativeOperatorConfig['ipfs'];
  readonly chain: {
    readonly chainId: 84532;
    readonly generation: 'today';
    readonly contracts: NativeOperatorConfig['contracts'];
  };
  readonly transactionCaps: NativeOperatorConfig['transactionCaps'];
  readonly postingTerms?: NonNullable<NativeOperatorConfig['postingTerms']>;
  readonly stateDir: string;
  readonly finality: NativeOperatorConfig['finality'];
}

export interface NativeTargetInspection {
  readonly chainId: number;
  readonly contracts: Readonly<Record<'taskCoordinator' | 'jinnRouter' | 'mechMarketplace' | 'activityChecker', {
    readonly address: `0x${string}`;
    readonly codeHash: `0x${string}`;
  }>>;
  readonly safeAddress: `0x${string}`;
  readonly marketplaceAgentAddress?: `0x${string}`;
  readonly marketplaceAgentAuthorized?: boolean;
  readonly ownerBalanceWei: bigint;
  readonly safeBalanceWei: bigint;
  readonly escrowRequiredWei: bigint;
  readonly estimatedMaximumWei: Readonly<Partial<Record<
    'createTask' | 'claim' | 'solutionSettlement' | 'evaluationClaim' | 'verdictSettlement',
    bigint
  >>>;
  readonly canonicalBlock: bigint;
  readonly finalizedBlock: bigint;
}

export interface NativePublicEndpointOwner {
  readonly ready: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}

export interface NativeReadOnlyVenuePrimitives {
  /** Raw chain owner only. Product composition performs enrichment, projection and publication. */
  readonly rawLogSource: Pick<ChainLogSource,
    'poll' | 'cursor' | 'finalizedCheckpoint' | 'logsInRange' | 'orphanedBlockHashes'
  >;
  readonly health: () => Promise<{
    readonly canonicalBlock: bigint;
    readonly finalizedBlock: bigint;
    readonly caughtUp: boolean;
  }>;
  readonly readFinalizedBlockNumber: () => bigint;
  readonly readCanonicalBlockHash: (blockNumber: bigint) => Promise<Hex | undefined>;
  readonly close: () => Promise<void>;
}

export interface NativePublicRecordTransport {
  readonly byLocation: (url: string) => Promise<Uint8Array>;
  readonly byDigest: (digest: `sha256:${string}`) => Promise<Uint8Array>;
  readonly byRawCid: (cid: string) => Promise<Uint8Array>;
}

export interface NativeRequesterReadPrimitives {
  readonly authorityTime: () => Promise<NativeAuthorityTimeAnchor>;
  readonly recoverPosting: (draft: {
    readonly chain: MarketplaceChainConfig;
    readonly creatorSafe: `0x${string}`;
    readonly taskDigest: `sha256:${string}`;
    readonly submissionDigest: `sha256:${string}`;
    readonly terms: PostingTerms;
    readonly maxClaims: 1;
  }) => Promise<PostingOutcome | null>;
  readonly canonicalTaskCreated: (expected: {
    readonly chainId: number;
    readonly coordinator: `0x${string}`;
    readonly creator: `0x${string}`;
    readonly taskId: bigint;
    readonly taskDigest: `sha256:${string}`;
    readonly txHash: `0x${string}`;
    readonly terms: PostingTerms;
    readonly maxClaims: 1;
  }) => Promise<CanonicalTaskCreatedRead>;
}

export interface NativeAuthorityTimePrimitives {
  readonly latestFinalized: () => Promise<NativeAuthorityTimeAnchor>;
  readonly verifyFinalized: (anchor: NativeAuthorityTimeAnchor) => Promise<boolean>;
}

export interface NativeSolverReadPrimitives {
  readonly canonicalTaskCreated: (lookup: Omit<CanonicalTaskCreated, 'canonical'>) => Promise<CanonicalTaskCreatedRead>;
  readonly claimCanonical: NativeClaimCanonicalReader;
  readonly solutionSettlementCanonical: NativeSolutionSettlementPort['readCanonical'];
}

export interface NativeEvaluatorReadPrimitives {
  /** Independently rechecks the requester source's today-mode Task-to-Submission association. */
  readonly canonicalTaskCreated: (lookup: Omit<CanonicalTaskCreated, 'canonical'>) => Promise<CanonicalTaskCreatedRead>;
  /**
   * Today mode does not place the solution Delivery digest on the router event. This reader
   * therefore joins the exact Mech delivery payload to the canonical router claim and returns
   * a fact only when the payload bytes hash to the externally advertised digest.
   */
  readonly readCanonicalSolutionDelivery: (expected: {
    readonly chainId: 84532;
    readonly coordinator: `0x${string}`;
    readonly router: `0x${string}`;
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly requestId: `0x${string}`;
    readonly operator: `0x${string}`;
    readonly advertisedDeliveryDigest: `sha256:${string}`;
  }) => Promise<{
    readonly transactionHash: `0x${string}`;
    readonly blockHash: `0x${string}`;
    readonly blockNumber: bigint;
    readonly finalized: true;
  } | null>;
  readonly chain: NativeEvaluatorChainReconciliationPort;
  readonly preSettlementClaimTime: () => Promise<string>;
  readonly blockTime: (blockNumber: bigint) => Promise<string>;
}

export interface NativeRequesterWritePrimitives {
  readonly role: 'requester';
  readonly postingTerms: PostingTerms;
  readonly requesterBackend: Pick<MarketplaceRequesterBackend, 'post' | 'recoverPosting'>;
}

export interface NativeSolverWritePrimitives {
  readonly role: 'solver';
  readonly claim: NativeClaimBroadcastPort;
  readonly deliveryBroadcaster: BaseVenueSafeBroadcaster;
  readonly settlement: SettlementPorts;
}

export interface NativeEvaluatorWritePrimitives {
  readonly role: 'evaluator';
  readonly verdict: VerdictPorts;
}

export type NativeWritePrimitives =
  | NativeRequesterWritePrimitives
  | NativeSolverWritePrimitives
  | NativeEvaluatorWritePrimitives;

export interface NativeVenueAuthorityInput {
  readonly verifySettlementGrade: SettlementPorts['verifySettlementGrade'];
  readonly observations: () => Promise<readonly ProtocolObservation[]>;
  readonly isAuthorizedMechOrigin: (address: Address) => boolean;
}

export interface NativeWriteSession {
  readonly writes: NativeWritePrimitives;
  /** Exactly one activated venue owner for this process/state path. */
  readonly venue: NativeReadOnlyVenuePrimitives;
  readonly close: () => Promise<void>;
}

/**
 * First-party or digest-pinned I/O owner. It never receives Ed25519 identity paths, trust
 * policy, record derivation, operation identifiers, or gate decisions. EVM custody is activated
 * only after the product has completed read-only target/funding/cap checks.
 */
export interface NativeInfrastructurePrimitives {
  readonly inspectTarget: () => Promise<NativeTargetInspection>;
  readonly anchorClient: import('./native-trust-catalog.js').NativeFinalizedAnchorReadClient;
  /**
   * Safe-ownership read for the settlement-authority association (spec/2026-08-07 §2.3c step 5).
   * Surfaced here because the parallel native-main deployment path opens the trust catalog with
   * only `infrastructure.*` and holds no public client of its own. That path retires at stage 5
   * per DR-2026-08-05; until then it must compile and run.
   */
  readonly settlementOwnership: import('./native-trust-catalog.js').NativeSettlementOwnershipReadClient;
  readonly authorityTime: NativeAuthorityTimePrimitives;
  readonly records: NativePublicRecordTransport;
  readonly requester?: NativeRequesterReadPrimitives;
  readonly solver?: NativeSolverReadPrimitives;
  readonly evaluator?: NativeEvaluatorReadPrimitives;
  readonly evidenceReference?: (digest: `sha256:${string}`) => Promise<EvidenceRecordReference | undefined>;
  readonly mountPublicSource: (handler: (request: Request) => Promise<Response>) => Promise<NativePublicEndpointOwner>;
  readonly activateWrites: (input: {
    readonly role: NativeOperatorConfig['role'];
    readonly password: string;
    readonly expectedOwnerAddress: `0x${string}`;
    readonly accountIndex: number;
    /** Mandatory for solver/evaluator BaseVenue activation; requester opens posting-only I/O. */
    readonly venueAuthority?: NativeVenueAuthorityInput;
  }) => Promise<NativeWriteSession>;
  readonly close: () => Promise<void>;
}

/**
 * Intentionally opaque here: the in-tree deployment factory validates the concrete primitive
 * object. The bundle is allowed to provide I/O mechanics, never product authority.
 */
export interface NativeInfrastructureModule {
  createNativeInfrastructure(input: NativeInfrastructureFactoryInput): unknown | Promise<unknown>;
}

function packageRoot(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0]!;
  return specifier.split('/').slice(0, 2).join('/');
}

function importedSpecifiers(source: string): string[] {
  const specifiers = [
    ...source.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu),
    ...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map((match) => match[1]!);
  const dynamicCalls = [...source.matchAll(/import\s*\(([^)]*)\)/gu)];
  if (dynamicCalls.some((match) => !/^\s*['"][^'"]+['"]\s*$/u.test(match[1]!))) {
    throw new NativeInfrastructureBundleError('infrastructure bundle contains a non-literal dynamic import');
  }
  return specifiers;
}

function validateSource(bytes: Uint8Array): void {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const marker of FORBIDDEN_AUTHORITY_MARKERS) {
    if (source.includes(marker)) {
      throw new NativeInfrastructureBundleError(`infrastructure bundle contains forbidden product authority marker ${marker}`);
    }
  }
  for (const specifier of importedSpecifiers(source)) {
    if (specifier.startsWith('.')
      || specifier.startsWith('/')
      || specifier.startsWith('file:')
      || specifier.startsWith('data:')) {
      throw new NativeInfrastructureBundleError(`infrastructure bundle is not self-contained (${specifier})`);
    }
    if (!specifier.startsWith('node:') && !ALLOWED_PACKAGES.has(packageRoot(specifier))) {
      throw new NativeInfrastructureBundleError(`infrastructure bundle import is not allowlisted (${specifier})`);
    }
  }
}

export async function loadNativeInfrastructureBundle(input: {
  readonly path: string;
  readonly digest: `sha256:${string}`;
}): Promise<NativeInfrastructureModule> {
  const metadata = await lstat(input.path).catch((cause) => {
    throw new NativeInfrastructureBundleError(`infrastructure bundle cannot be inspected: ${String(cause)}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new NativeInfrastructureBundleError('infrastructure bundle must be a regular non-symlink file');
  }
  const bytes = await readFile(input.path);
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  if (actual !== input.digest) {
    throw new NativeInfrastructureBundleError(`infrastructure bundle digest mismatch: expected ${input.digest}, got ${actual}`);
  }
  validateSource(bytes);
  const loaded = await import(`${pathToFileURL(input.path).href}?sha256=${actual.slice('sha256:'.length)}`) as Partial<NativeInfrastructureModule>;
  if (typeof loaded.createNativeInfrastructure !== 'function') {
    throw new NativeInfrastructureBundleError('infrastructure bundle must export createNativeInfrastructure');
  }
  return loaded as NativeInfrastructureModule;
}
