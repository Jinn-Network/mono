import { ethers as ethersLib, JsonRpcProvider, type JsonRpcSigner } from 'ethers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRunEntry } from './lib/run-entry.js';

type Env = Record<string, string | undefined>;
type UnknownRecord = Record<string, unknown>;

export const DEFAULT_SERVICE_ID = 46n;
export const DEFAULT_CURRENT_PROXY = '0x24e34E5037956a5Feca1AAAfaA30297084C228B8';
export const DEFAULT_FRESH_PROXY = '0x3A14c71e94F3d38A6BE4319808B259FbFb47B86f';
export const DEFAULT_DISTRIBUTOR = '0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81';
export const DEFAULT_SERVICE_REGISTRY = '0x31D3202d8744B16A120117A053459DDFAE93c855';
export const DEFAULT_SERVICE_REGISTRY_TOKEN_UTILITY = '0xeB49bE5DF00F74bd240DE4535DDe6Bc89CEfb994';
export const DEFAULT_RECOVERY_MODULE = '0x5E3327C73834502f14e93e6b7D74742De1f9F3FD';
export const DEFAULT_REGISTRY_OWNER = '0xeDd71796B90eaCc56B074C39BAC90ED2Ca6D93Ee';
export const DEFAULT_MASTER = '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF';
export const DEFAULT_AGENT_INSTANCE = '0x63192d38350b796856cF002caC25c377D9A0DB5A';
export const OPERATOR_SAFE = '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC';
export const DEFAULT_AGENT_ID = 103n;

const BASE_SEPOLIA_CHAIN_ID = 84532n;
const UNAUTHORIZED_MULTISIG_SELECTOR = '0x14460f20';
const STOLAS_ARTIFACT = 'deployment-stolas-l2-baseSepolia-fast.json';
const PHASE1A_ARTIFACT = 'deployment-phase1a-l2-baseSepolia-fast.json';
const FUNDED_BALANCE = ethersLib.parseEther('10');
const TX_GAS_LIMIT = 8_000_000n;

const SERVICE_REGISTRY_ABI = [
  'function owner() view returns (address)',
  'function mapMultisigs(address multisig) view returns (bool)',
  'function changeMultisigPermission(address multisig, bool permission) external',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getService(uint256 serviceId) view returns (tuple(uint96 securityDeposit,address multisig,bytes32 configHash,uint32 threshold,uint32 maxNumAgentInstances,uint32 numAgentInstances,uint8 state,uint32[] agentIds) service)',
];

const DISTRIBUTOR_ABI = [
  'function stake(address stakingProxy, uint256 serviceId, uint256 agentId, bytes32 configHash, address agentInstance) external',
  'function unstakeAndWithdraw(address stakingProxy, uint256 serviceId, bytes32 operation) external',
  'function mapServiceIdCuratingAgents(uint256 serviceId) view returns (address)',
];

const STAKING_ABI = [
  'function getStakingState(uint256 serviceId) view returns (uint8)',
  'function getServiceIds() view returns (uint256[])',
];

export interface MigrationConfig {
  serviceId: bigint;
  currentProxy: string;
  freshProxy: string;
  distributor: string;
  serviceRegistry: string;
  serviceRegistryTokenUtility: string;
  recoveryModule: string;
  registryOwner: string;
  master: string;
  agentInstance: string;
  agentId: bigint;
  evidencePath: string;
  expectedConfigHash?: string;
}

export interface ResolveMigrationConfigOptions {
  env: Env;
  cwd: string;
}

export interface FinalStateSnapshot {
  currentStakingState: bigint;
  freshStakingState: bigint;
  ownerOfService: string;
  freshServiceIds: bigint[];
  serviceMultisig: string;
  serviceConfigHash: string;
  serviceAgentIds: bigint[];
}

export interface FinalStateExpectation {
  serviceId: bigint;
  freshProxy: string;
  expectedConfigHash?: string;
  expectedMultisig?: string;
  expectedAgentId?: bigint;
}

interface ServiceSnapshot {
  multisig: string;
  configHash: string;
  agentIds: bigint[];
}

export function padAddressToBytes32(address: string): string {
  const checksummed = ethersLib.getAddress(address);
  return `0x${'0'.repeat(24)}${checksummed.slice(2)}`;
}

export function resolveMigrationConfig({ env, cwd }: ResolveMigrationConfigOptions): MigrationConfig {
  const stolasArtifact = readDeploymentArtifact(cwd, STOLAS_ARTIFACT);
  const phase1aArtifact = readDeploymentArtifact(cwd, PHASE1A_ARTIFACT);
  const stolasContracts = asRecord(stolasArtifact?.contracts);
  const stolasConfig = asRecord(stolasArtifact?.config);
  const phase1aContracts = asRecord(phase1aArtifact?.contracts);

  const evidencePath =
    env.MIGRATION_EVIDENCE_PATH?.trim() ||
    path.resolve(cwd, '..', '.local', 'stolas-service46-fresh-proxy-rehearsal.json');

  const agentId =
    bigintFromEnv(env, 'MIGRATION_AGENT_ID') ??
    bigintFromUnknown(stolasConfig.agentId) ??
    DEFAULT_AGENT_ID;

  const expectedConfigHash = env.MIGRATION_EXPECTED_CONFIG_HASH?.trim();

  return {
    serviceId: bigintFromEnv(env, 'MIGRATION_SERVICE_ID') ?? DEFAULT_SERVICE_ID,
    currentProxy: addressFromEnv(env, 'MIGRATION_CURRENT_PROXY', DEFAULT_CURRENT_PROXY),
    freshProxy: addressFromEnv(env, 'MIGRATION_FRESH_PROXY', DEFAULT_FRESH_PROXY),
    distributor: addressFromEnv(
      env,
      'MIGRATION_DISTRIBUTOR',
      stringField(stolasContracts, 'distributor') ?? DEFAULT_DISTRIBUTOR,
    ),
    serviceRegistry: addressFromEnv(
      env,
      'MIGRATION_SERVICE_REGISTRY',
      stringField(phase1aContracts, 'serviceRegistry') ?? DEFAULT_SERVICE_REGISTRY,
    ),
    serviceRegistryTokenUtility: addressFromEnv(
      env,
      'MIGRATION_SERVICE_REGISTRY_TOKEN_UTILITY',
      stringField(phase1aContracts, 'serviceRegistryTokenUtility') ?? DEFAULT_SERVICE_REGISTRY_TOKEN_UTILITY,
    ),
    recoveryModule: addressFromEnv(
      env,
      'MIGRATION_RECOVERY_MODULE',
      stringField(stolasContracts, 'recoveryModule') ?? DEFAULT_RECOVERY_MODULE,
    ),
    registryOwner: addressFromEnv(env, 'MIGRATION_REGISTRY_OWNER', DEFAULT_REGISTRY_OWNER),
    master: addressFromEnv(env, 'MIGRATION_MASTER', DEFAULT_MASTER),
    agentInstance: addressFromEnv(env, 'MIGRATION_AGENT_INSTANCE', DEFAULT_AGENT_INSTANCE),
    agentId,
    evidencePath: path.resolve(cwd, evidencePath),
    expectedConfigHash: expectedConfigHash ? normalizeBytes32(expectedConfigHash, 'MIGRATION_EXPECTED_CONFIG_HASH') : undefined,
  };
}

export function assertAnvilForkNodeInfo(nodeInfo: unknown): string {
  const info = asRecord(nodeInfo);
  const forkConfigSnake = asRecord(info.fork_config);
  const forkConfigCamel = asRecord(info.forkConfig);
  const forkUrl =
    stringField(forkConfigSnake, 'fork_url') ??
    stringField(forkConfigCamel, 'forkUrl') ??
    stringField(info, 'fork_url') ??
    stringField(info, 'forkUrl');

  if (!forkUrl) {
    throw new Error(
      'Anvil fork node info did not include a fork URL. Start an Anvil fork of Base Sepolia and run with --network localhost.',
    );
  }

  // Belt-and-suspenders alongside the chainId guard: ensure the fork is of Base
  // Sepolia, not a mainnet fork pinned to --chain-id 84532. A wrong fork would
  // produce evidence that looks valid but proves nothing about Base Sepolia.
  if (!forkUrl.toLowerCase().includes('sepolia')) {
    throw new Error(
      `Fork URL "${forkUrl}" does not look like a Base Sepolia RPC (expected to contain ` +
        `"sepolia"). Refusing to run the migration rehearsal against a non-Sepolia fork.`,
    );
  }

  return forkUrl;
}

export function verifyFinalState(snapshot: FinalStateSnapshot, expectation: FinalStateExpectation): void {
  if (snapshot.currentStakingState !== 0n) {
    throw new Error(
      `current staking proxy still reports service ${expectation.serviceId} state ${snapshot.currentStakingState}; expected 0`,
    );
  }

  if (snapshot.freshStakingState !== 1n) {
    throw new Error(
      `fresh staking proxy reports service ${expectation.serviceId} state ${snapshot.freshStakingState}; expected 1`,
    );
  }

  if (ethersLib.getAddress(snapshot.ownerOfService) !== ethersLib.getAddress(expectation.freshProxy)) {
    throw new Error(
      `ownerOf(${expectation.serviceId}) is ${snapshot.ownerOfService}; expected ${expectation.freshProxy}`,
    );
  }

  if (!snapshot.freshServiceIds.some((serviceId) => serviceId === expectation.serviceId)) {
    throw new Error(`fresh staking proxy does not list service ${expectation.serviceId}`);
  }

  if (
    expectation.expectedConfigHash &&
    normalizeBytes32(snapshot.serviceConfigHash, 'service config hash') !==
      normalizeBytes32(expectation.expectedConfigHash, 'expected config hash')
  ) {
    throw new Error(
      `service config hash is ${snapshot.serviceConfigHash}; expected ${expectation.expectedConfigHash}`,
    );
  }

  if (
    expectation.expectedMultisig &&
    ethersLib.getAddress(snapshot.serviceMultisig) !== ethersLib.getAddress(expectation.expectedMultisig)
  ) {
    throw new Error(
      `service multisig is ${snapshot.serviceMultisig}; expected ${expectation.expectedMultisig}`,
    );
  }

  if (
    expectation.expectedAgentId !== undefined &&
    !snapshot.serviceAgentIds.some((agentId) => agentId === expectation.expectedAgentId)
  ) {
    throw new Error(`service agent IDs ${snapshot.serviceAgentIds.join(', ')} do not include ${expectation.expectedAgentId}`);
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.MIGRATION_RPC_URL ?? process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
  const provider = new JsonRpcProvider(rpcUrl);
  const config = resolveMigrationConfig({ env: process.env, cwd: process.cwd() });

  const net = await provider.getNetwork();
  if (net.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Expected Base Sepolia fork chainId ${BASE_SEPOLIA_CHAIN_ID}; got ${net.chainId}. ` +
        'Run Anvil with --chain-id 84532 and point LOCAL_RPC_URL at that fork.',
    );
  }

  const forkUrl = await getAnvilForkUrl(provider);
  const registry: any = new ethersLib.Contract(config.serviceRegistry, SERVICE_REGISTRY_ABI, provider);
  const distributor: any = new ethersLib.Contract(config.distributor, DISTRIBUTOR_ABI, provider);
  const currentStaking: any = new ethersLib.Contract(config.currentProxy, STAKING_ABI, provider);
  const freshStaking: any = new ethersLib.Contract(config.freshProxy, STAKING_ABI, provider);

  const registryOwner = ethersLib.getAddress(await registry.owner());
  if (registryOwner !== config.registryOwner) {
    throw new Error(`ServiceRegistry owner is ${registryOwner}; expected configured owner ${config.registryOwner}`);
  }

  const initial = await readInitialState(registry, currentStaking, freshStaking, config);
  const serviceConfigHash = config.expectedConfigHash ?? initial.service.configHash;
  const agentId = initial.service.agentIds[0] ?? config.agentId;

  assertInitialState(initial, config);

  console.log('=== stOLAS service 46 fresh-proxy migration rehearsal ===');
  console.log(`mode              : anvil-fork`);
  console.log(`fork URL          : ${forkUrl}`);
  console.log(`serviceId         : ${config.serviceId}`);
  console.log(`current proxy     : ${config.currentProxy}`);
  console.log(`fresh proxy       : ${config.freshProxy}`);
  console.log(`distributor       : ${config.distributor}`);
  console.log(`recovery module   : ${config.recoveryModule}`);
  console.log(`registry owner    : ${config.registryOwner}`);
  console.log(`master            : ${config.master}`);
  console.log(`agent instance    : ${config.agentInstance}`);
  console.log(`agentId           : ${agentId}`);
  console.log(`configHash        : ${serviceConfigHash}`);
  console.log('');

  const preAuthSnapshot = await provider.send('evm_snapshot', []);
  let preAuthUnstakeTx: string | undefined;
  try {
    const masterSigner = await impersonateAccount(provider, config.master);
    preAuthUnstakeTx = await unstakeAndWithdraw(distributor, masterSigner, config);
    await expectStakeUnauthorizedMultisig(distributor, masterSigner, config, agentId, serviceConfigHash);
  } finally {
    await stopImpersonating(provider, config.master);
    await provider.send('evm_revert', [preAuthSnapshot]);
  }

  console.log(`pre-auth unstake tx: ${preAuthUnstakeTx}`);
  console.log(`pre-auth stake     : reverted with ${UNAUTHORIZED_MULTISIG_SELECTOR} (UnauthorizedMultisig)`);
  console.log('');

  const ownerSigner = await impersonateAccount(provider, config.registryOwner);
  const authorizeTx = await registry.connect(ownerSigner).changeMultisigPermission(
    config.recoveryModule,
    true,
    { gasLimit: 500_000n },
  );
  const authorizeReceipt = await waitForSuccess(authorizeTx, 'changeMultisigPermission');
  await stopImpersonating(provider, config.registryOwner);

  const recoveryAuthorized = await registry.mapMultisigs(config.recoveryModule);
  if (!recoveryAuthorized) {
    throw new Error(`Recovery module ${config.recoveryModule} was not authorized after changeMultisigPermission`);
  }

  const masterSigner = await impersonateAccount(provider, config.master);
  const unstakeTx = await unstakeAndWithdraw(distributor, masterSigner, config);
  const stakeTx = await stakeOnFreshProxy(distributor, masterSigner, config, agentId, serviceConfigHash);
  await stopImpersonating(provider, config.master);

  const finalState = await readFinalState(registry, currentStaking, freshStaking, config);
  verifyFinalState(finalState, {
    serviceId: config.serviceId,
    freshProxy: config.freshProxy,
    expectedConfigHash: serviceConfigHash,
    expectedMultisig: initial.service.multisig,
    expectedAgentId: agentId,
  });

  const evidence = {
    generatedAt: new Date().toISOString(),
    mode: 'anvil-fork',
    chainId: net.chainId,
    forkUrl,
    serviceId: config.serviceId,
    currentProxy: config.currentProxy,
    freshProxy: config.freshProxy,
    distributor: config.distributor,
    serviceRegistry: config.serviceRegistry,
    serviceRegistryTokenUtility: config.serviceRegistryTokenUtility,
    recoveryModule: config.recoveryModule,
    registryOwner: config.registryOwner,
    master: config.master,
    agentInstance: config.agentInstance,
    preAuthorization: {
      recoveryAuthorized: initial.recoveryAuthorized,
      unstakeTx: preAuthUnstakeTx,
      expectedRevertSelector: UNAUTHORIZED_MULTISIG_SELECTOR,
      stakeRevertMatched: true,
    },
    authorization: {
      txHash: authorizeTx.hash,
      blockNumber: authorizeReceipt.blockNumber,
      recoveryAuthorized,
    },
    migration: {
      unstakeTx,
      stakeTx,
    },
    final: finalState,
    next:
      'Live execution remains out of scope for this script. A live slice needs the registry owner key funded for gas before changing ServiceRegistry multisig permissions.',
  };

  writeEvidence(config.evidencePath, evidence);

  console.log('migration unstake tx:', unstakeTx);
  console.log('migration stake tx  :', stakeTx);
  console.log('evidence path       :', config.evidencePath);
  console.log('');
  console.log(JSON.stringify(evidence, stringifyBigInts, 2));
}

async function readInitialState(
  registry: any,
  currentStaking: any,
  freshStaking: any,
  config: MigrationConfig,
): Promise<{
  currentStakingState: bigint;
  freshStakingState: bigint;
  ownerOfService: string;
  service: ServiceSnapshot;
  recoveryAuthorized: boolean;
}> {
  const [currentStakingState, freshStakingState, ownerOfService, service, recoveryAuthorized] = await Promise.all([
    currentStaking.getStakingState(config.serviceId),
    freshStaking.getStakingState(config.serviceId),
    registry.ownerOf(config.serviceId),
    registry.getService(config.serviceId),
    registry.mapMultisigs(config.recoveryModule),
  ]);

  return {
    currentStakingState: BigInt(currentStakingState),
    freshStakingState: BigInt(freshStakingState),
    ownerOfService: ethersLib.getAddress(ownerOfService),
    service: serviceFromResult(service),
    recoveryAuthorized: Boolean(recoveryAuthorized),
  };
}

function assertInitialState(
  initial: {
    currentStakingState: bigint;
    freshStakingState: bigint;
    ownerOfService: string;
    recoveryAuthorized: boolean;
  },
  config: MigrationConfig,
): void {
  if (initial.currentStakingState !== 2n) {
    throw new Error(
      `Expected service ${config.serviceId} to be evicted in the current proxy (state 2); got ${initial.currentStakingState}`,
    );
  }

  if (initial.freshStakingState !== 0n) {
    throw new Error(
      `Expected service ${config.serviceId} to be absent from the fresh proxy (state 0); got ${initial.freshStakingState}`,
    );
  }

  if (initial.ownerOfService !== config.currentProxy) {
    throw new Error(`Expected ownerOf(${config.serviceId}) to be ${config.currentProxy}; got ${initial.ownerOfService}`);
  }

  if (initial.recoveryAuthorized) {
    throw new Error(
      `Recovery module ${config.recoveryModule} is already authorized; cannot prove the pre-auth UnauthorizedMultisig blocker`,
    );
  }
}

async function readFinalState(
  registry: any,
  currentStaking: any,
  freshStaking: any,
  config: MigrationConfig,
): Promise<FinalStateSnapshot> {
  const [currentStakingState, freshStakingState, ownerOfService, freshServiceIds, service] = await Promise.all([
    currentStaking.getStakingState(config.serviceId),
    freshStaking.getStakingState(config.serviceId),
    registry.ownerOf(config.serviceId),
    freshStaking.getServiceIds(),
    registry.getService(config.serviceId),
  ]);
  const serviceSnapshot = serviceFromResult(service);

  return {
    currentStakingState: BigInt(currentStakingState),
    freshStakingState: BigInt(freshStakingState),
    ownerOfService: ethersLib.getAddress(ownerOfService),
    freshServiceIds: toBigIntArray(freshServiceIds),
    serviceMultisig: serviceSnapshot.multisig,
    serviceConfigHash: serviceSnapshot.configHash,
    serviceAgentIds: serviceSnapshot.agentIds,
  };
}

async function getAnvilForkUrl(provider: { send(method: string, params: unknown[]): Promise<unknown> }): Promise<string> {
  let nodeInfo: unknown;
  try {
    nodeInfo = await provider.send('anvil_nodeInfo', []);
  } catch (err) {
    throw new Error(`Expected an Anvil fork. anvil_nodeInfo failed: ${errorToString(err)}`);
  }

  return assertAnvilForkNodeInfo(nodeInfo);
}

async function impersonateAccount(provider: JsonRpcProvider, address: string): Promise<JsonRpcSigner> {
  const checksummed = ethersLib.getAddress(address);
  await provider.send('anvil_impersonateAccount', [checksummed]);
  await provider.send('anvil_setBalance', [checksummed, ethersLib.toQuantity(FUNDED_BALANCE)]);
  return provider.getSigner(checksummed);
}

async function stopImpersonating(
  provider: { send(method: string, params: unknown[]): Promise<unknown> },
  address: string,
): Promise<void> {
  try {
    await provider.send('anvil_stopImpersonatingAccount', [ethersLib.getAddress(address)]);
  } catch {
    // The next fork call does not depend on cleanup; avoid hiding the primary error.
  }
}

async function unstakeAndWithdraw(distributor: any, signer: unknown, config: MigrationConfig): Promise<string> {
  const tx = await distributor.connect(signer).unstakeAndWithdraw(
    config.currentProxy,
    config.serviceId,
    padAddressToBytes32(config.currentProxy),
    { gasLimit: TX_GAS_LIMIT },
  );
  await waitForSuccess(tx, 'unstakeAndWithdraw');
  return tx.hash;
}

async function stakeOnFreshProxy(
  distributor: any,
  signer: unknown,
  config: MigrationConfig,
  agentId: bigint,
  configHash: string,
): Promise<string> {
  const tx = await distributor.connect(signer).stake(
    config.freshProxy,
    config.serviceId,
    agentId,
    configHash,
    config.agentInstance,
    { gasLimit: TX_GAS_LIMIT },
  );
  await waitForSuccess(tx, 'stake');
  return tx.hash;
}

async function expectStakeUnauthorizedMultisig(
  distributor: any,
  signer: unknown,
  config: MigrationConfig,
  agentId: bigint,
  configHash: string,
): Promise<void> {
  try {
    await distributor.connect(signer).stake.staticCall(
      config.freshProxy,
      config.serviceId,
      agentId,
      configHash,
      config.agentInstance,
      { gasLimit: TX_GAS_LIMIT },
    );
  } catch (err) {
    if (errorContainsSelector(err, UNAUTHORIZED_MULTISIG_SELECTOR)) {
      return;
    }
    throw new Error(
      `Expected stake to revert with UnauthorizedMultisig selector ${UNAUTHORIZED_MULTISIG_SELECTOR}; got ${errorToString(err)}`,
    );
  }

  throw new Error(
    `Expected stake to revert with UnauthorizedMultisig selector ${UNAUTHORIZED_MULTISIG_SELECTOR}, but it succeeded`,
  );
}

async function waitForSuccess(tx: { hash: string; wait(): Promise<{ status: number | null; blockNumber?: number } | null> }, label: string) {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} transaction failed: ${tx.hash}`);
  }
  return receipt;
}

function readDeploymentArtifact(cwd: string, fileName: string): UnknownRecord | undefined {
  const candidates = [
    path.resolve(cwd, fileName),
    path.resolve(cwd, 'deployments', fileName),
    path.resolve(cwd, '..', 'operator', 'deployments', fileName),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    return JSON.parse(fs.readFileSync(candidate, 'utf-8')) as UnknownRecord;
  }

  return undefined;
}

function addressFromEnv(env: Env, envName: string, fallback: string): string {
  const value = env[envName]?.trim() || fallback;
  return ethersLib.getAddress(value);
}

function bigintFromEnv(env: Env, envName: string): bigint | undefined {
  const value = env[envName]?.trim();
  return value ? BigInt(value) : undefined;
}

function bigintFromUnknown(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && value.trim()) {
    return BigInt(value);
  }
  return undefined;
}

function asRecord(value: unknown): UnknownRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as UnknownRecord;
  }
  return {};
}

function stringField(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeBytes32(value: string, label: string): string {
  if (!ethersLib.isHexString(value, 32)) {
    throw new Error(`${label} must be a bytes32 hex string`);
  }
  return value.toLowerCase();
}

function serviceFromResult(service: unknown): ServiceSnapshot {
  const serviceRecord = service as UnknownRecord & { [index: number]: unknown };
  const multisig = serviceRecord.multisig ?? serviceRecord[1];
  const configHash = serviceRecord.configHash ?? serviceRecord[2];
  const agentIds = serviceRecord.agentIds ?? serviceRecord[7];

  if (typeof multisig !== 'string') {
    throw new Error('ServiceRegistry.getService result did not include multisig');
  }
  if (typeof configHash !== 'string') {
    throw new Error('ServiceRegistry.getService result did not include configHash');
  }

  return {
    multisig: ethersLib.getAddress(multisig),
    configHash: normalizeBytes32(configHash, 'service config hash'),
    agentIds: toBigIntArray(agentIds),
  };
}

function toBigIntArray(value: unknown): bigint[] {
  if (!value || typeof (value as Iterable<unknown>)[Symbol.iterator] !== 'function') {
    return [];
  }
  return Array.from(value as Iterable<unknown>, (entry) => BigInt(entry as string | number | bigint));
}

function errorContainsSelector(error: unknown, selector: string): boolean {
  return collectErrorStrings(error).some((value) => value.toLowerCase().includes(selector.toLowerCase()));
}

function collectErrorStrings(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (depth > 4 || value === null || value === undefined || seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (typeof value === 'string') {
    return [value];
  }

  if (typeof value !== 'object') {
    return [];
  }

  const output: string[] = [];
  if (value instanceof Error) {
    output.push(value.message, value.name);
  }

  for (const child of Object.values(value as UnknownRecord)) {
    output.push(...collectErrorStrings(child, depth + 1, seen));
  }

  return output;
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function writeEvidence(filePath: string, evidence: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(evidence, stringifyBigInts, 2)}\n`);
}

function stringifyBigInts(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
