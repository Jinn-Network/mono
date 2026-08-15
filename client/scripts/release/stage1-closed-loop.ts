/**
 * Stage-1 closed-loop drain runbook step 4 — real Base Sepolia two-operator loop:
 * claim → mech Deliver → claimSolutionDelivery → verdict on the second operator.
 *
 * Uses gold homes `~/jinn-dev/operators/op-c` (evaluator/producer) and `op-d`
 * (solver) via temporary copies so gold configs are never mutated.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveUiToken } from '../../src/cli/daemon-control-client.js';
import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  keccak256,
  toBytes,
  type Hex,
  type Log,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  buildGammaMarketFixture,
  buildPredictionSmokeTaskSpec,
} from './olas-rails-smoke.js';
import { copyTree, goldPath } from './substrate-paths.js';
import { JINN_ROUTER_ABI } from '../../src/adapters/mech/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(clientRoot, '..');
const jinnBin = join(clientRoot, 'dist/bin/jinn.js');

const DEFAULT_MANIFEST_CID = 'bafkreihifplza3hmixqgp4x7yjrpk2rhwzkm72hk2ampfviuthd7asvi34';
const ROUTER_ADDRESS = '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247' as const;
const DEFAULT_RPC = 'https://base-sepolia.publicnode.com';
/** Prefer non-archive-gated endpoints for eth_getLogs (publicnode rejects archive ranges). */
const OBSERVER_RPCS = [
  'https://sepolia.base.org',
  'https://base-sepolia.gateway.tenderly.co/15b0C3dTipsUOekY0Fmuia',
  DEFAULT_RPC,
] as const;
/** Producer + evaluator — agent still owns the Safe (op-a/op-b Safes are distributor-owned). */
const EVALUATOR_OP = 'op-c';
/** Solver — live post-migration fleet (services 72/73) staged under operators/op-d. */
const SOLVER_OP = 'op-d';
const EVALUATOR_PORT = 7350;
const SOLVER_PORT = 7351;
const DEFAULT_GAMMA_PORT = 7389;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;
const GETLOGS_CHUNK_BLOCKS = 400n;
const GETLOGS_RETRY_ATTEMPTS = 4;
const GETLOGS_RETRY_BASE_MS = 800;

const ROUTER_WATCH_EVENTS = JINN_ROUTER_ABI.filter(
  (item) =>
    item.type === 'event' &&
    (item.name === 'SolutionDeliveryClaimed' || item.name === 'VerdictDeliveryClaimed'),
);

const EVIDENCE_DIR = join(repoRoot, '.local/stage1-closed-loop');
const EVIDENCE_PATH = join(EVIDENCE_DIR, 'evidence.json');

interface CliOptions {
  execute: boolean;
  runSlug: string;
  gammaPort: number;
  timeoutMs: number;
  pollMs: number;
}

interface TempOperatorHome {
  opName: string;
  home: string;
  apiPort: number;
}

interface SolutionDelivery {
  taskId: string;
  operator: string;
  requestId: string;
  txHash: string;
  blockNumber: number;
}

interface VerdictDelivery {
  taskId: string;
  evaluator: string;
  requestId: string;
  verdictCode: number;
  txHash: string;
  blockNumber: number;
}

type RouterPublicClient = ReturnType<typeof createPublicClient>;

function defaultRunSlug(nowMs = Date.now()): string {
  return String(nowMs);
}

function manifestDigestHex(manifestCid: string): Hex {
  return keccak256(toBytes(manifestCid));
}

export function buildStage1ClosedLoopTaskSpec(runSlug: string) {
  const base = buildPredictionSmokeTaskSpec({ runSlug });
  return {
    ...base,
    claimPolicy: {
      ...base.claimPolicy,
      allowSolverSelfEvaluation: false,
    },
  };
}

function parseCli(): CliOptions {
  const parsed = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      'run-slug': { type: 'string' },
      'gamma-port': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'poll-ms': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    printHelp();
    process.exit(0);
  }

  const nowMs = Date.now();
  return {
    execute: parsed.values.execute,
    runSlug: parsed.values['run-slug'] ?? defaultRunSlug(nowMs),
    gammaPort: toInt(parsed.values['gamma-port'], DEFAULT_GAMMA_PORT),
    timeoutMs: toInt(parsed.values['timeout-ms'], DEFAULT_TIMEOUT_MS),
    pollMs: toInt(parsed.values['poll-ms'], DEFAULT_POLL_MS),
  };
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got '${value}'`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: yarn stage1:closed-loop [--execute] [options]

Drain runbook step 4 — two-operator Base Sepolia closed loop
(${EVALUATOR_OP} evaluator/producer, ${SOLVER_OP} solver). Default mode is dry-run.

Gold note: op-a/op-b Safes are stOLAS-distributor-owned (GS026 on submit). Use
operators whose agent EOA still owns the Safe (op-c + op-d staged from ~/.jinn-client).

Options:
  --execute                 Run the full loop (daemons, submit, on-chain observe)
  --run-slug <slug>         Temp dir + task id suffix (default epoch ms)
  --gamma-port <port>       Local Polymarket Gamma fixture port (default ${DEFAULT_GAMMA_PORT})
  --timeout-ms <ms>         Wall-clock timeout (default ${DEFAULT_TIMEOUT_MS})
  --poll-ms <ms>            Status / on-chain poll interval (default ${DEFAULT_POLL_MS})
`);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function ensureBuiltBinary(): void {
  if (existsSync(jinnBin)) return;
  console.log('[stage1-closed-loop] dist/bin/jinn.js missing — running yarn build…');
  const result = spawnSync('yarn', ['build'], {
    cwd: clientRoot,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if ((result.status ?? 1) !== 0 || !existsSync(jinnBin)) {
    throw new Error(
      'client/dist/bin/jinn.js is missing. Run `cd client && yarn build` first.',
    );
  }
}

function startGammaFixture(port: number): Promise<{ server: Server; url: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const match = requestUrl.pathname.match(/^\/markets\/([^/]+)$/);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const marketId = decodeURIComponent(match[1]!);
    const body = buildGammaMarketFixture({
      marketId,
      conditionId: `0x${marketId}`,
      outcome: 'YES',
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

function isFleetLoopReady(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false;
  const fleet = (status as { fleet?: unknown }).fleet;
  if (!fleet || typeof fleet !== 'object') return false;
  const f = fleet as {
    completeCount?: unknown;
    complete?: unknown;
    services?: Array<{ mechAddress?: unknown; step?: unknown }>;
  };
  // Full /v1/status exposes completeCount; rollup exposes complete.
  const complete =
    typeof f.completeCount === 'number'
      ? f.completeCount
      : typeof f.complete === 'number'
        ? f.complete
        : 0;
  if (complete < 1) return false;
  const services = Array.isArray(f.services) ? f.services : [];
  return services.some(
    (s) =>
      typeof s.mechAddress === 'string' &&
      s.mechAddress.length > 0 &&
      (s.step === 'complete' || s.step === 'safe_binding_pending'),
  );
}

async function fetchStatus(port: number): Promise<unknown | null> {
  try {
    // /v1/status is operator-class as of spec §14.5 (issue #2404) — send the
    // on-disk UI token via the shared resolver (cli/daemon-control-client.ts),
    // or a real daemon returns a permanent 401 this poll loop would otherwise
    // read as "not ready yet" and time out on.
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { 'x-jinn-ui-token': resolveUiToken() ?? '' },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForStatus(port: number, opts: { timeoutMs: number; pollMs: number }): Promise<unknown> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetchStatus(port);
    if (status && isFleetLoopReady(status)) return status;
    await sleep(opts.pollMs);
  }
  throw new Error(
    `Timed out waiting for complete Safe+mech fleet on port ${port} (HTTP status alone is not enough — bootstrap must finish)`,
  );
}

async function prepareTempHome(args: {
  opName: string;
  apiPort: number;
  runSlug: string;
  role: 'evaluator' | 'solver';
  manifestCid: string;
  digest: Hex;
}): Promise<TempOperatorHome> {
  const goldHome = goldPath(args.opName);
  const goldJinnClient = join(goldHome, '.jinn-client');
  if (!existsSync(goldJinnClient)) {
    throw new Error(`Gold operator ${args.opName} missing ${goldJinnClient}`);
  }

  const home = join(os.tmpdir(), `jinn-stage1-closed-loop-${args.runSlug}`, args.opName);
  const jinnClientDir = join(home, '.jinn-client');
  await copyTree(goldJinnClient, jinnClientDir);

  // Drop stale runtime files and generator state from gold copies — creator
  // loops against retired Safes (GS026) drown the claim path in noise.
  for (const stale of ['daemon.pid', 'bootstrap-error.json']) {
    const p = join(jinnClientDir, 'earning', stale);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  const solvernetsDir = join(jinnClientDir, 'earning', 'solvernets');
  if (existsSync(solvernetsDir)) rmSync(solvernetsDir, { recursive: true, force: true });
  // Fresh engagement / venue ledgers — a prior gate that admitted then failed
  // (e.g. GS026) leaves rows stuck at `intended` / `already-engaged`.
  for (const staleDb of ['jinn.db', 'jinn.db-shm', 'jinn.db-wal']) {
    const p = join(jinnClientDir, staleDb);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  const venueDir = join(jinnClientDir, 'venue');
  if (existsSync(venueDir)) rmSync(venueDir, { recursive: true, force: true });
  const engineDir = join(jinnClientDir, 'engine');
  if (existsSync(engineDir)) rmSync(engineDir, { recursive: true, force: true });
  const evidenceDir = join(jinnClientDir, 'evidence');
  if (existsSync(evidenceDir)) rmSync(evidenceDir, { recursive: true, force: true });

  const configPath = join(jinnClientDir, 'config.json');
  const base = readJson(configPath);
  const rpcUrl = base['rpcUrl'] ?? DEFAULT_RPC;
  // Strip posting / legacy solverNets so only the closed-loop wiring runs.
  delete base['posting'];
  delete base['solverNets'];
  delete base['tasks'];
  base['predictionV1CadenceMs'] = 0;
  base['evictionCheckIntervalMs'] = 0;

  if (args.role === 'solver') {
    writeJson(configPath, {
      ...base,
      network: 'testnet',
      apiPort: args.apiPort,
      rpcUrl,
      configShapeVersion: 2,
      claimPolicy: { mode: 'match-legacy-manifest-digest' },
      executionWiring: [
        {
          workKind: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          model: 'claude-haiku-4-5-20251001',
          plugins: [],
          credentialRef: 'prediction-v1-baseline-default',
          isolationPolicy: 'process',
          legacyManifestDigest: args.digest,
        },
      ],
      joinedSolverNets: {
        [args.manifestCid]: {
          manifestCid: args.manifestCid,
          name: 'prediction',
          roles: ['solver'],
          harness: 'prediction-v1-baseline',
          model: 'claude-haiku-4-5-20251001',
          contract: { id: 'prediction', version: 'v1' },
          solverType: 'prediction.v1',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    });
  } else {
    writeJson(configPath, {
      ...base,
      network: 'testnet',
      apiPort: args.apiPort,
      rpcUrl,
      configShapeVersion: 2,
      // Evaluator must claim evaluation jobs for the verdict leg.
      claimPolicy: { mode: 'match-legacy-manifest-digest' },
      executionWiring: [],
      joinedSolverNets: {
        [args.manifestCid]: {
          manifestCid: args.manifestCid,
          name: 'prediction',
          roles: ['evaluator'],
          harness: 'prediction-v1-evaluator',
          contract: { id: 'prediction', version: 'v1' },
          solverType: 'prediction.v1',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    });
  }

  return { opName: args.opName, home, apiPort: args.apiPort };
}

async function spawnDaemon(args: {
  home: TempOperatorHome;
  gammaUrl: string;
  logPath: string;
}): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: args.home.home,
    JINN_API_PORT: String(args.home.apiPort),
    JINN_POLYMARKET_GAMMA_BASE_URL: args.gammaUrl,
    // Gold ops still sit on a deprecated Base Sepolia staking proxy. Migrating
    // them mid-gate archives the live Safe+mech and fails agent_already_bound.
    JINN_SKIP_TESTNET_SETUP_MIGRATION: '1',
    // GLiNER ONNX download blocks the event loop for minutes on a cold cache.
    JINN_CAPTURES_PII_DETECTION_ENABLED: '0',
  };
  delete env['JINN_PASSWORD'];

  ensureDir(dirname(args.logPath));
  const logStream = createWriteStream(args.logPath, { flags: 'a' });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    logStream.once('open', () => resolveOpen());
    logStream.once('error', rejectOpen);
  });

  const child = spawn('node', [jinnBin, 'run'], {
    cwd: clientRoot,
    env,
    stdio: ['ignore', logStream, logStream],
  });
  child.once('exit', (code, signal) => {
    logStream.write(`\n[stage1-closed-loop] ${args.home.opName} daemon exited code=${code} signal=${signal}\n`);
    logStream.end();
  });
  return child;
}

async function submitTask(args: {
  evaluatorHome: string;
  taskId: string;
  specFile: string;
  manifestCid: string;
}): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: args.evaluatorHome,
    JINN_SKIP_TESTNET_SETUP_MIGRATION: '1',
  };
  delete env['JINN_PASSWORD'];

  const result = spawnSync(
    'node',
    [
      jinnBin,
      'tasks',
      'submit',
      '--yes',
      '--json',
      '--id',
      args.taskId,
      '--description',
      'Stage 1 closed-loop gate',
      '--solver-type',
      'prediction.v1',
      '--manifest-cid',
      args.manifestCid,
      '--spec-file',
      args.specFile,
      '--max-claims',
      '5',
      '--required-verdicts',
      '1',
    ],
    { cwd: clientRoot, env, encoding: 'utf8', stdio: 'pipe' },
  );

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  writeFileSync(join(EVIDENCE_DIR, 'submit.stdout'), stdout, 'utf8');
  writeFileSync(join(EVIDENCE_DIR, 'submit.stderr'), stderr, 'utf8');

  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `jinn tasks submit exited ${result.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  let parsed: Record<string, unknown> | undefined;
  for (const line of stdout.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // keep scanning
    }
  }

  if (!parsed) {
    const numeric = stdout.match(/\btaskId[:\s]+(\d+)\b/i) ?? stdout.match(/\bon-chain task id[:\s]+(\d+)\b/i);
    if (numeric?.[1]) return numeric[1];
    throw new Error(`jinn tasks submit produced no parseable taskId. stdout:\n${stdout}`);
  }

  if (typeof parsed['code'] === 'string' && parsed['taskId'] === undefined) {
    throw new Error(
      `jinn tasks submit error: ${parsed['code']} — ${String(parsed['message'] ?? '')}`,
    );
  }

  const taskId = parsed['taskId'];
  if (typeof taskId === 'string' && taskId.length > 0) return taskId;
  if (typeof taskId === 'number') return String(taskId);

  throw new Error(`jinn tasks submit JSON has no taskId: ${JSON.stringify(parsed)}`);
}

function createRouterClient(): RouterPublicClient {
  return createPublicClient({
    chain: baseSepolia,
    transport: fallback(
      OBSERVER_RPCS.map((url) => http(url)),
      { rank: false },
    ),
  });
}

async function scanRouterEvents<T>(args: {
  client: RouterPublicClient;
  routerAddress: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  pick: (eventName: string, evArgs: Record<string, unknown>, log: Log) => T | null;
}): Promise<T[]> {
  const out: T[] = [];
  for (
    let start = args.fromBlock;
    start <= args.toBlock;
    start += GETLOGS_CHUNK_BLOCKS + 1n
  ) {
    const end =
      start + GETLOGS_CHUNK_BLOCKS > args.toBlock
        ? args.toBlock
        : start + GETLOGS_CHUNK_BLOCKS;
    let logs: Log[] = [];
    for (let attempt = 1; ; attempt++) {
      try {
        logs = await args.client.getLogs({
          address: args.routerAddress,
          events: ROUTER_WATCH_EVENTS,
          fromBlock: start,
          toBlock: end,
        });
        break;
      } catch (err) {
        if (attempt >= GETLOGS_RETRY_ATTEMPTS) throw err;
        await sleep(GETLOGS_RETRY_BASE_MS * attempt);
      }
    }
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: JINN_ROUTER_ABI,
          data: log.data,
          topics: log.topics,
        });
        const picked = args.pick(
          decoded.eventName,
          decoded.args as Record<string, unknown>,
          log,
        );
        if (picked !== null) out.push(picked);
      } catch {
        // not a router event we recognise
      }
    }
  }
  return out;
}

async function findSolutionDelivery(args: {
  client: RouterPublicClient;
  fromBlock: bigint;
  taskId: string;
}): Promise<SolutionDelivery | null> {
  const toBlock = await args.client.getBlockNumber();
  const matches = await scanRouterEvents<SolutionDelivery>({
    client: args.client,
    routerAddress: ROUTER_ADDRESS,
    fromBlock: args.fromBlock,
    toBlock,
    pick: (eventName, evArgs, log) => {
      if (eventName !== 'SolutionDeliveryClaimed') return null;
      if (String(evArgs['taskId']) !== args.taskId) return null;
      return {
        taskId: args.taskId,
        operator: String(evArgs['operator']).toLowerCase(),
        requestId: String(evArgs['requestId']),
        txHash: log.transactionHash ?? '',
        blockNumber: Number(log.blockNumber ?? 0n),
      };
    },
  });
  return matches[0] ?? null;
}

async function findVerdictDelivery(args: {
  client: RouterPublicClient;
  fromBlock: bigint;
  taskId: string;
}): Promise<VerdictDelivery | null> {
  const toBlock = await args.client.getBlockNumber();
  const matches = await scanRouterEvents<VerdictDelivery>({
    client: args.client,
    routerAddress: ROUTER_ADDRESS,
    fromBlock: args.fromBlock,
    toBlock,
    pick: (eventName, evArgs, log) => {
      if (eventName !== 'VerdictDeliveryClaimed') return null;
      if (String(evArgs['taskId']) !== args.taskId) return null;
      return {
        taskId: args.taskId,
        evaluator: String(evArgs['evaluator']).toLowerCase(),
        requestId: String(evArgs['requestId']),
        verdictCode: Number(evArgs['verdictCode']),
        txHash: log.transactionHash ?? '',
        blockNumber: Number(log.blockNumber ?? 0n),
      };
    },
  });
  return matches[0] ?? null;
}

async function waitForClosedLoop(args: {
  client: RouterPublicClient;
  fromBlock: bigint;
  taskId: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<{ solution: SolutionDelivery; verdict: VerdictDelivery }> {
  const deadline = Date.now() + args.timeoutMs;
  let solution: SolutionDelivery | null = null;
  while (Date.now() < deadline) {
    if (solution === null) {
      solution = await findSolutionDelivery({
        client: args.client,
        fromBlock: args.fromBlock,
        taskId: args.taskId,
      });
      if (solution !== null) {
        console.log(
          `[stage1-closed-loop] SolutionDeliveryClaimed operator=${solution.operator} tx=${solution.txHash}`,
        );
      }
    }
    const verdict = await findVerdictDelivery({
      client: args.client,
      fromBlock: args.fromBlock,
      taskId: args.taskId,
    });
    if (verdict !== null) {
      console.log(
        `[stage1-closed-loop] VerdictDeliveryClaimed evaluator=${verdict.evaluator} code=${verdict.verdictCode} tx=${verdict.txHash}`,
      );
      if (solution !== null) return { solution, verdict };
    }
    await sleep(args.pollMs);
  }
  throw new Error(
    `Timed out waiting for on-chain solution+verdict for taskId=${args.taskId}`,
  );
}

function printDryRunPlan(opts: CliOptions, digest: Hex): void {
  const tempRoot = join(os.tmpdir(), `jinn-stage1-closed-loop-${opts.runSlug}`);
  const taskId = `stage1-gate-${opts.runSlug}`;
  console.log(JSON.stringify({
    mode: 'dry-run',
    manifestCid: DEFAULT_MANIFEST_CID,
    legacyManifestDigest: digest,
    router: ROUTER_ADDRESS,
    goldOperators: { evaluator: goldPath(EVALUATOR_OP), solver: goldPath(SOLVER_OP) },
    tempRoot,
    evaluator: { home: join(tempRoot, EVALUATOR_OP), apiPort: EVALUATOR_PORT },
    solver: { home: join(tempRoot, SOLVER_OP), apiPort: SOLVER_PORT },
    gammaUrl: `http://127.0.0.1:${opts.gammaPort}`,
    taskId,
    evidencePath: EVIDENCE_PATH,
    next: 'Re-run with --execute to run the closed loop.',
  }, null, 2));
}

async function executeClosedLoop(opts: CliOptions): Promise<void> {
  ensureBuiltBinary();
  ensureDir(EVIDENCE_DIR);

  const startedAt = new Date().toISOString();
  const digest = manifestDigestHex(DEFAULT_MANIFEST_CID);
  const taskId = `stage1-gate-${opts.runSlug}`;
  const specFile = join(EVIDENCE_DIR, `task-spec-${opts.runSlug}.json`);
  writeJson(specFile, buildStage1ClosedLoopTaskSpec(opts.runSlug));

  const evaluator = await prepareTempHome({
    opName: EVALUATOR_OP,
    apiPort: EVALUATOR_PORT,
    runSlug: opts.runSlug,
    role: 'evaluator',
    manifestCid: DEFAULT_MANIFEST_CID,
    digest,
  });
  const solver = await prepareTempHome({
    opName: SOLVER_OP,
    apiPort: SOLVER_PORT,
    runSlug: opts.runSlug,
    role: 'solver',
    manifestCid: DEFAULT_MANIFEST_CID,
    digest,
  });

  const gamma = await startGammaFixture(opts.gammaPort);
  let evaluatorDaemon: ChildProcess | null = null;
  let solverDaemon: ChildProcess | null = null;
  const tempRoot = join(os.tmpdir(), `jinn-stage1-closed-loop-${opts.runSlug}`);

  try {
    const bootTimeout = Math.min(opts.timeoutMs, 120_000);
    evaluatorDaemon = await spawnDaemon({
      home: evaluator,
      gammaUrl: gamma.url,
      logPath: join(EVIDENCE_DIR, `${EVALUATOR_OP}-daemon.log`),
    });
    solverDaemon = await spawnDaemon({
      home: solver,
      gammaUrl: gamma.url,
      logPath: join(EVIDENCE_DIR, `${SOLVER_OP}-daemon.log`),
    });

    await Promise.all([
      waitForStatus(EVALUATOR_PORT, { timeoutMs: bootTimeout, pollMs: opts.pollMs }),
      waitForStatus(SOLVER_PORT, { timeoutMs: bootTimeout, pollMs: opts.pollMs }),
    ]);
    console.log('[stage1-closed-loop] both daemons healthy');
    // Give projector / claim loops a beat after bootstrap before posting.
    await sleep(Math.min(opts.pollMs * 3, 15_000));

    const client = createRouterClient();
    const prePostBlock = await client.getBlockNumber();

    const onchainTaskId = await submitTask({
      evaluatorHome: evaluator.home,
      taskId,
      specFile,
      manifestCid: DEFAULT_MANIFEST_CID,
    });
    console.log(`[stage1-closed-loop] submitted on-chain taskId=${onchainTaskId}`);

    const observeTimeout = Math.max(60_000, opts.timeoutMs - (Date.now() - Date.parse(startedAt)));
    const { solution, verdict } = await waitForClosedLoop({
      client,
      fromBlock: prePostBlock > 1n ? prePostBlock - 1n : 0n,
      taskId: onchainTaskId,
      timeoutMs: observeTimeout,
      pollMs: opts.pollMs,
    });

    const evidence = {
      taskId: onchainTaskId,
      solution,
      verdict,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: true,
    };
    writeJson(EVIDENCE_PATH, evidence);
    console.log(JSON.stringify({ mode: 'execute', evidencePath: EVIDENCE_PATH, ok: true }, null, 2));
  } finally {
    await stopProcess(evaluatorDaemon);
    await stopProcess(solverDaemon);
    await new Promise<void>((resolvePromise) => gamma.server.close(() => resolvePromise()));
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

async function cliMain(): Promise<void> {
  const opts = parseCli();
  const digest = manifestDigestHex(DEFAULT_MANIFEST_CID);

  if (!opts.execute) {
    printDryRunPlan(opts, digest);
    return;
  }

  await executeClosedLoop(opts);
}

const entryArg = process.argv[1] ? resolve(process.argv[1]) : '';
const isDirectRun =
  Boolean(entryArg) &&
  (import.meta.url === `file://${entryArg}` ||
    import.meta.url.endsWith('/stage1-closed-loop.ts') ||
    import.meta.url.endsWith('/stage1-closed-loop.js'));

if (isDirectRun) {
  cliMain().catch((err) => {
    console.error(err);
    process.exitCode = 2;
  });
}
