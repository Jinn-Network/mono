// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
  UNJS_DESTR_PUBLIC_REPO_PROOF,
  resolvePublicRepoProofRecipe,
  type JinnDifferentialProofSource,
  type PublicRepoProofFixture,
} from './public-repo-fixtures.js';
import {
  parseMintedEnvironmentBindingV1,
  type MintedEnvironmentBindingV1,
} from '../../solver-types/_swe-rebench-v2-minted-pool.js';
import type { PoolTask } from '../../solver-types/_swe-rebench-v2-pool.js';
import { createMintedEnvironmentVerifier } from '../../solver-types/_swe-rebench-v2-minted-environment-verifier.js';
import {
  parseJinnDifferentialAttesterPolicyV1,
  type JinnDifferentialAttesterPolicyV1,
} from '../environment/jinn-differential-policy.js';
import { fetchFromIpfs } from '../../adapters/mech/ipfs.js';
import { isAcceptedIpfsCid } from './ipfs-cid.js';
import {
  bindJinnDifferentialReceiptToProof,
  type ReceiptBoundJinnDifferentialProof,
} from './differential-receipt-bound-proof.js';

export type PublicRepoProofId = PublicRepoProofFixture['id'];
type PublicRepoProofTarget = JinnDifferentialProofSource | PublicRepoProofFixture;

export type LivePublicRepoProofConfig = {
  fixture: PublicRepoProofTarget;
  rpcUrl: string;
  registryUrl: string;
  /** Name of a pre-configured Docker credential helper, never credential data. */
  registryCredentialRef: string;
  minterOperator: `0x${string}`;
  solverOperator: `0x${string}`;
  evaluatorOperator: `0x${string}`;
  candidatesFile: string;
  /** Required only for the real Jinn #1422 route; absent for synthetic parser-contract coverage. */
  differentialAdmission?: ReceiptBoundJinnDifferentialProof;
  /** Exact-source policy passed intact to the external network runner. */
  jinnEnvironmentPolicy?: {
    ipfsGatewayUrl: string;
    environment: MintedEnvironmentBindingV1;
    approvedAttesters: JinnDifferentialAttesterPolicyV1['approvedAttesters'];
  };
};

/** A secret-free handoff document for an existing network/factory runner. */
export type PublicRepoNetworkProofDocumentV1 = {
  schemaVersion: 'jinn.task-creator.public-repo-network-proof.v1';
  fixture: {
    id: PublicRepoProofId;
    repo: string;
    baseCommit: string;
    fixCommit: string;
    instanceId: string;
  };
  rpcUrl: string;
  registry: { url: string; credentialRef: string };
  operators: { minter: `0x${string}`; solver: `0x${string}`; evaluator: `0x${string}` };
  candidatesFile: string;
  differentialAdmission?: { receiptCid: string; receiptHash: `sha256:${string}` };
  /** Runner must fetch this signed spec and re-apply the canonical Jinn policy before launch. */
  jinnEnvironmentPolicy?: {
    ipfsGatewayUrl: string;
    environment: MintedEnvironmentBindingV1;
    approvedAttesters: JinnDifferentialAttesterPolicyV1['approvedAttesters'];
  };
};

export interface LivePublicRepoProofParseOptions {
  fetchEnvironmentSpec?: (gatewayUrl: string, cid: string) => Promise<unknown>;
}

export type NetworkFactoryRunner = (
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<void>;

const REQUIRED_KEYS = [
  'JINN_TASK_CREATOR_RPC_URL',
  'JINN_TASK_CREATOR_REGISTRY_URL',
  'JINN_TASK_CREATOR_REGISTRY_AUTH_REF',
  'JINN_TASK_CREATOR_MINTER_OPERATOR',
  'JINN_TASK_CREATOR_SOLVER_OPERATOR',
  'JINN_TASK_CREATOR_EVALUATOR_OPERATOR',
  'JINN_TASK_CREATOR_CANDIDATES_FILE',
] as const;

const JINN_DIFFERENTIAL_RECEIPT_KEYS = [
  'JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_PATH',
  'JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_CID',
  'JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_HASH',
] as const;

const JINN_ENVIRONMENT_POLICY_KEYS = [
  'JINN_TASK_CREATOR_IPFS_GATEWAY_URL',
  'JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS',
] as const;

// This value is deliberately a helper *name*, not a token, password, URL, or
// arbitrary opaque string. It is copied into both human-visible preflight
// output and the temporary network-runner document, so allowing credential
// material here would turn a supposedly secret-free boundary into a leak.
const DOCKER_CREDENTIAL_HELPER_REF = /^docker-credential-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function publicRepoProofFixture(id: PublicRepoProofId): PublicRepoProofTarget {
  return id === 'jinn-mono' ? JINN_MONO_DIFFERENTIAL_PROOF_SOURCE : UNJS_DESTR_PUBLIC_REPO_PROOF;
}

/**
 * Parse only identifiers, endpoints, paths, and credential-helper names.
 * Credentials/private keys are deliberately neither accepted nor read here.
 */
export async function parseLivePublicRepoProofConfig(
  id: PublicRepoProofId,
  env: NodeJS.ProcessEnv = process.env,
  options: LivePublicRepoProofParseOptions = {},
): Promise<LivePublicRepoProofConfig> {
  const fixture = publicRepoProofFixture(id);
  const required = isJinnDifferentialProofSource(fixture)
    ? [...REQUIRED_KEYS, ...JINN_DIFFERENTIAL_RECEIPT_KEYS, ...JINN_ENVIRONMENT_POLICY_KEYS]
    : REQUIRED_KEYS;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`public-repository live proof missing required configuration: ${missing.join(', ')}`);
  }
  const rpcUrl = validUrl(env.JINN_TASK_CREATOR_RPC_URL!, 'JINN_TASK_CREATOR_RPC_URL');
  const registryUrl = validUrl(env.JINN_TASK_CREATOR_REGISTRY_URL!, 'JINN_TASK_CREATOR_REGISTRY_URL');
  const registryCredentialRef = dockerCredentialHelperRef(env.JINN_TASK_CREATOR_REGISTRY_AUTH_REF!);
  const operators = [
    env.JINN_TASK_CREATOR_MINTER_OPERATOR!,
    env.JINN_TASK_CREATOR_SOLVER_OPERATOR!,
    env.JINN_TASK_CREATOR_EVALUATOR_OPERATOR!,
  ];
  if (!operators.every((value) => /^0x[0-9a-fA-F]{40}$/u.test(value))) {
    throw new Error('public-repository live proof operator identities must be 20-byte 0x addresses');
  }
  if (new Set(operators.map((value) => value.toLowerCase())).size !== operators.length) {
    throw new Error('public-repository live proof requires distinct minter, solver, and evaluator operators');
  }
  const candidatesFile = env.JINN_TASK_CREATOR_CANDIDATES_FILE!;
  if (!existsSync(candidatesFile)) {
    throw new Error(`public-repository live proof candidates file does not exist: ${candidatesFile}`);
  }
  const differentialReceipt = isJinnDifferentialProofSource(fixture)
    ? readJinnDifferentialReceiptReference(env)
    : undefined;
  const jinnAttesterPolicy = isJinnDifferentialProofSource(fixture)
    ? parseJinnDifferentialAttesterPolicyV1(
        env.JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS!.split(',').map((value) => value.trim()).filter(Boolean),
        'JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS',
      )
    : undefined;
  const ipfsGatewayUrl = isJinnDifferentialProofSource(fixture)
    ? validUrl(env.JINN_TASK_CREATOR_IPFS_GATEWAY_URL!, 'JINN_TASK_CREATOR_IPFS_GATEWAY_URL')
    : undefined;
  const differentialAdmission = await assertExplicitEnvironmentCandidates(
    candidatesFile,
    fixture,
    registryUrl,
    differentialReceipt,
    jinnAttesterPolicy && ipfsGatewayUrl ? {
      ipfsGatewayUrl,
      attesterPolicy: jinnAttesterPolicy,
      fetchEnvironmentSpec: options.fetchEnvironmentSpec ?? fetchFromIpfs,
    } : undefined,
  );
  return {
    fixture,
    rpcUrl,
    registryUrl,
    registryCredentialRef,
    minterOperator: operators[0] as `0x${string}`,
    solverOperator: operators[1] as `0x${string}`,
    evaluatorOperator: operators[2] as `0x${string}`,
    candidatesFile,
    ...(differentialAdmission ? { differentialAdmission } : {}),
    ...(differentialAdmission && jinnAttesterPolicy && ipfsGatewayUrl ? {
      jinnEnvironmentPolicy: {
        ipfsGatewayUrl,
        environment: differentialAdmission.environment,
        approvedAttesters: jinnAttesterPolicy.approvedAttesters,
      },
    } : {}),
  };
}

/** The mint-admission step invokes the existing generator-compatible CLI. */
export function publicRepoProofMintCommand(config: LivePublicRepoProofConfig): { bin: 'yarn'; args: string[] } {
  return {
    bin: 'yarn',
    args: ['jinn', 'solver-nets', 'mint-tasks', 'swe-rebench-v2', '--candidates', config.candidatesFile],
  };
}

/**
 * Execute only after the caller opts in.  This function never creates keys or
 * accepts secret material; Docker’s configured credential helper owns registry
 * authentication and the existing operator config owns signing authority.
 */
export async function executeMintAdmission(config: LivePublicRepoProofConfig): Promise<void> {
  if (process.env.JINN_TASK_CREATOR_MINT_EXECUTE !== '1') {
    throw new Error('refusing mint admission: set JINN_TASK_CREATOR_MINT_EXECUTE=1 after reviewing the runbook');
  }
  const command = publicRepoProofMintCommand(config);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.bin, command.args, { cwd: process.cwd(), stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`public-repository mint command exited ${code ?? 'without a status'}`));
    });
  });
}

/**
 * Serialize exactly the non-secret network inputs that a separate factory
 * runner needs. This is intentionally not the mint command: a runner must
 * create/post, coordinate the three distinct operators, and record delivery
 * and verdict evidence before it can claim a network proof.
 */
export function networkProofConfigDocument(config: LivePublicRepoProofConfig): PublicRepoNetworkProofDocumentV1 {
  return {
    schemaVersion: 'jinn.task-creator.public-repo-network-proof.v1',
    fixture: {
      id: config.fixture.id,
      repo: config.fixture.repo,
      baseCommit: config.fixture.baseCommit,
      fixCommit: config.fixture.fixCommit,
      instanceId: config.fixture.instanceId,
    },
    rpcUrl: config.rpcUrl,
    registry: { url: config.registryUrl, credentialRef: config.registryCredentialRef },
    operators: {
      minter: config.minterOperator,
      solver: config.solverOperator,
      evaluator: config.evaluatorOperator,
    },
    candidatesFile: config.candidatesFile,
    ...(config.differentialAdmission ? {
      differentialAdmission: {
        receiptCid: config.differentialAdmission.receiptCid,
        receiptHash: config.differentialAdmission.receiptHash,
      },
    } : {}),
    ...(config.jinnEnvironmentPolicy ? { jinnEnvironmentPolicy: config.jinnEnvironmentPolicy } : {}),
  };
}

/**
 * Launch an explicitly configured factory/network orchestrator.  The caller
 * must supply that runner (for example, an operator-owned deployment wrapper)
 * because mint admission alone cannot prove task posting, delivery, or a
 * verdict. The temporary configuration contains no credential material.
 */
export async function executeNetworkFactoryProof(
  config: LivePublicRepoProofConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    run?: NetworkFactoryRunner;
    fetchEnvironmentSpec?: (gatewayUrl: string, cid: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  if (env.JINN_TASK_CREATOR_NETWORK_EXECUTE !== '1') {
    throw new Error('refusing network/factory execution: set JINN_TASK_CREATOR_NETWORK_EXECUTE=1 after reviewing the runbook');
  }
  const orchestrator = env.JINN_TASK_CREATOR_NETWORK_ORCHESTRATOR;
  if (!orchestrator || !isAbsolute(orchestrator) || !existsSync(orchestrator)) {
    throw new Error('network/factory execution requires JINN_TASK_CREATOR_NETWORK_ORCHESTRATOR as an existing absolute executable path');
  }
  if (isJinnDifferentialProofSource(config.fixture)) {
    const policy = config.jinnEnvironmentPolicy;
    if (!policy) throw new Error('Jinn network/factory execution requires the verified Jinn environment policy binding');
    await assertJinnEnvironmentPolicyBeforeLaunch({
      fixture: config.fixture,
      environment: policy.environment,
      ipfsGatewayUrl: policy.ipfsGatewayUrl,
      attesterPolicy: { approvedAttesters: policy.approvedAttesters },
      fetchEnvironmentSpec: options.fetchEnvironmentSpec ?? fetchFromIpfs,
    });
  }
  const dir = await mkdtemp(join(tmpdir(), 'jinn-public-repo-network-proof-'));
  const configPath = join(dir, 'network-proof.json');
  try {
    await writeFile(configPath, `${JSON.stringify(networkProofConfigDocument(config), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const run = options.run ?? defaultNetworkFactoryRunner;
    await run(orchestrator, ['--task-creator-public-repo-config', configPath], {
      env: safeNetworkFactoryEnvironment(env),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function validUrl(value: string, key: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('scheme');
    // This URL is printed at preflight and persisted in the temporary factory
    // handoff. Disallow common inline credential locations rather than
    // accidentally turning an RPC or registry token into logged config data.
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('credential material');
    }
    return parsed.toString();
  } catch {
    throw new Error(`${key} must be an http(s) URL without credential material`);
  }
}

function dockerCredentialHelperRef(value: string): string {
  if (!DOCKER_CREDENTIAL_HELPER_REF.test(value)) {
    throw new Error('JINN_TASK_CREATOR_REGISTRY_AUTH_REF must name a docker credential-helper (for example docker-credential-ghcr), not credential material');
  }
  return value;
}

async function assertExplicitEnvironmentCandidates(
  path: string,
  fixture: PublicRepoProofTarget,
  registryUrl: string,
  differentialReceipt?: { rawReceipt: unknown; receiptCid: string; receiptHash: `sha256:${string}` },
  jinnEnvironmentPolicy?: {
    ipfsGatewayUrl: string;
    attesterPolicy: JinnDifferentialAttesterPolicyV1;
    fetchEnvironmentSpec: (gatewayUrl: string, cid: string) => Promise<unknown>;
  },
): Promise<ReceiptBoundJinnDifferentialProof | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`public-repository live proof candidates file is not valid JSON: ${path}`);
  }
  const candidates = Array.isArray(raw) ? raw : [raw];
  if (candidates.length === 0) {
    throw new Error('public-repository live proof candidates file must contain at least one candidate');
  }
  const recipe = resolvePublicRepoProofRecipe(fixture);
  const registryHost = new URL(registryUrl).host;
  let bound: ReceiptBoundJinnDifferentialProof | undefined;
  for (const [index, rawCandidate] of candidates.entries()) {
    if (!isRecord(rawCandidate)) throw new Error(`candidate ${index} must be an object`);
    const poolTask = rawCandidate['poolTask'];
    if (!isRecord(poolTask)) throw new Error(`candidate ${index} requires poolTask`);
    assertExactFixturePoolTask(poolTask, fixture, index);
    const rawEnvironment = rawCandidate['environment'];
    if (rawEnvironment === undefined) throw new Error(`candidate ${index} requires an explicit v2 environment binding`);
    let environment: ReturnType<typeof parseMintedEnvironmentBindingV1>;
    try {
      environment = parseMintedEnvironmentBindingV1(rawEnvironment);
    } catch (error) {
      throw new Error(`candidate ${index} has an invalid environment binding: ${errorMessage(error)}`);
    }
    if (environment.image.reference.startsWith('localhost:') || !environment.image.reference.startsWith(`${registryHost}/`)) {
      throw new Error(`candidate ${index} environment image must bind the configured registry host ${registryHost}`);
    }
    if (
      environment.parser.id !== recipe.parser.id ||
      environment.parser.version !== recipe.parser.version ||
      environment.parser.digest !== recipe.parser.digest ||
      environment.parser.bundleId !== recipe.parser.bundleId
    ) {
      throw new Error(`candidate ${index} environment parser does not match the approved ${recipe.recipeId} recipe`);
    }
    if (isJinnDifferentialProofSource(fixture)) {
      if (!differentialReceipt) {
        throw new Error('Jinn proof candidate requires a generated differential receipt reference');
      }
      if (!jinnEnvironmentPolicy) {
        throw new Error('Jinn proof candidate requires an approved attester policy and IPFS gateway');
      }
      await assertJinnEnvironmentPolicyBeforeLaunch({
        fixture,
        environment,
        ipfsGatewayUrl: jinnEnvironmentPolicy.ipfsGatewayUrl,
        attesterPolicy: jinnEnvironmentPolicy.attesterPolicy,
        fetchEnvironmentSpec: jinnEnvironmentPolicy.fetchEnvironmentSpec,
      });
      if (rawCandidate['fixCommit'] !== fixture.fixCommit) {
        throw new Error(`candidate ${index} fixCommit must equal reviewed Jinn fix ${fixture.fixCommit}`);
      }
      const testPatch = poolTask['test_patch'];
      if (typeof testPatch !== 'string') throw new Error(`candidate ${index} poolTask.test_patch must be a string`);
      const candidateAdmission = rawCandidate['differentialAdmission'];
      if (!isRecord(candidateAdmission) || candidateAdmission['receipt'] === undefined) {
        throw new Error(`candidate ${index} requires the generated differential admission receipt content`);
      }
      if (candidateAdmission['receiptHash'] !== differentialReceipt.receiptHash) {
        throw new Error(`candidate ${index} differential receipt hash does not match the configured generated receipt`);
      }
      if (candidateAdmission['receiptCid'] !== differentialReceipt.receiptCid) {
        throw new Error(`candidate ${index} differential receipt CID does not match the configured generated receipt CID`);
      }
      const candidateReceipt = candidateAdmission['receipt'];
      const current = await bindJinnDifferentialReceiptToProof({
        source: fixture,
        receipt: differentialReceipt.rawReceipt,
        receiptCid: differentialReceipt.receiptCid,
        receiptHash: differentialReceipt.receiptHash,
        environment,
        testPatch,
      });
      const candidate = await bindJinnDifferentialReceiptToProof({
        source: fixture,
        receipt: candidateReceipt,
        receiptCid: differentialReceipt.receiptCid,
        receiptHash: differentialReceipt.receiptHash,
        environment,
        testPatch,
      });
      if (candidate.receiptHash !== current.receiptHash) {
        throw new Error(`candidate ${index} differential receipt content does not match the configured generated receipt`);
      }
      if (bound && bound.receiptHash !== current.receiptHash) {
        throw new Error('Jinn proof candidates must bind one generated differential receipt');
      }
      bound = current;
    }
  }
  return bound;
}

function assertExactFixturePoolTask(
  poolTask: Record<string, unknown>,
  fixture: PublicRepoProofTarget,
  index: number,
): void {
  const expected: Record<string, string> = {
    instance_id: fixture.instanceId,
    repo: fixture.repo,
    base_commit: fixture.baseCommit,
    language: fixture.language,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (poolTask[field] !== value) {
      throw new Error(`candidate ${index} poolTask.${field} must equal selected fixture ${value}`);
    }
  }
  if (typeof poolTask['test_patch'] !== 'string' || poolTask['test_patch'].trim() === '') {
    throw new Error(`candidate ${index} poolTask.test_patch must be a non-empty public test patch`);
  }
  if (isJinnDifferentialProofSource(fixture) && poolTask['fix_commit'] !== fixture.fixCommit) {
    throw new Error(`candidate ${index} poolTask.fix_commit must equal reviewed Jinn fix ${fixture.fixCommit}`);
  }
}

function isJinnDifferentialProofSource(
  fixture: PublicRepoProofTarget,
): fixture is JinnDifferentialProofSource {
  return fixture.evidenceKind === 'differential-admission-receipt-required';
}

function readJinnDifferentialReceiptReference(
  env: NodeJS.ProcessEnv,
): { rawReceipt: unknown; receiptCid: string; receiptHash: `sha256:${string}` } {
  const path = env.JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_PATH!;
  const receiptCid = env.JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_CID!;
  const receiptHash = env.JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_HASH!;
  if (!isAcceptedIpfsCid(receiptCid)) {
    throw new Error('JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_CID must be an IPFS CID');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(receiptHash)) {
    throw new Error('JINN_TASK_CREATOR_DIFFERENTIAL_RECEIPT_HASH must be a sha256 digest');
  }
  try {
    return {
      rawReceipt: JSON.parse(readFileSync(path, 'utf8')),
      receiptCid,
      receiptHash: receiptHash as `sha256:${string}`,
    };
  } catch (error) {
    throw new Error(`could not read generated Jinn differential receipt ${path}: ${errorMessage(error)}`);
  }
}

async function assertJinnEnvironmentPolicyBeforeLaunch(args: {
  fixture: JinnDifferentialProofSource;
  environment: MintedEnvironmentBindingV1;
  ipfsGatewayUrl: string;
  attesterPolicy: JinnDifferentialAttesterPolicyV1;
  fetchEnvironmentSpec: (gatewayUrl: string, cid: string) => Promise<unknown>;
}): Promise<void> {
  const verifier = createMintedEnvironmentVerifier({
    ipfsGatewayUrl: args.ipfsGatewayUrl,
    fetchEnvironmentSpec: args.fetchEnvironmentSpec,
    jinnDifferentialAttesterPolicy: args.attesterPolicy,
  });
  const poolTask: Pick<PoolTask, 'instance_id' | 'repo' | 'base_commit'> = {
    instance_id: args.fixture.instanceId,
    repo: args.fixture.repo,
    base_commit: args.fixture.baseCommit,
  };
  await verifier.verify({
    binding: args.environment,
    poolTask: poolTask as PoolTask,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultNetworkFactoryRunner: NetworkFactoryRunner = (bin, args, options) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { cwd: process.cwd(), env: options.env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`network/factory orchestrator exited ${code ?? 'without a status'}`));
  });
});

/**
 * The runner receives only configuration references plus the minimal process
 * plumbing needed for Docker credential helpers and an existing operator home.
 * It never inherits private-key, password, or arbitrary secret variables from
 * this wrapper.
 */
function safeNetworkFactoryEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'JINN_HOME', 'DOCKER_CONFIG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TMPDIR', 'TMP', 'TEMP'] as const) {
    if (source[key] !== undefined) safe[key] = source[key];
  }
  return safe;
}
