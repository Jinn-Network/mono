import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_SEPOLIA_TODAY, type MarketplaceChainConfig } from '@jinn-network/marketplace-binding';
import type { NativeRequesterRoles } from '../native-requester/requester.js';
import {
  createNativeRequester,
  createNativeRequesterPostTask,
} from '../native-requester/requester.js';
import {
  loadNativeInfrastructureBundle,
  type NativeInfrastructureFactoryInput,
  type NativeInfrastructureModule,
  type NativeInfrastructurePrimitives,
  type NativeRequesterWritePrimitives,
  type NativeTargetInspection,
} from './native-infrastructure-bundle.js';
import { createNativeOperatorHost, type NativeOperatorHost } from './native-operator-host.js';
import {
  NativeOperatorConfigSchema,
  type NativeOperatorConfig,
  type NativeProductConfig,
} from './native-product-config.js';
import { NativeConstructionScope } from './native-construction-scope.js';
import { buildNativeSolverProductionHost } from './native-solver-production.js';
import { buildNativeEvaluatorProductionHost } from './native-evaluator-production.js';
import { openNativeTrustCatalog, type NativeTrustAuthority } from './native-trust-catalog.js';
import {
  openRoleIdentitySet,
  type NativeRoleIdentityRole,
  type RoleIdentitySet,
} from './role-identities.js';
import { resolveDefaultStateDir } from '../state-dir.js';

const ZERO_CODE_HASH = /^0x0{64}$/u;

export class NativeProductionDeploymentError extends Error {
  override readonly name = 'NativeProductionDeploymentError';
}

export interface NativeDeploymentFactoryInput {
  readonly config: NativeProductConfig;
}

function createInProcessRoleLease(): {
  acquire(): Promise<void>;
  owned(): Promise<boolean>;
  renew(): Promise<void>;
  release(): Promise<void>;
} {
  let held = false;
  return {
    async acquire() { held = true; },
    async owned() { return held; },
    async renew() {},
    async release() { held = false; },
  };
}

function chain(config: NativeOperatorConfig): MarketplaceChainConfig {
  return {
    chainId: config.chainId,
    generation: config.generation,
    taskCoordinator: config.contracts.taskCoordinator as `0x${string}`,
    jinnRouter: config.contracts.jinnRouter as `0x${string}`,
    mechMarketplace: config.contracts.mechMarketplace as `0x${string}`,
    activityChecker: config.contracts.activityChecker as `0x${string}`,
  };
}

function infrastructureInput(config: NativeProductConfig): NativeInfrastructureFactoryInput {
  const native = config.operator.native;
  return {
    network: config.network,
    rpcUrl: config.rpcUrl,
    role: native.role,
    safeAddress: native.safeAddress as `0x${string}`,
    ...(native.marketplaceAgentAddress === undefined
      ? {}
      : { marketplaceAgentAddress: native.marketplaceAgentAddress as `0x${string}` }),
    evmCustody: native.evmCustody,
    publicBaseUrl: native.publicBaseUrl,
    publicListen: native.publicListen,
    ipfs: native.ipfs,
    chain: { chainId: native.chainId, generation: native.generation, contracts: native.contracts },
    transactionCaps: native.transactionCaps,
    ...(native.postingTerms === undefined ? {} : { postingTerms: native.postingTerms }),
    stateDir: native.stateDir,
    finality: native.finality,
  };
}

function isInfrastructure(value: unknown): value is NativeInfrastructurePrimitives {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NativeInfrastructurePrimitives>;
  return typeof candidate.inspectTarget === 'function'
    && typeof candidate.anchorClient?.lookupFinalizedAnchor === 'function'
    && typeof candidate.settlementOwnership?.isOwner === 'function'
    && typeof candidate.authorityTime?.latestFinalized === 'function'
    && typeof candidate.authorityTime?.verifyFinalized === 'function'
    && typeof candidate.records?.byLocation === 'function'
    && typeof candidate.records?.byDigest === 'function'
    && typeof candidate.records?.byRawCid === 'function'
    && typeof candidate.mountPublicSource === 'function'
    && typeof candidate.activateWrites === 'function'
    && typeof candidate.close === 'function';
}

async function infrastructureModule(config: NativeOperatorConfig): Promise<NativeInfrastructureModule> {
  if (config.runtime.provider === 'digest-pinned-bundle') {
    return loadNativeInfrastructureBundle({
      path: config.runtime.infrastructureBundle,
      digest: config.runtime.bundleDigest as `sha256:${string}`,
    });
  }
  const module = await import('./native-base-sepolia-infrastructure.js') as Partial<NativeInfrastructureModule>;
  if (typeof module.createNativeInfrastructure !== 'function') {
    throw new NativeProductionDeploymentError('first-party Base Sepolia infrastructure is unavailable');
  }
  return module as NativeInfrastructureModule;
}

async function openInfrastructure(config: NativeProductConfig): Promise<NativeInfrastructurePrimitives> {
  const module = await infrastructureModule(config.operator.native);
  const opened = await module.createNativeInfrastructure(infrastructureInput(config));
  if (!isInfrastructure(opened)) {
    throw new NativeProductionDeploymentError('native infrastructure did not return the bounded primitive owner');
  }
  return opened;
}

function equalAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requiredOperations(role: NativeOperatorConfig['role']): readonly (
  keyof NativeTargetInspection['estimatedMaximumWei']
)[] {
  switch (role) {
    case 'requester': return ['createTask'];
    case 'solver': return ['claim', 'solutionSettlement'];
    case 'evaluator': return ['evaluationClaim', 'verdictSettlement'];
  }
}

function capFor(config: NativeOperatorConfig, operation: keyof NativeTargetInspection['estimatedMaximumWei']): bigint {
  switch (operation) {
    case 'createTask': return BigInt(config.transactionCaps.createTaskMaxWei);
    case 'claim': return BigInt(config.transactionCaps.claimMaxWei);
    case 'solutionSettlement': return BigInt(config.transactionCaps.solutionSettlementMaxWei);
    case 'evaluationClaim': return BigInt(config.transactionCaps.evaluationClaimMaxWei);
    case 'verdictSettlement': return BigInt(config.transactionCaps.verdictSettlementMaxWei);
  }
}

/** Product-owned, read-only readiness gate. No key, wallet, or transaction port is loaded here. */
export function assertNativeTargetInspection(
  config: NativeOperatorConfig,
  inspection: NativeTargetInspection,
): void {
  if (inspection.chainId !== 84532) throw new NativeProductionDeploymentError(`native target chain ${inspection.chainId} is not Base Sepolia`);
  for (const name of ['taskCoordinator', 'jinnRouter', 'mechMarketplace', 'activityChecker'] as const) {
    const accepted = BASE_SEPOLIA_TODAY[name];
    const expected = config.contracts[name];
    const observed = inspection.contracts[name];
    if (!equalAddress(expected, accepted)
      || !equalAddress(observed.address, accepted)
      || ZERO_CODE_HASH.test(observed.codeHash)) {
      throw new NativeProductionDeploymentError(`native target ${name} address/code does not match the accepted deployment`);
    }
  }
  if (!equalAddress(inspection.safeAddress, config.safeAddress)) {
    throw new NativeProductionDeploymentError('native preflight Safe does not equal structured configuration');
  }
  if (config.role !== 'requester') {
    if (config.marketplaceAgentAddress === undefined
      || inspection.marketplaceAgentAddress === undefined
      || !equalAddress(inspection.marketplaceAgentAddress, config.marketplaceAgentAddress)
      || inspection.marketplaceAgentAuthorized !== true) {
      throw new NativeProductionDeploymentError('native marketplace agent is absent, mismatched, or unauthorized');
    }
  }
  if (inspection.finalizedBlock < 0n || inspection.canonicalBlock < inspection.finalizedBlock) {
    throw new NativeProductionDeploymentError('native preflight chain head is behind finalized state');
  }
  // Exact calldata does not exist at startup. Reserve against configured caps here; each
  // activated broadcaster estimates its exact Safe calldata immediately before signing.
  const ownerGas = requiredOperations(config.role)
    .reduce((total, operation) => total + capFor(config, operation), 0n);
  if (inspection.ownerBalanceWei < ownerGas * 2n) {
    throw new NativeProductionDeploymentError('native EVM owner balance is below the two-times gas reserve');
  }
  if (config.role === 'requester') {
    if (inspection.escrowRequiredWei <= 0n
      || inspection.escrowRequiredWei > BigInt(config.transactionCaps.escrowMaxWei)
      || inspection.safeBalanceWei < inspection.escrowRequiredWei) {
      throw new NativeProductionDeploymentError('native requester Safe escrow is missing or exceeds configured/funded bounds');
    }
  }
}

function configPath(): string {
  const index = process.argv.indexOf('--config');
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]!
    : join(resolveDefaultStateDir(), 'config.json');
}

function loadProductionConfig(): NativeProductConfig {
  const path = configPath();
  if (!existsSync(path)) throw new NativeProductionDeploymentError(`native structured config is missing: ${path}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (cause) {
    throw new NativeProductionDeploymentError(`native structured config is invalid JSON: ${String(cause)}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new NativeProductionDeploymentError('native structured config is invalid: expected an object');
  }
  const record = raw as Record<string, unknown>;
  const rpcUrl = typeof record.rpcUrl === 'string' ? record.rpcUrl : '';
  if (rpcUrl.length === 0) {
    throw new NativeProductionDeploymentError('native structured config is invalid: rpcUrl is required');
  }
  const operator = record.operator;
  const nativeRaw = typeof operator === 'object' && operator !== null
    ? (operator as { native?: unknown }).native
    : undefined;
  const parsed = NativeOperatorConfigSchema.safeParse(nativeRaw);
  if (!parsed.success) throw new NativeProductionDeploymentError(`native structured config is invalid: ${parsed.error.message}`);
  return { network: 'testnet', rpcUrl, operator: { native: parsed.data } };
}

async function openRoles(input: {
  readonly agent: string;
  readonly roles: readonly NativeRoleIdentityRole[];
  readonly storePath: string;
  readonly password: string;
  readonly trust: NativeTrustAuthority;
}): Promise<RoleIdentitySet> {
  return openRoleIdentitySet({
    agent: input.agent,
    requiredRoles: input.roles,
    storePath: input.storePath,
    password: input.password,
    bindingResolver: input.trust.bindingResolver,
    verifyRoleBinding: input.trust.verifyRoleBinding,
  });
}

function roleKeyIds(...sets: readonly RoleIdentitySet[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const set of sets) {
    for (const role of [
      'requester-submission', 'admission', 'requester-discovery', 'solver-delivery',
      'solver-settlement', 'solver-discovery', 'evaluator-verdict',
      'evaluator-settlement', 'evaluator-discovery',
    ] as const) {
      try { result[role] = set.get(role).keyId; } catch { /* role is not owned by this scoped set */ }
    }
  }
  return result;
}

async function buildRequesterHost(input: {
  readonly config: NativeProductConfig;
  readonly infrastructure: NativeInfrastructurePrimitives;
  readonly trust: NativeTrustAuthority;
  readonly password: string;
  readonly lease: ReturnType<typeof createInProcessRoleLease>;
}): Promise<NativeOperatorHost & { readonly requester: ReturnType<typeof createNativeRequester> }> {
  const scope = new NativeConstructionScope();
  try {
  const config = input.config.operator.native;
  const requesterPath = config.identityStores.requester;
  const admissionPath = config.identityStores.admission;
  if (requesterPath === undefined || admissionPath === undefined || config.admissionAgent === undefined) {
    throw new NativeProductionDeploymentError('requester/admission scoped custody is incomplete');
  }
  const [requesterRoles, admissionRoles] = await Promise.all([
    openRoles({
      agent: config.agent,
      roles: ['requester-submission', 'requester-discovery'],
      storePath: requesterPath,
      password: input.password,
      trust: input.trust,
    }),
    openRoles({
      agent: config.admissionAgent,
      roles: ['admission'],
      storePath: admissionPath,
      password: input.password,
      trust: input.trust,
    }),
  ]);
  const requesterRolePort: NativeRequesterRoles = {
    get(role) {
      return role === 'admission' ? admissionRoles.get(role) : requesterRoles.get(role);
    },
  };
  if (input.infrastructure.requester === undefined) {
    throw new NativeProductionDeploymentError('first-party requester read primitives are unavailable');
  }
  const writeSession = await input.infrastructure.activateWrites({
    role: 'requester',
    password: input.password,
    expectedOwnerAddress: config.evmCustody.expectedOwnerAddress as `0x${string}`,
    accountIndex: config.evmCustody.accountIndex,
  });
  scope.defer(writeSession.close);
  if (writeSession.writes.role !== 'requester') {
    await writeSession.close();
    throw new NativeProductionDeploymentError('requester write activation returned another role');
  }
  const writes = writeSession.writes as NativeRequesterWritePrimitives;
  const requester = createNativeRequester({
    stateDir: join(config.stateDir, 'requester'),
    requesterAgent: config.agent,
    admissionAgent: config.admissionAgent,
    publicBaseUrl: config.publicBaseUrl,
    readChain: async () => chain(config),
    authorityTime: input.infrastructure.authorityTime.latestFinalized,
    loadRoles: async () => requesterRolePort,
    creatorSafe: config.safeAddress as `0x${string}`,
    posting: {
      ...createNativeRequesterPostTask({ terms: writes.postingTerms, backend: writes.requesterBackend }),
      recover: input.infrastructure.requester.recoverPosting,
      canonicalTaskCreated: input.infrastructure.requester.canonicalTaskCreated,
    },
    now: () => new Date(),
  });
  const endpoint = await input.infrastructure.mountPublicSource(requester.handleDiscoveryRequest);
  scope.defer(endpoint.close);
  const host = createNativeOperatorHost({
    role: 'requester',
    roleKeyIds: roleKeyIds(requesterRoles, admissionRoles),
    lease: input.lease,
    bindings: {
      async verify() {
        await input.trust.assertFresh();
        for (const [set, roles] of [
          [requesterRoles, ['requester-submission', 'requester-discovery']],
          [admissionRoles, ['admission']],
        ] as const) {
          for (const role of roles) {
            const result = await set.resolveEffective(role, new Date().toISOString());
            if (!result.ok) throw new NativeProductionDeploymentError(`native ${role} authority is not effective: ${result.reason}`);
          }
        }
      },
    },
    venue: {
      rollbackToFinalized: async () => { await writeSession.venue.rawLogSource.poll(); },
      health: writeSession.venue.health,
      close: async () => {
        await writeSession.close();
        await input.infrastructure.close();
      },
    },
    operations: {
      reconcileTransactions: async () => { await requester.reconcile(); },
      reconcilePublications: async () => undefined,
      uncertainCount: () => 0,
    },
    discovery: { sync: async () => ({ lag: 0, bySource: {} }) },
    recovery: { recoverBackends: async () => undefined },
    readiness: {
      backendRequired: false,
      evidenceRequired: false,
      backend: async () => true,
      evidence: async () => true,
      publicSource: endpoint.ready,
    },
    work: { start: async () => undefined, stop: endpoint.close },
  });
  scope.release();
  return Object.assign(host, { requester });
  } catch (cause) {
    return scope.unwind(cause);
  }
}

interface DeferredProductionHost extends NativeOperatorHost {
  readonly infrastructure: NativeInfrastructurePrimitives;
}

async function buildRoleHost(input: {
  readonly config: NativeProductConfig;
  readonly infrastructure: NativeInfrastructurePrimitives;
  readonly trust: NativeTrustAuthority;
  readonly password: string;
  readonly lease: ReturnType<typeof createInProcessRoleLease>;
}): Promise<NativeOperatorHost> {
  switch (input.config.operator.native.role) {
    case 'requester': return buildRequesterHost(input);
    case 'solver': return buildSolverHost(input);
    case 'evaluator': return buildEvaluatorHost(input);
  }
}

/** Native product graph root. Infrastructure is read-only-preflighted before any role or wallet. */
export async function createNativeProductionOperatorHost(
  input: NativeDeploymentFactoryInput,
): Promise<DeferredProductionHost> {
  const infrastructure = await openInfrastructure(input.config);
  try {
    assertNativeTargetInspection(input.config.operator.native, await infrastructure.inspectTarget());
  } catch (cause) {
    await infrastructure.close().catch(() => undefined);
    throw cause;
  }
  const config = input.config.operator.native;
  const lease = createInProcessRoleLease();
  let host: NativeOperatorHost | undefined;
  let closed = false;
  return {
    infrastructure,
    async start() {
      if (closed) throw new NativeProductionDeploymentError('native production host is closed');
      if (host !== undefined) return;
      await lease.acquire();
      try {
        const password = process.env.JINN_PASSWORD;
        if (password === undefined || password.length === 0) {
          throw new NativeProductionDeploymentError('JINN_PASSWORD is required after read-only preflight');
        }
        const trust = await openNativeTrustCatalog({
          path: config.trustRootsPath,
          expectedPolicyGenesisDigest: config.trustPolicyGenesisDigest as `sha256:${string}`,
          anchorClient: infrastructure.anchorClient,
          settlementOwnershipClient: infrastructure.settlementOwnership,
        });
        host = await buildRoleHost({ config: input.config, infrastructure, trust, password, lease });
        await host.start();
      } catch (cause) {
        await host?.close().catch(() => undefined);
        if (host === undefined) {
          await lease.release().catch(() => undefined);
          await infrastructure.close().catch(() => undefined);
        }
        throw cause;
      }
    },
    async health() {
      if (host === undefined) throw new NativeProductionDeploymentError('native production host has not started');
      return host.health();
    },
    async close() {
      if (closed) return;
      closed = true;
      if (host !== undefined) await host.close();
      else {
        await lease.release().catch(() => undefined);
        await infrastructure.close();
      }
    },
  };
}

export async function preflightNativeRequesterCommand(input: {
  readonly network: 'base-sepolia';
  readonly fixture: 'prediction-forecast-golden.json';
  readonly runId: string;
}): Promise<{
  readonly chainId: 84532;
  readonly contractsVerified: true;
  readonly contractCodeVerified: true;
  readonly fundingVerified: true;
  readonly transactionCapsVerified: true;
}> {
  void input;
  const config = loadProductionConfig();
  if (config.operator.native.role !== 'requester') {
    throw new NativeProductionDeploymentError('native requester command requires requester role configuration');
  }
  const infrastructure = await openInfrastructure(config);
  try {
    assertNativeTargetInspection(config.operator.native, await infrastructure.inspectTarget());
    return {
      chainId: 84532,
      contractsVerified: true,
      contractCodeVerified: true,
      fundingVerified: true,
      transactionCapsVerified: true,
    };
  } finally {
    await infrastructure.close();
  }
}

export async function loadNativeRequesterCommandExecutor(input: { readonly password: string }): Promise<{
  request(request: {
    readonly network: 'base-sepolia';
    readonly fixture: 'prediction-forecast-golden.json';
    readonly runId: string;
  }): Promise<{
    readonly taskDigest: `sha256:${string}`;
    readonly submissionDigest: `sha256:${string}`;
    readonly taskId: string;
    readonly transactionHash: `0x${string}`;
    readonly sourceSequence: string;
    readonly sourceEntryDigest: `sha256:${string}`;
  }>;
  close(): Promise<void>;
}> {
  const scope = new NativeConstructionScope();
  try {
  const config = loadProductionConfig();
  if (config.operator.native.role !== 'requester') {
    throw new NativeProductionDeploymentError('native requester execution requires requester role configuration');
  }
  const infrastructure = await openInfrastructure(config);
  scope.defer(infrastructure.close);
  assertNativeTargetInspection(config.operator.native, await infrastructure.inspectTarget());
  const native = config.operator.native;
  const lease = createInProcessRoleLease();
  await lease.acquire();
  scope.defer(lease.release);
  const trust = await openNativeTrustCatalog({
    path: native.trustRootsPath,
    expectedPolicyGenesisDigest: native.trustPolicyGenesisDigest as `sha256:${string}`,
    anchorClient: infrastructure.anchorClient,
    settlementOwnershipClient: infrastructure.settlementOwnership,
  });
  const host = await buildRequesterHost({ config, infrastructure, trust, password: input.password, lease });
  scope.defer(host.close);
  await host.start();
  scope.release();
  return {
    close: () => host.close(),
    async request(request) {
      const result = await host.requester.request(request);
      const association = result.association;
      return {
        taskDigest: association.taskDigest,
        submissionDigest: association.submissionDigest,
        taskId: association.taskId.toString(10),
        transactionHash: association.txHash,
        sourceSequence: association.publication.sequence,
        sourceEntryDigest: association.publication.entryDigest,
      };
    },
  };
  } catch (cause) {
    return scope.unwind(cause);
  }
}

async function buildSolverHost(input: Parameters<typeof buildRequesterHost>[0]): Promise<NativeOperatorHost> {
  const path = input.config.operator.native.identityStores.solver;
  if (path === undefined) throw new NativeProductionDeploymentError('solver scoped custody is missing');
  const roles = await openRoles({
    agent: input.config.operator.native.agent,
    roles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
    storePath: path,
    password: input.password,
    trust: input.trust,
  });
  return buildNativeSolverProductionHost({ ...input, roles });
}

async function buildEvaluatorHost(input: Parameters<typeof buildRequesterHost>[0]): Promise<NativeOperatorHost> {
  const path = input.config.operator.native.identityStores.evaluator;
  if (path === undefined) throw new NativeProductionDeploymentError('evaluator scoped custody is missing');
  const roles = await openRoles({
    agent: input.config.operator.native.agent,
    roles: ['evaluator-verdict', 'evaluator-settlement', 'evaluator-discovery'],
    storePath: path,
    password: input.password,
    trust: input.trust,
  });
  return buildNativeEvaluatorProductionHost({ ...input, roles });
}
