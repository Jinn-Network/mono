/**
 * Two-operator native-config fixtures for the native e2e rig (one-swap M7, umbrella #2461).
 *
 * Produces the `JinnConfig`-shaped native sections `buildFleetNativeRuntime` + the main.ts native
 * assembly read, for TWO honestly-separate operators:
 *   - operator A: requester + solver + admission custody (posts, solves, adopts). The G-loop
 *     "requester" and "adopter".
 *   - operator B: solver only (discovers A's task, claims, delivers). The G-loop "second operator".
 * Distinct agent IRIs, distinct identity stores, distinct public base URLs. One SHARED trust
 * catalog binds both operators' keys (a catalog is keyed by agent, so one file legitimately carries
 * both) — this is what lets B verify A's requester source and A adopt B's delivery.
 *
 * The config objects are cast to `JinnConfig` (the same posture the native-fleet unit tests take):
 * the native builders read only the native sections, so a fully-validated `loadConfig` round-trip is
 * unnecessary and would drag in every unrelated legacy default.
 */
import { join } from 'node:path';
import type { JinnConfig } from '../../../../src/config.js';
import type { NativeRoleIdentityRole } from '../../../../src/daemon/role-identities.js';
import { mintIdentityStore, type MintedIdentityStore } from './identity.js';
import {
  authorNativeTrustCatalog,
  type AnchorSubmitter,
  type CeremonyAccount,
  type OwnedRoleKey,
} from './trust-catalog.js';
import { writeLaunchedRecordFixture, type LaunchedRecordFixture } from './launched-record.js';

const FLEET_SOLVER_ROLES: readonly NativeRoleIdentityRole[] = ['solver-delivery', 'solver-settlement', 'solver-discovery'];
const FLEET_REQUESTER_ROLES: readonly NativeRoleIdentityRole[] = ['requester-submission', 'requester-discovery'];

export interface NativeOperatorFixture {
  readonly label: 'A' | 'B';
  readonly agentIri: string;
  readonly admissionAgent?: string;
  readonly publicBaseUrl: string;
  readonly solverStore: MintedIdentityStore;
  readonly requesterStore?: MintedIdentityStore;
  readonly admissionStore?: MintedIdentityStore;
  readonly launched?: LaunchedRecordFixture;
  /** A `JinnConfig`-cast object carrying this operator's native sections. */
  readonly config: JinnConfig;
}

export interface TwoOperatorNativeSetup {
  readonly operatorA: NativeOperatorFixture;
  readonly operatorB: NativeOperatorFixture;
  readonly trustRootsPath: string;
  readonly trustPolicyGenesisDigest: `sha256:${string}`;
  /** The effective time every binding is minted at; pass as `now` to the native trust/identity openers. */
  readonly bootTime: string;
}

function nativeConfig(input: {
  readonly rpcUrl: string;
  readonly agentIri: string;
  readonly admissionAgent?: string;
  readonly identityStores: Record<string, string>;
  readonly trustRootsPath: string;
  readonly trustPolicyGenesisDigest: `sha256:${string}`;
  readonly ipfsApiUrl: string;
  readonly publicBaseUrl: string;
  readonly recordSources: readonly { role: string; agent: string; name: string; baseUrl: string }[];
  readonly posting: readonly unknown[];
  readonly earningDir: string;
  readonly dbPath: string;
}): JinnConfig {
  return {
    network: 'testnet',
    rpcUrl: input.rpcUrl,
    configShapeVersion: 2,
    compositionMode: 'native',
    agentIri: input.agentIri,
    ...(input.admissionAgent === undefined ? {} : { admissionAgent: input.admissionAgent }),
    identityStores: input.identityStores,
    trustRootsPath: input.trustRootsPath,
    trustPolicyGenesisDigest: input.trustPolicyGenesisDigest,
    ipfs: { apiUrl: input.ipfsApiUrl },
    publicBaseUrl: input.publicBaseUrl,
    recordSources: input.recordSources,
    posting: input.posting,
    finality: { confirmations: 1 },
    publicArchive: { enabled: false, host: '127.0.0.1', port: 7332 },
    claimPolicy: { mode: 'match-legacy-manifest-digest', spendCapWei: '1000000000000000000', aiUnitCap: 1000 },
    pollIntervalMs: 300,
    earningDir: input.earningDir,
    dbPath: input.dbPath,
    tasks: [],
    peers: [],
  } as unknown as JinnConfig;
}

/**
 * Mints identity stores for two operators, authors one shared trust catalog binding both, writes a
 * launched-SolverNet record for operator A, and returns both operators' native config sections plus
 * a matching `posting[]` entry on A.
 *
 * `submitAnchor` is threaded to `authorNativeTrustCatalog`: pass the fork rig's real finalized
 * calldata submitter to get a catalog the production anchor client accepts; omit it (unit) to get a
 * catalog whose `mockAnchorClient` the caller must use.
 */
export async function buildTwoOperatorNativeSetup(input: {
  readonly rootDir: string;
  readonly password: string;
  readonly rpcUrl: string;
  readonly ipfsApiUrl: string;
  readonly ceremonyAccount: CeremonyAccount;
  readonly submitAnchor?: AnchorSubmitter;
  readonly aPublicBaseUrl: string;
  readonly bPublicBaseUrl: string;
  /**
   * A's service Safe: the launched-record launcher Safe, the posting creator Safe, AND the §2.3b
   * settlement authority declared as the third ceremony resource. It is a CONTRACT account — never
   * the ceremony EOA. The rig un-conflation (spec §2.4) is exactly this: before the amendment the
   * caller passed `ceremonyAccount.address` here, which is the only reason the old address-equality
   * `verifyOnchainAuthority` ever passed.
   */
  readonly aSafeAddress: `0x${string}`;
  readonly workKind?: string;
}): Promise<TwoOperatorNativeSetup & { readonly mockAnchorClientTrust?: import('./trust-catalog.js').AuthoredTrustCatalog }> {
  const workKind = input.workKind ?? 'prediction.v1';
  const agentA = 'urn:jinn:operator:fleet-e2e-a';
  const admissionAgentA = 'urn:jinn:admission:fleet-e2e-a';
  const agentB = 'urn:jinn:operator:fleet-e2e-b';

  const aDir = join(input.rootDir, 'operator-a');
  const bDir = join(input.rootDir, 'operator-b');

  const aSolver = await mintIdentityStore({ storePath: join(aDir, 'identity', 'solver.enc.json'), password: input.password, roles: FLEET_SOLVER_ROLES });
  const aRequester = await mintIdentityStore({ storePath: join(aDir, 'identity', 'requester.enc.json'), password: input.password, roles: FLEET_REQUESTER_ROLES });
  const aAdmission = await mintIdentityStore({ storePath: join(aDir, 'identity', 'admission.enc.json'), password: input.password, roles: ['admission'] });
  const bSolver = await mintIdentityStore({ storePath: join(bDir, 'identity', 'solver.enc.json'), password: input.password, roles: FLEET_SOLVER_ROLES });
  // B is solver-only but the runtime always opens the requester role family (the projector's
  // requester-association resolver needs `requester-submission`). So B gets its own distinct
  // requester store — it just never provisions admission custody, so its posting `post` stays the
  // M5d fail-closed seam.
  const bRequester = await mintIdentityStore({ storePath: join(bDir, 'identity', 'requester.enc.json'), password: input.password, roles: FLEET_REQUESTER_ROLES });

  const trustRootsPath = join(input.rootDir, 'trust.json');
  const roleKeys: OwnedRoleKey[] = [
    ...aSolver.keys.map((key) => ({ key, agent: agentA })),
    ...aRequester.keys.map((key) => ({ key, agent: agentA })),
    { key: aAdmission.key('admission'), agent: admissionAgentA },
    ...bSolver.keys.map((key) => ({ key, agent: agentB })),
    ...bRequester.keys.map((key) => ({ key, agent: agentB })),
  ];
  const catalog = await authorNativeTrustCatalog({
    path: trustRootsPath,
    roleKeys,
    ceremonyAccount: input.ceremonyAccount,
    settlementSafe: input.aSafeAddress,
    ...(input.submitAnchor === undefined ? {} : { submitAnchor: input.submitAnchor }),
  });

  const launched = await writeLaunchedRecordFixture({
    path: join(aDir, 'solvernets', 'launched', 'native-e2e-solvernet.json'),
    workKind,
    launcherSafeAddress: input.aSafeAddress,
    launcherAgentId: agentA,
  });

  // A's requester source is what B discovers from; A's config references its own source so its
  // discovery consumer (the solver leg) can also read it if configured. Exactly one `requester`
  // record source per operator (native-fleet-discovery refuses != 1).
  const aRequesterSource = { role: 'requester', agent: agentA, name: 'requester', baseUrl: input.aPublicBaseUrl };

  const operatorA: NativeOperatorFixture = {
    label: 'A',
    agentIri: agentA,
    admissionAgent: admissionAgentA,
    publicBaseUrl: input.aPublicBaseUrl,
    solverStore: aSolver,
    requesterStore: aRequester,
    admissionStore: aAdmission,
    launched,
    config: nativeConfig({
      rpcUrl: input.rpcUrl,
      agentIri: agentA,
      admissionAgent: admissionAgentA,
      identityStores: { solver: aSolver.storePath, requester: aRequester.storePath, admission: aAdmission.storePath },
      trustRootsPath,
      trustPolicyGenesisDigest: catalog.policyGenesisDigest,
      ipfsApiUrl: input.ipfsApiUrl,
      publicBaseUrl: input.aPublicBaseUrl,
      recordSources: [aRequesterSource],
      posting: [launched.postingEntry],
      earningDir: join(aDir, 'earning'),
      dbPath: join(aDir, 'jinn.db'),
    }),
  };

  const operatorB: NativeOperatorFixture = {
    label: 'B',
    agentIri: agentB,
    publicBaseUrl: input.bPublicBaseUrl,
    solverStore: bSolver,
    config: nativeConfig({
      rpcUrl: input.rpcUrl,
      agentIri: agentB,
      identityStores: { solver: bSolver.storePath, requester: bRequester.storePath },
      trustRootsPath,
      trustPolicyGenesisDigest: catalog.policyGenesisDigest,
      ipfsApiUrl: input.ipfsApiUrl,
      publicBaseUrl: input.bPublicBaseUrl,
      // B discovers A's requester source (the cross-operator link the G-loop needs).
      recordSources: [aRequesterSource],
      posting: [],
      earningDir: join(bDir, 'earning'),
      dbPath: join(bDir, 'jinn.db'),
    }),
  };

  return {
    operatorA,
    operatorB,
    trustRootsPath,
    trustPolicyGenesisDigest: catalog.policyGenesisDigest,
    bootTime: catalog.bootTime,
    ...(catalog.mockAnchorClient === undefined ? {} : { mockAnchorClientTrust: catalog }),
  };
}
