#!/usr/bin/env node
/**
 * Release-blocking two-operator donation consumption gate.
 *
 * This is intentionally not a mocked corpus test. It expects real testnet
 * canonical on-chain/IPFS discovery, a producer daemon with fresh donated SWE execution
 * data, and a separate consumer operator home/db that can consume that data
 * through the same MCP tools exposed to the learner runtime.
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../store/store.js';
import { DEFAULT_CONFIG_PATH, DEFAULT_TESTNET_DISCOVERY_URL } from '../config.js';
import {
  DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK,
  DEFAULT_IDENTITY_REGISTRY_BY_CHAIN_ID,
  runOnchainCorpusQuery,
} from '../corpus/onchain-query.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function findPackageRoot(startDir: string): string {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir, '..', '..');
    current = parent;
  }
}

const clientRoot = findPackageRoot(__dirname);
const jinnBinPath = join(clientRoot, 'dist', 'bin', 'jinn.js');
const mcpServerPath = join(clientRoot, 'dist', 'mcp', 'server.js');
const DEFAULT_IPFS_GATEWAY_URL = 'https://gateway.autonolas.tech';
const SWE_SOLUTION_ARTIFACT_TYPE = 'swe-rebench-v2_v1_solution';
const CONSUMER_CLAUDE_DISABLED_HARNESSES = [
  'legacy-claude',
  'claude-code',
  'claude-mcp-hyperliquid',
  'claude-mcp-prediction',
  'claude-mcp-prediction-apy',
] as const;
const VERDICT_ARTIFACT_TYPES = new Set([
  'swe-rebench_v2_verdict',
  'swe-rebench-v2_v1_verdict',
]);

type JsonRecord = Record<string, unknown>;

interface OperatorArtifactsResponse {
  artifacts?: Array<{
    sha256?: string;
    artifactType?: string;
    requestId?: string | null;
    envelopeCid?: string | null;
    createdAt?: string;
    sourceEndpoint?: string | null;
    fetchedAt?: string;
  }>;
}

interface LocalConfig {
  network?: string;
  rpcUrl?: string;
  apiPort?: number;
  dbPath?: string;
  earningDir?: string;
  discovery?: { mode?: string; url?: string; fallbackToOnchain?: boolean };
  taskDiscoveryAllowedTaskIds?: string[];
  ipfsGatewayUrl?: string;
  ipfsRegistryUrl?: string;
  pollIntervalMs?: number;
  operator?: JsonRecord;
  engine?: JsonRecord;
  harnesses?: JsonRecord;
  [key: string]: unknown;
}

interface ProducerArtifact {
  sha256: string;
  artifactType: string;
  requestId: string | null;
  envelopeCid: string;
  createdAt: string;
}

interface VerifiedDonation {
  artifact: ProducerArtifact;
  sourceCid: string;
  trajectorySourceCid: string;
  envelope: JsonRecord;
  redactedEnvelope: JsonRecord;
  indexExecution: JsonRecord;
}

interface HeaderAuth {
  headers?: Record<string, string>;
}

class GateFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: JsonRecord = {},
  ) {
    super(message);
    this.name = 'GateFailure';
  }
}

function fail(code: string, message: string, details: JsonRecord = {}): never {
  throw new GateFailure(code, message, details);
}

function nowSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function boundedPollSleep(deadline: number, pollMs: number): Promise<void> {
  return sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function defaultRpcUrlForChain(chainId: number): string {
  return chainId === 8453 ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
}

function asInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function readJsonFile(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function archiveManagedConsumerDb(dbPath: string, evidenceDir: string): string[] {
  const archived: string[] = [];
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue;
    const target = join(evidenceDir, `previous-${basename(path)}`);
    renameSync(path, target);
    archived.push(target);
  }
  return archived;
}

function defaultClientHome(home: string): string {
  return join(home, '.jinn-client');
}

function engineImplStateRoot(config: LocalConfig, home: string): string {
  const engine = config.engine && typeof config.engine === 'object' && !Array.isArray(config.engine)
    ? config.engine as JsonRecord
    : {};
  return asString(engine.implStateDirRoot) ?? join(defaultClientHome(home), 'engine', 'impl-state');
}

function sweEvaluatorStatePath(config: LocalConfig, home: string): string {
  return join(engineImplStateRoot(config, home), 'swe-rebench-v2-evaluator', 'state.json');
}

function resolveConfigPath(path: string | undefined): string {
  return path ? resolve(path) : DEFAULT_CONFIG_PATH;
}

function loadLocalConfig(path: string): LocalConfig {
  return readJsonFile(path) as LocalConfig;
}

function configApiPort(config: LocalConfig, fallback: number): number {
  return asInt(config.apiPort, fallback);
}

function configDbPath(config: LocalConfig, home: string): string {
  return asString(config.dbPath) ?? join(defaultClientHome(home), 'jinn.db');
}

function configEarningDir(config: LocalConfig, home: string): string {
  return asString(config.earningDir) ?? join(defaultClientHome(home), 'earning');
}

function normalizeIpfsGateway(base: string, cid: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/ipfs') ? `${trimmed}/${cid}` : `${trimmed}/ipfs/${cid}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<JsonRecord> {
  const response = await fetch(url, init);
  if (!response.ok) {
    fail('http_error', `HTTP ${response.status} from ${url}`, { url, status: response.status });
  }
  return (await response.json()) as JsonRecord;
}

async function fetchIpfsJson(gatewayUrl: string, cid: string): Promise<JsonRecord> {
  return fetchJson(normalizeIpfsGateway(gatewayUrl, cid));
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeBase64(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_donation_wrapper', `${label} is missing base64 data`, { label });
  }
  return Buffer.from(value, 'base64');
}

async function queryIndexerExecution(indexerUrl: string, manifestCid: string): Promise<JsonRecord | null> {
  const gqlUrl = indexerUrl.endsWith('/graphql') ? indexerUrl : `${indexerUrl}/graphql`;
  const where = { manifestCid };
  const body = await fetchJson(gqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `
        query DonationEnvelope($where: envelopeFilter) {
          envelopes(where: $where, limit: 1, orderBy: "publishedAtBlock", orderDirection: "desc") {
            items {
              agentId
              manifestCid
              manifestHash
              kind
              evidenceTier
              publishedAtBlock
            }
          }
        }
      `,
      variables: { where },
    }),
  });
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Indexer returned errors while checking donated envelope indexing: ${JSON.stringify(errors)}`);
  }
  const items = ((body.data as JsonRecord | undefined)?.envelopes as JsonRecord | undefined)?.items;
  const item = (Array.isArray(items) ? items : [])[0] as JsonRecord | undefined;
  if (!item) return null;
  // Map Ponder indexer fields to the shape expected by queryCanonicalExecutionIndex callers:
  //   evidenceTier → tier, agentId → operator.agentId, publishedAtBlock → publishedAt
  return {
    manifestCid: item.manifestCid,
    manifestHash: item.manifestHash,
    tier: item.evidenceTier,
    publishedAt: item.publishedAtBlock,
    operator: { agentId: item.agentId },
  };
}

async function queryIndexerTaskIdByTaskCidDigest(indexerUrl: string, taskCidDigest: string): Promise<string | null> {
  const gqlUrl = indexerUrl.endsWith('/graphql') ? indexerUrl : `${indexerUrl}/graphql`;
  const where = { taskCidDigest: taskCidDigest.toLowerCase() };
  const body = await fetchJson(gqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `
        query TaskByTaskCidDigest($where: taskFilter) {
          tasks(where: $where, limit: 1) {
            items {
              id
              taskCidDigest
              createdAtTx
            }
          }
        }
      `,
      variables: { where },
    }),
  });
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Indexer returned errors while resolving producer task id: ${JSON.stringify(errors)}`);
  }
  const items = ((body.data as JsonRecord | undefined)?.tasks as JsonRecord | undefined)?.items;
  const task = (Array.isArray(items) ? items : [])[0] as JsonRecord | undefined;
  // The Ponder indexer's task `id` IS the on-chain task id (decimal string).
  return asString(task?.id) ?? null;
}

async function queryCanonicalExecutionIndex(opts: {
  indexerUrl?: string;
  rpcUrl?: string;
  chainId: number;
  manifestCid: string;
}): Promise<JsonRecord | null> {
  const warnings: string[] = [];
  if (opts.indexerUrl) {
    try {
      const indexerExecution = await queryIndexerExecution(opts.indexerUrl, opts.manifestCid);
      if (indexerExecution) return { source: 'indexer', ...indexerExecution };
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }
  const identityRegistryAddress = DEFAULT_IDENTITY_REGISTRY_BY_CHAIN_ID[opts.chainId];
  if (opts.rpcUrl && identityRegistryAddress) {
    try {
      const refs = await runOnchainCorpusQuery(
        { limit: 100 },
        {
          rpcUrl: opts.rpcUrl,
          chainId: opts.chainId,
          identityRegistryAddress,
          fromBlock: DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[opts.chainId],
        },
      );
      const ref = refs.find((candidate) => candidate.manifestCid === opts.manifestCid);
      if (ref) {
        return {
          source: 'onchain',
          manifestCid: ref.manifestCid,
          manifestHash: ref.manifestHash,
          tier: ref.evidenceTier,
          publishedAt: ref.publishedAt,
          operator: ref.operator,
        };
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }
  return warnings.length > 0 ? { source: 'unavailable', warnings } : null;
}

async function waitForCanonicalExecutionIndex(opts: {
  indexerUrl?: string;
  rpcUrl?: string;
  chainId: number;
  manifestCid: string;
  deadline: number;
  pollMs: number;
}): Promise<JsonRecord> {
  while (Date.now() < opts.deadline) {
    const execution = await queryCanonicalExecutionIndex(opts);
    if (execution && execution.source !== 'unavailable') return execution;
    await boundedPollSleep(opts.deadline, opts.pollMs);
  }
  fail('envelope_not_indexed', 'Donated envelope is not visible through the canonical on-chain/IPFS index path.', {
    manifestCid: opts.manifestCid,
  });
}

function redactEnvelope(envelope: JsonRecord): JsonRecord {
  const artifacts = Array.isArray(envelope.artifacts)
    ? envelope.artifacts.map((raw) => {
        const artifact = raw as JsonRecord;
        return {
          artifactType: artifact.artifactType,
          sha256: artifact.sha256,
          access: artifact.access,
          metadata: artifact.metadata,
          sources: artifact.sources,
        };
      })
    : [];
  return {
    schemaVersion: envelope.schemaVersion,
    solverType: envelope.solverType,
    role: envelope.role,
    generatedAt: envelope.generatedAt,
    participant: envelope.participant,
    executor: envelope.executor,
    trajectory: envelope.trajectory,
    artifacts,
    payload: '<redacted>',
  };
}

async function verifyTrajectorySource(envelope: JsonRecord, ipfsGatewayUrl: string): Promise<string> {
  const trajectory = envelope.trajectory as JsonRecord | null | undefined;
  if (!trajectory || typeof trajectory !== 'object') {
    fail('trajectory_missing', 'Donated envelope does not include a trajectory reference.', {});
  }
  const trajectorySha = trajectory.sha256;
  if (typeof trajectorySha !== 'string' || !/^[0-9a-f]{64}$/.test(trajectorySha)) {
    fail('trajectory_invalid', 'Envelope trajectory is missing a valid sha256.', { trajectory });
  }
  const sources = Array.isArray(trajectory.sources) ? trajectory.sources as JsonRecord[] : [];
  if (sources.length === 0) {
    fail('trajectory_sources_missing', 'Envelope trajectory has no donated IPFS source.', { trajectory });
  }
  let firstCid = '';
  for (const source of sources) {
    if (
      source.kind !== 'ipfs' ||
      typeof source.cid !== 'string' ||
      source.sha256 !== trajectorySha ||
      source.encoding !== 'jinn.artifact.donation.v1'
    ) {
      fail('invalid_trajectory_source', 'Envelope trajectory source is not a valid donated IPFS source.', {
        trajectory,
        source,
      });
    }
    firstCid ||= source.cid;
    const wrapper = await fetchIpfsJson(ipfsGatewayUrl, source.cid);
    if (
      wrapper.schemaVersion !== 'jinn.artifact.donation.v1' ||
      wrapper.encoding !== 'jinn.artifact.donation.v1' ||
      wrapper.artifactType !== 'jinn.trajectory.v1' ||
      wrapper.sha256 !== trajectorySha
    ) {
      fail('invalid_trajectory_wrapper', 'Trajectory wrapper has unexpected schema, encoding, artifact type, or sha256.', {
        cid: source.cid,
        trajectorySha,
      });
    }
    const bytes = decodeBase64(wrapper.data, 'trajectory donation wrapper');
    const actualSha = sha256Hex(bytes);
    if (actualSha !== trajectorySha) {
      fail('trajectory_wrapper_hash_mismatch', 'Trajectory wrapper bytes do not match the advertised sha256.', {
        cid: source.cid,
        expected: trajectorySha,
        actual: actualSha,
      });
    }
    const trajectoryPayload = parseMaybeJson(bytes);
    if (trajectoryPayload?.schemaVersion !== 'jinn.trajectory.v1') {
      fail('trajectory_wrapper_payload_invalid', 'Trajectory wrapper bytes are not a jinn.trajectory.v1 payload.', {
        cid: source.cid,
        schemaVersion: trajectoryPayload?.schemaVersion,
      });
    }
  }
  return firstCid;
}

async function verifyDonatedEnvelope(
  artifact: ProducerArtifact,
  ipfsGatewayUrl: string,
  indexOpts: { indexerUrl?: string; rpcUrl?: string; chainId: number },
  deadline: number,
  pollMs: number,
): Promise<VerifiedDonation> {
  const envelope = await fetchIpfsJson(ipfsGatewayUrl, artifact.envelopeCid);
  const artifacts = Array.isArray(envelope.artifacts) ? envelope.artifacts as JsonRecord[] : [];
  const target = artifacts.find((candidate) => candidate.sha256 === artifact.sha256);
  if (!target) {
    fail('artifact_missing_from_envelope', 'Producer artifact sha256 is not present in its envelope.', {
      sha256: artifact.sha256,
      envelopeCid: artifact.envelopeCid,
    });
  }
  const sources = Array.isArray(target.sources) ? target.sources as JsonRecord[] : [];
  if (sources.length === 0) {
    fail('donation_sources_missing', 'Donated SWE artifact has no IPFS sources.', {
      sha256: artifact.sha256,
      envelopeCid: artifact.envelopeCid,
    });
  }
  let firstCid = '';
  for (const source of sources) {
    if (
      source.kind !== 'ipfs' ||
      typeof source.cid !== 'string' ||
      source.sha256 !== artifact.sha256 ||
      source.encoding !== 'jinn.artifact.donation.v1'
    ) {
      fail('invalid_donation_source', 'Envelope source is not a valid donation IPFS source.', {
        sha256: artifact.sha256,
        source,
      });
    }
    firstCid ||= source.cid;
    const wrapper = await fetchIpfsJson(ipfsGatewayUrl, source.cid);
    if (
      wrapper.schemaVersion !== 'jinn.artifact.donation.v1' ||
      wrapper.encoding !== 'jinn.artifact.donation.v1' ||
      wrapper.sha256 !== artifact.sha256
    ) {
      fail('invalid_donation_wrapper', 'Donation wrapper has unexpected schema, encoding, or sha256.', {
        cid: source.cid,
        sha256: artifact.sha256,
      });
    }
    const bytes = decodeBase64(wrapper.data, 'donation wrapper');
    const actualSha = sha256Hex(bytes);
    if (actualSha !== artifact.sha256) {
      fail('donation_wrapper_hash_mismatch', 'Donation wrapper bytes do not match the advertised sha256.', {
        cid: source.cid,
        expected: artifact.sha256,
        actual: actualSha,
      });
    }
  }
  const trajectorySourceCid = await verifyTrajectorySource(envelope, ipfsGatewayUrl);
  const indexExecution = await waitForCanonicalExecutionIndex({
    ...indexOpts,
    manifestCid: artifact.envelopeCid,
    deadline,
    pollMs,
  });
  return {
    artifact,
    sourceCid: firstCid,
    trajectorySourceCid,
    envelope,
    redactedEnvelope: redactEnvelope(envelope),
    indexExecution,
  };
}

async function fetchOperatorArtifacts(
  baseUrl: string,
  source: 'served' | 'network',
  artifactType: string,
  auth: HeaderAuth = {},
): Promise<OperatorArtifactsResponse> {
  const url = new URL('/v1/operator/artifacts', baseUrl);
  url.searchParams.set('source', source);
  url.searchParams.set('artifactType', artifactType);
  url.searchParams.set('limit', '50');
  return fetchJson(url.toString(), auth.headers ? { headers: auth.headers } : undefined) as Promise<OperatorArtifactsResponse>;
}

async function waitForProducerArtifact(opts: {
  producerUrl: string;
  startedAt: Date;
  deadline: number;
  reuseExisting: boolean;
  pollMs: number;
  producerAuth: HeaderAuth;
}): Promise<ProducerArtifact> {
  let lastError: string | null = null;
  while (Date.now() < opts.deadline) {
    try {
      const response = await fetchOperatorArtifacts(
        opts.producerUrl,
        'served',
        SWE_SOLUTION_ARTIFACT_TYPE,
        opts.producerAuth,
      );
      const artifacts = response.artifacts ?? [];
      const candidate = artifacts.find((row) => {
        if (
          row.artifactType !== SWE_SOLUTION_ARTIFACT_TYPE ||
          typeof row.sha256 !== 'string' ||
          !row.envelopeCid ||
          typeof row.createdAt !== 'string'
        ) {
          return false;
        }
        return opts.reuseExisting || Date.parse(row.createdAt) >= opts.startedAt.getTime();
      });
      if (candidate?.sha256 && candidate.envelopeCid && candidate.createdAt) {
        return {
          sha256: candidate.sha256,
          artifactType: SWE_SOLUTION_ARTIFACT_TYPE,
          requestId: candidate.requestId ?? null,
          envelopeCid: candidate.envelopeCid,
          createdAt: candidate.createdAt,
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await boundedPollSleep(opts.deadline, opts.pollMs);
  }
  fail(
    'producer_artifact_timeout',
    opts.reuseExisting
      ? 'No donated SWE solution artifact with an envelope CID was found on the producer.'
      : 'No fresh donated SWE solution artifact was produced after the release gate started.',
    { producerUrl: opts.producerUrl, artifactType: SWE_SOLUTION_ARTIFACT_TYPE, lastError },
  );
}

async function producerAuthFromHandshake(producerUrl: string, handshakeKey: string): Promise<HeaderAuth> {
  const url = new URL('/auth/handshake', producerUrl);
  url.searchParams.set('k', handshakeKey);
  const response = await fetch(url);
  if (!response.ok) {
    fail('producer_handshake_failed', 'Producer UI handshake failed.', {
      producerUrl,
      status: response.status,
    });
  }
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie?.split(';')[0]?.trim();
  if (!cookie) {
    fail('producer_handshake_cookie_missing', 'Producer UI handshake did not return a session cookie.', {
      producerUrl,
    });
  }
  return { headers: { cookie } };
}

async function resolveProducerAuth(opts: {
  producerUrl: string;
  producerUiToken?: string;
  producerHandshakeKey?: string;
}): Promise<HeaderAuth> {
  if (opts.producerUiToken) {
    return { headers: { 'x-jinn-ui-token': opts.producerUiToken } };
  }
  if (opts.producerHandshakeKey) {
    return producerAuthFromHandshake(opts.producerUrl, opts.producerHandshakeKey);
  }
  return {};
}

function buildConsumerHarnesses(raw: unknown): JsonRecord {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as JsonRecord) }
    : {};
  const disabled = new Set<string>();
  for (const entry of Array.isArray(base.disabled) ? base.disabled : []) {
    if (typeof entry === 'string' && entry.trim()) disabled.add(entry.trim());
  }
  for (const name of CONSUMER_CLAUDE_DISABLED_HARNESSES) disabled.add(name);
  delete base.externalImpls;
  return {
    ...base,
    default: 'codex',
    disabled: [...disabled],
  };
}

export function buildConsumerConfig(opts: {
  producerConfig: LocalConfig;
  consumerHome: string;
  consumerPort: number;
  indexerUrl: string;
  ipfsGatewayUrl: string;
}): LocalConfig {
  const clientHome = defaultClientHome(opts.consumerHome);
  const base: LocalConfig = {
    network: opts.producerConfig.network ?? 'testnet',
    rpcUrl: opts.producerConfig.rpcUrl,
    earningDir: join(clientHome, 'earning'),
    dbPath: join(clientHome, 'jinn.db'),
    apiPort: opts.consumerPort,
    pollIntervalMs: opts.producerConfig.pollIntervalMs ?? 5000,
    discovery: { mode: 'http', url: opts.indexerUrl, fallbackToOnchain: true },
    ipfsGatewayUrl: opts.ipfsGatewayUrl,
    ipfsRegistryUrl: opts.producerConfig.ipfsRegistryUrl ?? 'https://registry.autonolas.tech',
    operator: {
      publicEndpoint: `http://localhost:${opts.consumerPort}`,
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
      donation: { enabled: true },
    },
    ...(opts.producerConfig.claudePath ? { claudePath: opts.producerConfig.claudePath } : {}),
    ...(opts.producerConfig.claudeModel ? { claudeModel: opts.producerConfig.claudeModel } : {}),
    ...(opts.producerConfig.runtimeMode ? { runtimeMode: opts.producerConfig.runtimeMode } : {}),
    ...(opts.producerConfig.harness ? { harness: opts.producerConfig.harness } : {}),
    harnesses: buildConsumerHarnesses(opts.producerConfig.harnesses),
    // Issue #421: the legacy `solverNets` block is retired; consumer config
    // inherits the producer's `joinedSolverNets` only.
    ...(opts.producerConfig.joinedSolverNets ? { joinedSolverNets: opts.producerConfig.joinedSolverNets } : {}),
    engine: {
      workingDirRoot: join(clientHome, 'engine', 'work'),
      implStateDirRoot: join(clientHome, 'engine', 'impl-state'),
    },
    tasks: [],
  };
  for (const key of [
    'testnetL2DeploymentPath',
    'testnetL2TokenDeploymentPath',
    'testnetMechDeploymentPath',
    'testnetStolasDeploymentPath',
    'jinnMviL1DeploymentPath',
    'jinnMviL2DeploymentPath',
    'ethereumRpcUrl',
    'jinnDistributorAddress',
    'jinnClaimEmitterAddress',
  ]) {
    if (opts.producerConfig[key] !== undefined) base[key] = opts.producerConfig[key];
  }
  return base;
}

export function ensureConsumerSweEvaluatorState(opts: {
  producerConfig: LocalConfig;
  producerHome: string;
  consumerConfig: LocalConfig;
  consumerHome: string;
  evidenceDir?: string;
}): string {
  const consumerStatePath = sweEvaluatorStatePath(opts.consumerConfig, opts.consumerHome);
  const consumerState = readJsonFile(consumerStatePath);
  const existingUpstream = asString(consumerState.upstreamRepoDir);
  if (consumerState.schemaVersion === 'swe-rebench-v2-evaluator-state.v1' && existingUpstream && existsSync(existingUpstream)) {
    return consumerStatePath;
  }

  const producerStatePath = sweEvaluatorStatePath(opts.producerConfig, opts.producerHome);
  const producerState = readJsonFile(producerStatePath);
  const upstreamRepoDir = asString(producerState.upstreamRepoDir);
  if (producerState.schemaVersion !== 'swe-rebench-v2-evaluator-state.v1' || !upstreamRepoDir || !existsSync(upstreamRepoDir)) {
    fail('consumer_evaluator_setup_required', 'Consumer SWE evaluator is not enabled and no reusable producer evaluator checkout was found.', {
      producerStatePath,
      consumerStatePath,
      remedy:
        'Run `jinn harnesses enable swe-rebench-v2-evaluator` for the producer or the consumer config, then rerun the donation-consumption gate.',
    });
  }

  const nextState = {
    schemaVersion: 'swe-rebench-v2-evaluator-state.v1',
    enabled: true,
    enabledAt: new Date().toISOString(),
    upstreamRepoDir,
  };
  writeJson(consumerStatePath, nextState);
  if (opts.evidenceDir) {
    writeJson(join(opts.evidenceDir, 'consumer-evaluator-state.json'), {
      consumerStatePath,
      sourceStatePath: producerStatePath,
      upstreamRepoDir,
    });
  }
  return consumerStatePath;
}

function sourceName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    return asString(record.name) ?? asString(record.source);
  }
  return undefined;
}

function includesSweRuntimePlugin(plugins: unknown): boolean {
  return Array.isArray(plugins) && plugins.some((plugin) => {
    const name = sourceName(plugin);
    return name === 'bundled:swe-rebench-v2-runtime' || name === 'swe-rebench-v2-runtime';
  });
}

function disablesSweRuntime(disabledDefaults: unknown): boolean {
  return Array.isArray(disabledDefaults) && disabledDefaults.some((entry) =>
    entry === 'bundled:swe-rebench-v2-runtime' || entry === 'swe-rebench-v2-runtime',
  );
}

function assertConsumerConfiguredForSwe(config: LocalConfig, configPath: string): void {
  const joined = config.joinedSolverNets;
  const entries = joined && typeof joined === 'object' && !Array.isArray(joined)
    ? Object.values(joined as Record<string, JsonRecord>)
    : [];
  const sweEntries = entries.filter((entry) => {
    const contract = entry.contract as JsonRecord | undefined;
    return contract?.id === 'swe-rebench-v2' && contract?.version === 'v1';
  });
  const solverEntries = sweEntries.filter((entry) => (
    Array.isArray(entry.roles) && entry.roles.includes('solver')
  ));
  const evaluatorEntries = sweEntries.filter((entry) => (
    Array.isArray(entry.roles) && entry.roles.includes('evaluator')
  ));
  const joinedRuntimeEnabled = solverEntries.some((entry) => (
    !disablesSweRuntime(entry.disabledDefaultPlugins) || includesSweRuntimePlugin(entry.plugins)
  ));
  // Issue #421: legacy `solverNets` is retired; SWE-rebench v2 SolverNet
  // membership is asserted via joinedSolverNets exclusively.
  const hasSolver = solverEntries.length > 0;
  const hasEvaluator = evaluatorEntries.length > 0;
  const runtimeEnabled = joinedRuntimeEnabled;
  if (!hasSolver || !hasEvaluator || !runtimeEnabled) {
    fail('consumer_swe_join_required', 'Consumer config is not joined to SWE-rebench v2 for the live donation gate.', {
      configPath,
      hasSolver,
      hasEvaluator,
      runtimeEnabled,
      remedy:
        'Join SWE-rebench v2 in the app as solver and evaluator with Network Tools plus swe-rebench-v2-runtime enabled, then rerun this gate with --consumer-config or the default isolated consumer home.',
    });
  }
}

export function resolveConsumerCodexHome(raw?: string): string | undefined {
  const explicit = raw?.trim() || process.env['JINN_DONATION_CONSUMER_CODEX_HOME']?.trim();
  if (explicit) return resolve(explicit);
  const envHome = process.env['CODEX_HOME']?.trim();
  if (envHome) return resolve(envHome);
  const defaultPath = join(homedir(), '.codex');
  return existsSync(join(defaultPath, 'auth.json')) ? defaultPath : undefined;
}

function assertConsumerCodexAuthAvailable(codexHome: string | undefined): void {
  if (process.env['OPENAI_API_KEY']?.trim()) return;
  if (codexHome && existsSync(join(codexHome, 'auth.json'))) return;
  fail('consumer_codex_auth_required', 'Consumer Codex harness auth is missing for the live donation gate.', {
    codexHome,
    remedy:
      'Set OPENAI_API_KEY, CODEX_HOME, JINN_DONATION_CONSUMER_CODEX_HOME, or pass --consumer-codex-home pointing at a Codex home with auth.json.',
  });
}

export function buildConsumerChildEnv(home: string, apiToken: string, codexHome?: string): NodeJS.ProcessEnv {
  const corepackHome = process.env['COREPACK_HOME'] ?? join(homedir(), '.cache', 'node', 'corepack');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    COREPACK_HOME: corepackHome,
    DAEMON_API_TOKEN: apiToken,
    JINN_NO_UI: '1',
    NO_COLOR: '1',
  };
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}

function runFundingPreflight(configPath: string, home: string, apiToken: string, evidenceDir: string, codexHome?: string): void {
  const result = spawnSync(process.execPath, [jinnBinPath, 'fund-requirements', '--json', '--config', configPath], {
    cwd: clientRoot,
    env: buildConsumerChildEnv(home, apiToken, codexHome),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  writeFileSync(join(evidenceDir, 'consumer-fund-requirements.stdout'), result.stdout ?? '', 'utf8');
  writeFileSync(join(evidenceDir, 'consumer-fund-requirements.stderr'), result.stderr ?? '', 'utf8');
  if ((result.status ?? 1) !== 0) {
    fail('consumer_funding_preflight_failed', 'Consumer funding preflight failed.', {
      status: result.status,
      configPath,
      remedy: `Run: HOME=${home} node ${jinnBinPath} fund-requirements --json --config ${configPath}`,
    });
  }
  const lines = (result.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const jsonLine = lines.reverse().find((line) => line.startsWith('{'));
  if (!jsonLine) return;
  const payload = JSON.parse(jsonLine) as JsonRecord;
  if (payload.satisfied === false) {
    fail('consumer_funding_required', 'Consumer operator is not funded enough for the live donation gate.', {
      fundRequirements: payload,
      remedy: `Fund the listed addresses, then run: HOME=${home} node ${jinnBinPath} bootstrap --json --config ${configPath}`,
    });
  }
}

function startConsumerDaemon(opts: {
  configPath: string;
  home: string;
  apiToken: string;
  evidenceDir: string;
  codexHome?: string;
}): ChildProcess {
  const child = spawn(process.execPath, [
    jinnBinPath,
    'run',
    '--no-ui',
    '--funding-timeout',
    '1ms',
    '--json',
    '--config',
    opts.configPath,
  ], {
    cwd: clientRoot,
    env: buildConsumerChildEnv(opts.home, opts.apiToken, opts.codexHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    writeFileSync(join(opts.evidenceDir, 'consumer-daemon.stdout'), String(chunk), { flag: 'a' });
  });
  child.stderr.on('data', (chunk) => {
    writeFileSync(join(opts.evidenceDir, 'consumer-daemon.stderr'), String(chunk), { flag: 'a' });
  });
  return child;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise(childHasExited(child));
    }, timeoutMs);
    const done = () => {
      cleanup();
      resolvePromise(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', done);
      child.off('error', done);
    };
    child.once('exit', done);
    child.once('error', done);
  });
}

async function stopManagedConsumerDaemon(opts: {
  child: ChildProcess;
  configPath: string;
  home: string;
  apiToken: string;
  evidenceDir: string;
  codexHome?: string;
}): Promise<void> {
  const stopResult = spawnSync(process.execPath, [jinnBinPath, 'stop', '--json', '--config', opts.configPath], {
    cwd: clientRoot,
    env: buildConsumerChildEnv(opts.home, opts.apiToken, opts.codexHome),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  writeFileSync(join(opts.evidenceDir, 'consumer-daemon-stop.stdout'), stopResult.stdout ?? '', { flag: 'a' });
  writeFileSync(join(opts.evidenceDir, 'consumer-daemon-stop.stderr'), stopResult.stderr ?? '', { flag: 'a' });

  if (!childHasExited(opts.child)) {
    opts.child.kill('SIGTERM');
    await waitForChildExit(opts.child, 5_000);
  }
  if (!childHasExited(opts.child)) {
    opts.child.kill('SIGKILL');
    await waitForChildExit(opts.child, 5_000);
  }

  opts.child.stdout?.destroy();
  opts.child.stderr?.destroy();
  if (!childHasExited(opts.child)) {
    fail('consumer_daemon_cleanup_failed', 'Managed consumer daemon did not exit after the live gate completed.', {
      pid: opts.child.pid,
      stopStatus: stopResult.status,
      stdoutPath: join(opts.evidenceDir, 'consumer-daemon-stop.stdout'),
      stderrPath: join(opts.evidenceDir, 'consumer-daemon-stop.stderr'),
    });
  }
}

async function waitForStatus(opts: {
  baseUrl: string;
  deadline: number;
  pollMs: number;
  consumerProcess?: ChildProcess | null;
  evidenceDir?: string;
}): Promise<void> {
  while (Date.now() < opts.deadline) {
    const child = opts.consumerProcess;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      fail('consumer_daemon_exited', 'Consumer daemon exited before it became reachable.', {
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stdoutPath: opts.evidenceDir ? join(opts.evidenceDir, 'consumer-daemon.stdout') : undefined,
        stderrPath: opts.evidenceDir ? join(opts.evidenceDir, 'consumer-daemon.stderr') : undefined,
      });
    }
    try {
      const response = await fetch(new URL('/v1/status', opts.baseUrl));
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await boundedPollSleep(opts.deadline, opts.pollMs);
  }
  fail('consumer_daemon_unreachable', 'Consumer daemon did not become reachable before timeout.', { consumerUrl: opts.baseUrl });
}

async function callMcpTool(opts: {
  name: string;
  args: JsonRecord;
  storePath: string;
  daemonApiUrl: string;
  daemonApiToken: string;
  indexerUrl?: string;
  ipfsGatewayUrl: string;
  rpcUrl?: string;
  chainId: number;
  identityRegistryAddress?: string;
  fromBlock?: number;
}): Promise<JsonRecord> {
  const client = new Client({ name: 'donation-consumption-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    cwd: clientRoot,
    env: {
      ...process.env,
      STORE_PATH: opts.storePath,
      DAEMON_API_URL: opts.daemonApiUrl,
      DAEMON_API_TOKEN: opts.daemonApiToken,
      // Discovery env for the MCP server's read-only corpus bootstrap.
      // JINN_DISCOVERY_URL replaces the old JINN_CORPUS_SUBGRAPH_URL.
      JINN_DISCOVERY_URL: opts.indexerUrl ?? '',
      JINN_DISCOVERY_MODE: opts.indexerUrl ? 'http' : 'onchain',
      JINN_CORPUS_IPFS_GATEWAY_URL: opts.ipfsGatewayUrl,
      JINN_CORPUS_RPC_URL: opts.rpcUrl ?? '',
      JINN_CORPUS_CHAIN_ID: String(opts.chainId),
      JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS: opts.identityRegistryAddress ?? '',
      JINN_CORPUS_FROM_BLOCK: opts.fromBlock != null ? String(opts.fromBlock) : '',
      DESIRED_STATE_ID: 'donation-consumption-acceptance',
      DESIRED_STATE_DESCRIPTION: 'Verify cross-operator donated SWE execution data consumption.',
      DESIRED_STATE_ROLE: 'restoration',
      DESIRED_STATE_SOLVER_TYPE: 'swe-rebench-v2.v1',
      REQUEST_ID: 'donation-consumption-acceptance',
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: opts.name, arguments: opts.args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((entry) => entry.type === 'text' && entry.text)
      .map((entry) => entry.text)
      .join('\n');
    try {
      return JSON.parse(text) as JsonRecord;
    } catch (err) {
      fail('consumer_mcp_non_json_response', `MCP tool ${opts.name} returned non-JSON text.`, {
        tool: opts.name,
        text,
        parseError: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    await client.close();
  }
}

function hasDonatedIpfsSourceArgs(artifact: JsonRecord): boolean {
  const acquisition = artifact.acquisition as JsonRecord | undefined;
  const args = acquisition?.arguments as JsonRecord | undefined;
  const sources = Array.isArray(args?.sources) ? args.sources as JsonRecord[] : [];
  return sources.some((source) => source.kind === 'ipfs' && source.encoding === 'jinn.artifact.donation.v1');
}

export function findDonatedArtifactRecord(searchResult: JsonRecord, proof: VerifiedDonation): JsonRecord {
  const records = Array.isArray(searchResult.records) ? searchResult.records as JsonRecord[] : [];
  const matches: JsonRecord[] = [];
  for (const record of records) {
    const envelopeRef = record.envelopeRef as JsonRecord | null | undefined;
    if (envelopeRef?.cid !== proof.artifact.envelopeCid) continue;
    const artifactRefs = Array.isArray(record.artifactRefs) ? record.artifactRefs as JsonRecord[] : [];
    const artifact = artifactRefs.find((candidate) => candidate.sha256 === proof.artifact.sha256);
    if (artifact) matches.push(artifact);
  }
  const networkAcquisition = matches.find(hasDonatedIpfsSourceArgs);
  if (networkAcquisition) return networkAcquisition;
  if (matches[0]) return matches[0];
  fail('consumer_discovery_missing', 'Consumer MCP search_records did not discover the producer donated artifact.', {
    envelopeCid: proof.artifact.envelopeCid,
    sha256: proof.artifact.sha256,
    recordsSeen: records.length,
  });
}

function acquisitionArgsFromArtifact(artifact: JsonRecord): JsonRecord {
  const acquisition = artifact.acquisition as JsonRecord | undefined;
  const args = acquisition?.arguments as JsonRecord | undefined;
  if (!args) {
    fail('consumer_acquisition_args_missing', 'Discovered artifact does not include acquire_artifact arguments.', {
      artifact,
    });
  }
  if (!hasDonatedIpfsSourceArgs(artifact)) {
    fail('consumer_acquisition_sources_missing', 'Discovered artifact acquisition args do not include donated IPFS sources.', {
      args,
    });
  }
  return args;
}

function proofParticipantSafe(proof: VerifiedDonation): string {
  const participant = proof.envelope.participant;
  if (participant && typeof participant === 'object' && !Array.isArray(participant)) {
    const safe = (participant as JsonRecord).safeAddress;
    if (typeof safe === 'string' && safe) return safe;
  }
  return '';
}

function producerTaskCreationTx(proof: VerifiedDonation): string | undefined {
  const task = proof.envelope.task;
  if (!task || typeof task !== 'object' || Array.isArray(task)) return undefined;
  return asString((task as JsonRecord).onchainCreationTx);
}

function producerTaskCidDigest(proof: VerifiedDonation): string | undefined {
  const task = proof.envelope.task;
  if (!task || typeof task !== 'object' || Array.isArray(task)) return undefined;
  const cid = asString((task as JsonRecord).cid);
  if (!cid) return undefined;
  if (/^0x[0-9a-fA-F]{64}$/.test(cid)) return cid;
  const rawMultihashPrefix = 'f01551220';
  if (cid.startsWith(rawMultihashPrefix) && cid.length === rawMultihashPrefix.length + 64) {
    return `0x${cid.slice(rawMultihashPrefix.length)}`;
  }
  return undefined;
}

export async function scopeConsumerConfigToProducerTask(opts: {
  consumerConfig: LocalConfig;
  consumerConfigPath: string;
  proof: VerifiedDonation;
  indexerUrl: string;
  evidenceDir?: string;
}): Promise<string> {
  const taskCidDigest = producerTaskCidDigest(opts.proof);
  if (!taskCidDigest) {
    fail('producer_task_scope_missing_cid_digest', 'Producer envelope is missing a task CID digest, so the gate cannot scope consumer task discovery.', {
      envelopeCid: opts.proof.artifact.envelopeCid,
    });
  }
  const createdAtTx = producerTaskCreationTx(opts.proof);
  const taskId = await queryIndexerTaskIdByTaskCidDigest(opts.indexerUrl, taskCidDigest);
  if (!taskId) {
    fail('producer_task_scope_unresolved', 'Could not resolve the producer on-chain task id from the configured Ponder indexer.', {
      envelopeCid: opts.proof.artifact.envelopeCid,
      taskCidDigest,
      createdAtTx,
      indexerUrl: opts.indexerUrl,
    });
  }

  opts.consumerConfig.taskDiscoveryAllowedTaskIds = [taskId];
  writeJson(opts.consumerConfigPath, opts.consumerConfig);
  if (opts.evidenceDir) {
    writeJson(join(opts.evidenceDir, 'consumer-task-scope.json'), {
      allowedTaskIds: [taskId],
      producerEnvelopeCid: opts.proof.artifact.envelopeCid,
      producerTaskCidDigest: taskCidDigest,
      producerTaskCreatedAtTx: createdAtTx ?? null,
      consumerConfigPath: opts.consumerConfigPath,
    });
  }
  return taskId;
}

function parseMaybeJson(bytes: Buffer): JsonRecord | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

export async function waitForConsumerSolveAndEvaluatorProof(opts: {
  storePath: string;
  proof: VerifiedDonation;
  allowedTaskId?: string;
  startedAt: Date;
  acquisitionStartedAt: Date;
  acquisitionFinishedAt: Date;
  reuseExisting: boolean;
  deadline: number;
  pollMs: number;
}): Promise<{ networkRow: JsonRecord; solution: JsonRecord; verdict: JsonRecord }> {
  while (Date.now() < opts.deadline) {
    const store = new Store(opts.storePath);
    try {
      const networkRow = store.getNetworkArtifact(opts.proof.artifact.sha256);
      const runMatches = (
        requestId: string | null | undefined,
        expectedRole: 'restoration' | 'evaluation',
      ): boolean => {
        if (!requestId) return false;
        const row = store.db.prepare(`
          SELECT
            task_id AS taskId,
            task_role AS taskRole,
            state,
            manifest_cid AS manifestCid,
            delivery_tx_hash AS deliveryTxHash
          FROM task_runs
          WHERE request_id = ?
        `).get(requestId) as {
          taskId?: string | null;
          taskRole?: string | null;
          state?: string | null;
          manifestCid?: string | null;
          deliveryTxHash?: string | null;
        } | undefined;
        if (!row) return false;
        if (!opts.reuseExisting && opts.allowedTaskId && row.taskId !== opts.allowedTaskId) return false;
        return (
          row.taskRole === expectedRole &&
          row.state === 'COMPLETE' &&
          typeof row.manifestCid === 'string' &&
          row.manifestCid.length > 0 &&
          typeof row.deliveryTxHash === 'string' &&
          row.deliveryTxHash.length > 0
        );
      };
      const solutionRow = store.listServedArtifactMetadata({
        artifactType: SWE_SOLUTION_ARTIFACT_TYPE,
        limit: 50,
      }).find((row) => (
        (opts.reuseExisting || Date.parse(row.createdAt) >= opts.acquisitionFinishedAt.getTime()) &&
        runMatches(row.requestId, 'restoration')
      ));
      const verdictRow = store.listServedArtifactMetadata({ limit: 100 }).find((row) => {
        if (!VERDICT_ARTIFACT_TYPES.has(row.artifactType)) return false;
        return (
          (opts.reuseExisting || Date.parse(row.createdAt) >= opts.acquisitionFinishedAt.getTime()) &&
          runMatches(row.requestId, 'evaluation')
        );
      });
      if (
        networkRow &&
        networkRow.envelopeCid === opts.proof.artifact.envelopeCid &&
        networkRow.sourceEndpoint === `ipfs://${opts.proof.sourceCid}` &&
        networkRow.sourceOperator === proofParticipantSafe(opts.proof) &&
        networkRow.paidAmountUsdc === '0' &&
        (opts.reuseExisting || Date.parse(networkRow.fetchedAt) >= opts.startedAt.getTime()) &&
        (opts.reuseExisting || Date.parse(networkRow.lastUsedAt) >= opts.acquisitionStartedAt.getTime()) &&
        solutionRow &&
        verdictRow
      ) {
        return {
          networkRow: {
            sha256: networkRow.sha256,
            artifactType: networkRow.artifactType,
            envelopeCid: networkRow.envelopeCid,
            source: networkRow.source,
            sourceOperator: networkRow.sourceOperator,
            sourceEndpoint: networkRow.sourceEndpoint,
            paidAmountUsdc: networkRow.paidAmountUsdc,
            fetchedAt: networkRow.fetchedAt,
            lastUsedAt: networkRow.lastUsedAt,
          },
          solution: {
            sha256: solutionRow.sha256,
            artifactType: solutionRow.artifactType,
            envelopeCid: solutionRow.envelopeCid,
            createdAt: solutionRow.createdAt,
          },
          verdict: {
            sha256: verdictRow.sha256,
            artifactType: verdictRow.artifactType,
            envelopeCid: verdictRow.envelopeCid,
            createdAt: verdictRow.createdAt,
          },
        };
      }
    } finally {
      store.close();
    }
    await boundedPollSleep(opts.deadline, opts.pollMs);
  }
  fail('consumer_solve_evaluate_timeout', 'Consumer did not produce IPFS network cache, SWE solution, and SWE evaluator verdict before timeout.', {
    sha256: opts.proof.artifact.sha256,
    envelopeCid: opts.proof.artifact.envelopeCid,
    sourceCid: opts.proof.sourceCid,
    allowedTaskId: opts.allowedTaskId,
    acquisitionStartedAt: opts.acquisitionStartedAt.toISOString(),
    acquisitionFinishedAt: opts.acquisitionFinishedAt.toISOString(),
    requiredArtifacts: [SWE_SOLUTION_ARTIFACT_TYPE, ...VERDICT_ARTIFACT_TYPES],
  });
}

function printHelp(): void {
  console.log(`Usage: yarn release:donation-consumption [options]

Strict release gate for cross-operator donated SWE execution data consumption.

Options:
  --producer-config <path>   Producer config (default: ~/.jinn-client/config.json)
  --consumer-config <path>   Consumer config (default: <consumer-home>/.jinn-client/config.json)
  --producer-url <url>       Producer daemon URL (default from producer apiPort)
  --producer-ui-token <tok>  Producer UI token for /v1/operator/artifacts
  --producer-handshake-key <k>
                             Exchange daemon handshake key for producer UI auth
  --consumer-url <url>       Attach to an existing consumer daemon instead of starting one
  --consumer-home <path>     Isolated consumer HOME (default: client/.acceptance/donation-consumer)
  --consumer-codex-home <p>  Codex auth/config home for the consumer harness
                             (default: CODEX_HOME or ~/.codex when auth.json exists)
  --consumer-port <port>     Consumer daemon port when started by this script (default: 7333)
  --timeout-ms <ms>          Gate timeout (default: 1800000)
  --poll-ms <ms>             Poll interval (default: 10000)
  --evidence-dir <path>      Evidence output directory
  --reuse-existing           Diagnostics only: allow pre-existing artifacts
  --help                     Show this help

Release mode requires fresh producer, consumer cache, solution, and evaluator
evidence created after this command starts. --reuse-existing is not valid
release evidence. The consumer must be joined to SWE-rebench v2 as solver and
evaluator with the SWE runtime enabled; the default isolated consumer config
inherits that SolverNet selection from the producer config while keeping a
separate HOME, DB, Safe, and agent identity. The Codex harness still requires
a real Codex/OpenAI credential via OPENAI_API_KEY or a usable CODEX_HOME.
`);
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      'producer-config': { type: 'string' },
      'consumer-config': { type: 'string' },
      'producer-url': { type: 'string' },
      'producer-ui-token': { type: 'string' },
      'producer-handshake-key': { type: 'string' },
      'consumer-url': { type: 'string' },
      'consumer-home': { type: 'string' },
      'consumer-codex-home': { type: 'string' },
      'consumer-port': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'poll-ms': { type: 'string' },
      'evidence-dir': { type: 'string' },
      'reuse-existing': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (parsed.values.help) {
    printHelp();
    return;
  }

  if (!existsSync(jinnBinPath) || !existsSync(mcpServerPath)) {
    fail('release_gate_not_built', 'Donation consumption gate must run from a built client package.', {
      missing: [
        ...(!existsSync(jinnBinPath) ? [jinnBinPath] : []),
        ...(!existsSync(mcpServerPath) ? [mcpServerPath] : []),
      ],
      remedy: 'Run `yarn build` before `yarn release:donation-consumption`, or run this command from the published package.',
    });
  }

  const startedAt = new Date();
  const timeoutMs = asInt(parsed.values['timeout-ms'], 30 * 60 * 1000);
  const pollMs = asInt(parsed.values['poll-ms'], 10_000);
  const deadline = Date.now() + timeoutMs;
  const reuseExisting = Boolean(parsed.values['reuse-existing']);
  const evidenceDir = resolve(
    parsed.values['evidence-dir']
      ?? join(clientRoot, 'acceptance-runs', `${nowSlug(startedAt)}-donation-consumption`),
  );
  mkdirSync(evidenceDir, { recursive: true });

  const producerConfigPath = resolveConfigPath(parsed.values['producer-config']);
  const producerConfig = loadLocalConfig(producerConfigPath);
  const producerHome = dirname(dirname(producerConfigPath));
  const producerPort = configApiPort(producerConfig, 7331);
  const producerUrl = parsed.values['producer-url'] ?? `http://127.0.0.1:${producerPort}`;
  const producerUiToken = asString(parsed.values['producer-ui-token'])
    ?? process.env['JINN_DONATION_PRODUCER_UI_TOKEN']?.trim();
  const producerHandshakeKey = asString(parsed.values['producer-handshake-key'])
    ?? process.env['JINN_DONATION_PRODUCER_HANDSHAKE_KEY']?.trim();
  const producerAuth = await resolveProducerAuth({
    producerUrl,
    producerUiToken,
    producerHandshakeKey,
  });
  const indexerUrl = asString(
    (producerConfig.discovery as Record<string, unknown> | undefined)?.url as string | undefined,
  ) ?? DEFAULT_TESTNET_DISCOVERY_URL;
  const ipfsGatewayUrl = asString(producerConfig.ipfsGatewayUrl) ?? DEFAULT_IPFS_GATEWAY_URL;
  const chainId = producerConfig.network === 'mainnet' ? 8453 : 84532;
  const producerRpcUrl = asString(producerConfig.rpcUrl) ?? defaultRpcUrlForChain(chainId);
  const corpusFromBlock = Number(DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[chainId] ?? 0n);
  const identityRegistryAddress = DEFAULT_IDENTITY_REGISTRY_BY_CHAIN_ID[chainId];

  const consumerHome = resolve(parsed.values['consumer-home'] ?? join(clientRoot, '.acceptance', 'donation-consumer'));
  const consumerCodexHome = resolveConsumerCodexHome(parsed.values['consumer-codex-home']);
  assertConsumerCodexAuthAvailable(consumerCodexHome);
  const consumerPort = asInt(parsed.values['consumer-port'], 7333);
  const consumerConfigPath = resolve(
    parsed.values['consumer-config'] ?? join(defaultClientHome(consumerHome), 'config.json'),
  );
  const attachConsumerUrl = parsed.values['consumer-url'];
  const envToken = process.env['JINN_DONATION_CONSUMER_DAEMON_API_TOKEN']?.trim() || process.env['DAEMON_API_TOKEN']?.trim();
  if (attachConsumerUrl && !envToken) {
    fail('consumer_token_required', 'Attached consumer daemon requires JINN_DONATION_CONSUMER_DAEMON_API_TOKEN or DAEMON_API_TOKEN.', {
      consumerUrl: attachConsumerUrl,
    });
  }
  const consumerApiToken = envToken || `donation-${randomBytes(24).toString('hex')}`;
  const consumerUrl = attachConsumerUrl ?? `http://127.0.0.1:${consumerPort}`;

  if (!parsed.values['consumer-config']) {
    const consumerConfig = buildConsumerConfig({
      producerConfig,
      consumerHome,
      consumerPort,
      indexerUrl,
      ipfsGatewayUrl,
    });
    writeJson(consumerConfigPath, consumerConfig);
  }
  let consumerConfig = loadLocalConfig(consumerConfigPath);
  const consumerDbPath = configDbPath(consumerConfig, consumerHome);
  const consumerEarningDir = configEarningDir(consumerConfig, consumerHome);
  const archivedConsumerDb = (!attachConsumerUrl && !parsed.values['consumer-config'] && !reuseExisting)
    ? archiveManagedConsumerDb(consumerDbPath, evidenceDir)
    : [];
  assertConsumerConfiguredForSwe(consumerConfig, consumerConfigPath);
  const consumerEvaluatorStatePath = ensureConsumerSweEvaluatorState({
    producerConfig,
    producerHome,
    consumerConfig,
    consumerHome,
    evidenceDir,
  });

  writeJson(join(evidenceDir, 'inputs.json'), {
    startedAt: startedAt.toISOString(),
    timeoutMs,
    pollMs,
    reuseExisting,
    releaseEvidence: !reuseExisting,
    producerConfigPath,
    producerHome,
    producerUrl,
    producerAuth: producerAuth.headers ? '<configured>' : '<none>',
    consumerConfigPath,
    consumerUrl,
    consumerHome,
    consumerCodexHome: consumerCodexHome ?? '<OPENAI_API_KEY>',
    consumerDbPath,
    archivedConsumerDb,
    consumerEarningDir,
    consumerEvaluatorStatePath,
    indexerUrl,
    ipfsGatewayUrl,
  });

  console.log(`[donation-consumption] evidence: ${evidenceDir}`);
  console.log('[donation-consumption] waiting for producer donated SWE artifact');
  const producerArtifact = await waitForProducerArtifact({
    producerUrl,
    startedAt,
    deadline,
    reuseExisting,
    pollMs,
    producerAuth,
  });
  console.log('[donation-consumption] verifying producer IPFS envelope and canonical index visibility');
  const donationProof = await verifyDonatedEnvelope(
    producerArtifact,
    ipfsGatewayUrl,
    { indexerUrl, rpcUrl: producerRpcUrl, chainId },
    deadline,
    pollMs,
  );
  writeJson(join(evidenceDir, 'producer-proof.json'), {
    artifact: donationProof.artifact,
    sourceCid: donationProof.sourceCid,
    trajectorySourceCid: donationProof.trajectorySourceCid,
    indexExecution: donationProof.indexExecution,
  });
  writeJson(join(evidenceDir, 'producer-envelope-redacted.json'), donationProof.redactedEnvelope);

  const allowedConsumerTaskId = await scopeConsumerConfigToProducerTask({
    consumerConfig,
    consumerConfigPath,
    proof: donationProof,
    indexerUrl,
    evidenceDir,
  });
  consumerConfig = loadLocalConfig(consumerConfigPath);
  console.log(`[donation-consumption] scoped consumer task discovery to producer task ${allowedConsumerTaskId}`);

  let consumerProcess: ChildProcess | null = null;
  if (!attachConsumerUrl) {
    console.log('[donation-consumption] running consumer funding preflight');
    runFundingPreflight(consumerConfigPath, consumerHome, consumerApiToken, evidenceDir, consumerCodexHome);
    console.log('[donation-consumption] starting isolated consumer daemon');
    consumerProcess = startConsumerDaemon({
      configPath: consumerConfigPath,
      home: consumerHome,
      apiToken: consumerApiToken,
      evidenceDir,
      codexHome: consumerCodexHome,
    });
  }
  try {
    await waitForStatus({
      baseUrl: consumerUrl,
      deadline,
      pollMs,
      consumerProcess,
      evidenceDir,
    });

    console.log('[donation-consumption] checking consumer MCP discovery');
    const searchResult = await callMcpTool({
      name: 'search_records',
      args: {
        solverType: 'swe-rebench-v2.v1',
        role: 'solution',
        artifactType: SWE_SOLUTION_ARTIFACT_TYPE,
        limit: 50,
      },
      storePath: consumerDbPath,
      daemonApiUrl: consumerUrl,
      daemonApiToken: consumerApiToken,
      indexerUrl,
      ipfsGatewayUrl,
      rpcUrl: asString(consumerConfig.rpcUrl) ?? producerRpcUrl,
      chainId,
      identityRegistryAddress,
      fromBlock: corpusFromBlock,
    });
    writeJson(join(evidenceDir, 'consumer-search-records.json'), searchResult);
    const discoveredArtifact = findDonatedArtifactRecord(searchResult, donationProof);
    const acquisitionArgs = acquisitionArgsFromArtifact(discoveredArtifact);
    writeJson(join(evidenceDir, 'consumer-discovered-artifact.json'), discoveredArtifact);

    console.log('[donation-consumption] acquiring donated artifact through consumer MCP');
    const acquisitionStartedAt = new Date();
    const acquireResult = await callMcpTool({
      name: 'acquire_artifact',
      args: acquisitionArgs,
      storePath: consumerDbPath,
      daemonApiUrl: consumerUrl,
      daemonApiToken: consumerApiToken,
      indexerUrl,
      ipfsGatewayUrl,
      rpcUrl: asString(consumerConfig.rpcUrl) ?? producerRpcUrl,
      chainId,
      identityRegistryAddress,
      fromBlock: corpusFromBlock,
    });
    const acquisitionFinishedAt = new Date();
    writeJson(join(evidenceDir, 'consumer-acquire-artifact.json'), {
      ...acquireResult,
      bytes: '<redacted>',
      acquisitionStartedAt: acquisitionStartedAt.toISOString(),
      acquisitionFinishedAt: acquisitionFinishedAt.toISOString(),
    });
    if (acquireResult.error) {
      fail('consumer_acquire_failed', 'Consumer MCP acquire_artifact failed.', acquireResult);
    }
    if (acquireResult.sha256 !== donationProof.artifact.sha256) {
      fail('consumer_acquire_wrong_artifact', 'Consumer MCP acquire_artifact returned the wrong sha256.', {
        expected: donationProof.artifact.sha256,
        actual: acquireResult.sha256,
      });
    }
    if (!reuseExisting && acquireResult.source !== 'ipfs') {
      fail('consumer_acquire_not_ipfs', 'Release-mode acquire_artifact did not fetch from the donated IPFS source.', {
        expected: 'ipfs',
        actual: acquireResult.source,
      });
    }
    if (acquireResult.paidAmountUsdc !== '0') {
      fail('consumer_acquire_not_free', 'Donated IPFS acquisition must be free for this release gate.', {
        paidAmountUsdc: acquireResult.paidAmountUsdc,
      });
    }

    console.log('[donation-consumption] waiting for consumer solve/evaluator evidence after acquisition');
    const liveProof = await waitForConsumerSolveAndEvaluatorProof({
      storePath: consumerDbPath,
      proof: donationProof,
      allowedTaskId: allowedConsumerTaskId,
      startedAt,
      acquisitionStartedAt,
      acquisitionFinishedAt,
      reuseExisting,
      deadline,
      pollMs,
    });
    writeJson(join(evidenceDir, 'consumer-network-artifact.json'), liveProof.networkRow);
    writeJson(join(evidenceDir, 'consumer-solution-artifact.json'), liveProof.solution);
    writeJson(join(evidenceDir, 'consumer-evaluator-verdict.json'), liveProof.verdict);

    const summary = {
      ok: true,
      releaseEvidence: !reuseExisting,
      evidenceDir,
      producerArtifact: donationProof.artifact,
      sourceCid: donationProof.sourceCid,
      trajectorySourceCid: donationProof.trajectorySourceCid,
      allowedConsumerTaskId,
      acquisitionStartedAt: acquisitionStartedAt.toISOString(),
      acquisitionFinishedAt: acquisitionFinishedAt.toISOString(),
      consumerNetworkArtifact: liveProof.networkRow,
      consumerSolution: liveProof.solution,
      consumerVerdict: liveProof.verdict,
    };
    writeJson(join(evidenceDir, 'summary.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (consumerProcess) {
      await stopManagedConsumerDaemon({
        child: consumerProcess,
        configPath: consumerConfigPath,
        home: consumerHome,
        apiToken: consumerApiToken,
        evidenceDir,
        codexHome: consumerCodexHome,
      });
    }
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  const current = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entrypoint) === realpathSync(current);
  } catch {
    return resolve(entrypoint) === current;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    if (err instanceof GateFailure) {
      console.error(`[donation-consumption] FAILED ${err.code}: ${err.message}`);
      console.error(JSON.stringify(err.details, null, 2));
      process.exit(1);
    }
    console.error('[donation-consumption] FAILED unexpected error');
    console.error(err);
    process.exit(1);
  });
}
