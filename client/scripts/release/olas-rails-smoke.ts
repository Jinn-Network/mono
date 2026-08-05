import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveUiToken } from '../../src/cli/daemon-control-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(clientRoot, '..');

const DEFAULT_CONFIG = join(repoRoot, '.local/smoke-config.json');
const DEFAULT_SPEC_FILE = join(repoRoot, '.local/prediction-v1-smoke-task.json');
const DEFAULT_LOG_FILE = join(repoRoot, '.local/smoke-daemon.log');
const DEFAULT_EVIDENCE_DIR = join(repoRoot, '.local/olas-rails-smoke');
const DEFAULT_MANIFEST_CID = 'bafkreihifplza3hmixqgp4x7yjrpk2rhwzkm72hk2ampfviuthd7asvi34';
const DEFAULT_DAEMON_PORT = 7332;
const DEFAULT_GAMMA_PORT = 7388;
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;

type Outcome = 'YES' | 'NO';

interface SmokeTaskOptions {
  nowMs?: number;
  runSlug?: string;
}

interface GammaFixtureOptions {
  marketId: string;
  conditionId: string;
  outcome?: Outcome;
  nowMs?: number;
}

interface SmokeStatusSummary {
  shutdownState: string | null;
  activeTaskRuns: number | null;
  completed: number | null;
  failed: number | null;
  inFlightCount: number | null;
  solutions: number | null;
  verdicts: number | null;
  claimedStakingRewardsWei: string | null;
}

interface CliOptions {
  execute: boolean;
  configPath: string;
  specFile: string;
  evidenceDir: string;
  logFile: string;
  taskId: string;
  runSlug: string;
  daemonPort: number;
  gammaPort: number;
  timeoutMs: number;
  pollMs: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got '${value}'`);
  }
  return parsed;
}

function defaultRunSlug(nowMs = Date.now()): string {
  return String(nowMs);
}

export function buildPredictionSmokeTaskSpec(opts: SmokeTaskOptions = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const runSlug = opts.runSlug ?? defaultRunSlug(nowMs);
  const marketId = `jinn-local-smoke-${runSlug}`;
  const conditionId = `0x${marketId}`;
  const startTs = nowMs - 60_000;
  const endTs = nowMs + 60 * 60_000;

  return {
    solverType: 'prediction.v1',
    role: 'restoration',
    window: { startTs, endTs },
    claimPolicy: {
      mode: 'parallel',
      maxClaims: 25,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 1800,
    },
    spec: {
      question: {
        kind: 'binary',
        text: 'Will this tokenless OLAS smoke test complete successfully?',
        yesLabel: 'YES',
        noLabel: 'NO',
      },
      source: {
        type: 'prediction-market',
        venue: 'polymarket',
        url: `https://polymarket.com/event/${marketId}`,
        identifiers: {
          marketId,
          conditionId,
          yesTokenId: `yes-${marketId}`,
          noTokenId: `no-${marketId}`,
        },
      },
      resolution: {
        expectedResolutionTime: iso(nowMs + 24 * 60 * 60_000),
        rulesText: 'Local smoke only.',
        rulesUrl: `https://polymarket.com/event/${marketId}`,
        timezone: 'UTC',
      },
      consensusSnapshot: {
        sampledAt: iso(nowMs),
        probabilityYes: '0.6200',
        method: 'best-bid-ask-midpoint',
        bestBidYes: '0.6000',
        bestAskYes: '0.6400',
        spread: '0.0400',
        source: 'polymarket-clob',
      },
      eligibilitySnapshot: {
        sampledAt: iso(nowMs),
        timeToResolutionHours: 24,
        liquidityUsd: '10000',
        volume24hUsd: '2500',
        orderbookAgeSeconds: 0,
        selectionReason: 'local-tokenless-olas-smoke',
      },
    },
    eligibility: {
      dedupKey: `polymarket:${marketId}`,
    },
  };
}

export function buildGammaMarketFixture(opts: GammaFixtureOptions): Record<string, unknown> {
  const nowMs = opts.nowMs ?? Date.now();
  const outcome = opts.outcome ?? 'YES';
  const outcomePrices = outcome === 'YES' ? ['1', '0'] : ['0', '1'];
  return {
    id: opts.marketId,
    marketId: opts.marketId,
    conditionId: opts.conditionId,
    slug: opts.marketId,
    question: 'Will this tokenless OLAS smoke test complete successfully?',
    description: 'Local tokenless OLAS smoke fixture.',
    url: `https://polymarket.com/event/${opts.marketId}`,
    outcomes: JSON.stringify(['YES', 'NO']),
    clobTokenIds: JSON.stringify([`yes-${opts.marketId}`, `no-${opts.marketId}`]),
    outcomePrices: JSON.stringify(outcomePrices),
    active: false,
    closed: true,
    archived: false,
    winningOutcome: outcome,
    resolutionStatus: 'resolved',
    endDate: iso(nowMs - 1_000),
    endDateIso: iso(nowMs - 1_000),
    resolvedAt: iso(nowMs),
    updatedAt: iso(nowMs),
    liquidity: '10000',
    volume24hr: '2500',
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function summarizeSmokeStatus(raw: unknown): SmokeStatusSummary {
  const root = record(raw);
  const daemon = record(root['daemon']);
  const rewards = record(root['rewards']);
  const taskRuns = record(root['taskRuns']);
  const taskTotals = record(taskRuns['totals']);
  const prediction = record(root['predictionV1']);
  const predictionTotals = record(prediction['totals']);
  const inFlight = Array.isArray(taskRuns['inFlight']) ? taskRuns['inFlight'] : null;

  return {
    shutdownState: stringOrNull(daemon['shutdownState']),
    activeTaskRuns: numberOrNull(taskTotals['activeTaskRuns'] ?? predictionTotals['activeTaskRuns']),
    completed: numberOrNull(taskTotals['completed']),
    failed: numberOrNull(taskTotals['failed'] ?? predictionTotals['failed']),
    inFlightCount: inFlight ? inFlight.length : null,
    solutions: numberOrNull(taskTotals['solutions'] ?? predictionTotals['solutions']),
    verdicts: numberOrNull(taskTotals['verdicts'] ?? predictionTotals['verdicts']),
    claimedStakingRewardsWei: stringOrNull(rewards['claimedStakingRewardsWei']),
  };
}

function parseCli(): CliOptions {
  const parsed = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      config: { type: 'string', default: DEFAULT_CONFIG },
      'spec-file': { type: 'string', default: DEFAULT_SPEC_FILE },
      'evidence-dir': { type: 'string', default: DEFAULT_EVIDENCE_DIR },
      'log-file': { type: 'string', default: DEFAULT_LOG_FILE },
      'task-id': { type: 'string' },
      'run-slug': { type: 'string' },
      'daemon-port': { type: 'string' },
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
  const runSlug = parsed.values['run-slug'] ?? defaultRunSlug(nowMs);
  return {
    execute: parsed.values.execute,
    configPath: resolve(parsed.values.config),
    specFile: resolve(parsed.values['spec-file']),
    evidenceDir: resolve(parsed.values['evidence-dir']),
    logFile: resolve(parsed.values['log-file']),
    taskId: parsed.values['task-id'] ?? `olas-smoke-${Math.floor(nowMs / 1000)}`,
    runSlug,
    daemonPort: toInt(parsed.values['daemon-port'], DEFAULT_DAEMON_PORT),
    gammaPort: toInt(parsed.values['gamma-port'], DEFAULT_GAMMA_PORT),
    timeoutMs: toInt(parsed.values['timeout-ms'], DEFAULT_TIMEOUT_MS),
    pollMs: toInt(parsed.values['poll-ms'], DEFAULT_POLL_MS),
  };
}

function printHelp(): void {
  console.log(`Usage: yarn release:olas-rails-smoke [--execute] [options]

Runs the operator-local Base Sepolia tokenless OLAS rails smoke from
docs/runbooks/sepolia-olas-rails-smoke.md B0.

Default mode is dry-run: writes a fresh prediction.v1 smoke spec and prints the
commands it would run. Real chain interaction requires --execute.

Options:
  --execute                 Start the Gamma fixture + daemon and submit one task
  --config <path>           Smoke config path (default ../.local/smoke-config.json)
  --spec-file <path>        Generated prediction.v1 spec path
  --evidence-dir <path>     Evidence output directory
  --log-file <path>         Daemon log path
  --task-id <id>            Task submit id (default olas-smoke-<epoch>)
  --run-slug <slug>         Deterministic market id suffix
  --daemon-port <port>      Status endpoint port (default 7332)
  --gamma-port <port>       Local Gamma fixture port (default 7388)
  --timeout-ms <ms>         Execute-mode wall clock timeout
  --poll-ms <ms>            Status poll interval
`);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function relativeToClient(path: string): string {
  return path.startsWith(clientRoot) ? path.slice(clientRoot.length + 1) : path;
}

function resolvePassword(): string {
  if (process.env['JINN_PASSWORD']) return process.env['JINN_PASSWORD'];
  const path = join(process.env['HOME'] ?? '', '.jinn-client/keystore-password');
  if (!existsSync(path)) {
    throw new Error('Missing JINN_PASSWORD and ~/.jinn-client/keystore-password');
  }
  return readFileSync(path, 'utf8').trim();
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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
    if (status) return status;
    await sleep(opts.pollMs);
  }
  throw new Error(`Timed out waiting for daemon status on port ${port}`);
}

// Raw eth_call to StakingBase.getStakingState(serviceId) — selector 0xfd0bba8c.
// Returns 0=Unstaked, 1=Staked, 2=Evicted, or null on RPC error. Dependency-free
// so the smoke harness needs no viem import.
async function readStakingState(rpcUrl: string, proxy: string, serviceId: number): Promise<number | null> {
  const data = '0xfd0bba8c' + BigInt(serviceId).toString(16).padStart(64, '0');
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: proxy, data }, 'latest'] }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string };
    if (typeof json.result !== 'string' || json.result === '0x') return null;
    return Number(BigInt(json.result));
  } catch {
    return null;
  }
}

// The funded-rails reward only accrues for activity that happens while the service
// is Staked: each reStake resets the OLAS liveness baseline to the current activity
// weight, so a task submitted while the service is Evicted bumps the checker counter
// but earns nothing (the staked window never overlaps the activity). Waiting for the
// background EvictionLoop to reStake the service before submitting aligns the two.
async function waitForServiceStaked(opts: {
  rpcUrl: string;
  proxy: string;
  serviceId: number;
  timeoutMs: number;
  pollMs: number;
}): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const state = await readStakingState(opts.rpcUrl, opts.proxy, opts.serviceId);
    if (state !== null && state !== last) {
      console.log(`[olas-rails-smoke] service ${opts.serviceId} staking state=${state} (0=unstaked,1=staked,2=evicted)`);
      last = state;
    }
    if (state === 1) return;
    await sleep(opts.pollMs);
  }
  throw new Error(`service ${opts.serviceId} not Staked within ${opts.timeoutMs}ms (last state=${last})`);
}

function runSync(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function executeSmoke(opts: CliOptions, taskSpec: ReturnType<typeof buildPredictionSmokeTaskSpec>): Promise<void> {
  ensureDir(opts.evidenceDir);
  const gamma = await startGammaFixture(opts.gammaPort);
  let daemon: ChildProcess | null = null;
  try {
    const logStream = createWriteStream(opts.logFile, { flags: 'a' });
    // Ensure the file descriptor is open before handing the stream to spawn's
    // stdio — Node 22+ rejects an unopened WriteStream (fd null).
    await new Promise<void>((resolveOpen, rejectOpen) => {
      logStream.once('open', () => resolveOpen());
      logStream.once('error', rejectOpen);
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JINN_PASSWORD: resolvePassword(),
      JINN_CLAIM_LOOP_ENABLED: 'false',
      JINN_REWARD_CLAIM_INTERVAL_MS: '60000',
      JINN_POLYMARKET_GAMMA_BASE_URL: gamma.url,
    };
    delete env['BASE_SEPOLIA_RPC_URL'];

    daemon = spawn('yarn', ['jinn', 'run', '--config', relativeToClient(opts.configPath)], {
      cwd: clientRoot,
      env,
      stdio: ['ignore', logStream, logStream],
    });
    daemon.once('exit', (code, signal) => {
      logStream.write(`\n[olas-rails-smoke] daemon exited code=${code} signal=${signal}\n`);
    });

    const initialStatus = await waitForStatus(opts.daemonPort, {
      timeoutMs: Math.min(opts.timeoutMs, 120_000),
      pollMs: opts.pollMs,
    });
    writeJson(join(opts.evidenceDir, 'status-before.json'), initialStatus);

    // Opt-in: align the loop's activity with the service's staked window. When
    // JINN_SMOKE_STAKED_PROXY is set, hold the task submission until the named
    // service reports Staked on-chain (the EvictionLoop reStakes it first), so the
    // funded-rails reward actually accrues. See waitForServiceStaked above.
    const stakedProxy = process.env['JINN_SMOKE_STAKED_PROXY'];
    if (stakedProxy) {
      const serviceId = Number(process.env['JINN_SMOKE_STAKED_SERVICE'] ?? '0');
      const cfg = JSON.parse(readFileSync(opts.configPath, 'utf8')) as { rpcUrl?: string | string[] };
      const rpcUrl = process.env['JINN_SMOKE_RPC_URL'] ?? (Array.isArray(cfg.rpcUrl) ? cfg.rpcUrl[0] : cfg.rpcUrl);
      if (!rpcUrl || !serviceId) {
        throw new Error('JINN_SMOKE_STAKED_PROXY is set but rpcUrl or JINN_SMOKE_STAKED_SERVICE is missing');
      }
      console.log(`[olas-rails-smoke] waiting for service ${serviceId} to be Staked on ${stakedProxy} before submitting…`);
      await waitForServiceStaked({
        rpcUrl,
        proxy: stakedProxy,
        serviceId,
        timeoutMs: Math.min(opts.timeoutMs, 240_000),
        pollMs: opts.pollMs,
      });
      console.log(`[olas-rails-smoke] service ${serviceId} is Staked — submitting task.`);
    }

    const submit = runSync('yarn', [
      'jinn',
      'tasks',
      'submit',
      '--yes',
      '--config',
      relativeToClient(opts.configPath),
      '--id',
      opts.taskId,
      '--description',
      'Tokenless OLAS smoke prediction task',
      '--manifest-cid',
      DEFAULT_MANIFEST_CID,
      '--spec-file',
      relativeToClient(opts.specFile),
    ], clientRoot, env);
    writeFileSync(join(opts.evidenceDir, 'submit.stdout'), submit.stdout, 'utf8');
    writeFileSync(join(opts.evidenceDir, 'submit.stderr'), submit.stderr, 'utf8');

    const deadline = Date.now() + opts.timeoutMs;
    let latestStatus: unknown = initialStatus;
    while (Date.now() < deadline) {
      const status = await fetchStatus(opts.daemonPort);
      if (status) {
        latestStatus = status;
        const summary = summarizeSmokeStatus(status);
        if (
          summary.shutdownState === 'running' &&
          summary.activeTaskRuns === 0 &&
          summary.failed === 0 &&
          (summary.verdicts ?? 0) >= 1 &&
          BigInt(summary.claimedStakingRewardsWei ?? '0') > 0n
        ) {
          writeJson(join(opts.evidenceDir, 'status-after.json'), status);
          writeJson(join(opts.evidenceDir, 'summary.json'), {
            generatedAt: new Date().toISOString(),
            taskId: opts.taskId,
            gammaBaseUrl: gamma.url,
            taskSpec,
            status: summary,
          });
          return;
        }
      }
      await sleep(opts.pollMs);
    }
    writeJson(join(opts.evidenceDir, 'status-timeout.json'), latestStatus);
    throw new Error(`Timed out waiting for verdict + reward claim; evidence in ${opts.evidenceDir}`);
  } finally {
    await stopProcess(daemon);
    await new Promise<void>((resolvePromise) => gamma.server.close(() => resolvePromise()));
  }
}

async function cliMain(): Promise<void> {
  const opts = parseCli();
  const taskSpec = buildPredictionSmokeTaskSpec({ runSlug: opts.runSlug });
  writeJson(opts.specFile, taskSpec);
  ensureDir(opts.evidenceDir);
  writeJson(join(opts.evidenceDir, 'plan.json'), {
    generatedAt: new Date().toISOString(),
    execute: opts.execute,
    configPath: opts.configPath,
    specFile: opts.specFile,
    logFile: opts.logFile,
    taskId: opts.taskId,
    manifestCid: DEFAULT_MANIFEST_CID,
    gammaBaseUrl: `http://127.0.0.1:${opts.gammaPort}`,
    daemonStatusUrl: `http://127.0.0.1:${opts.daemonPort}/v1/status`,
  });

  if (!opts.execute) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      specFile: opts.specFile,
      evidenceDir: opts.evidenceDir,
      next: 'Re-run with --execute to start the Gamma fixture, daemon, and task submit.',
    }, null, 2));
    return;
  }

  await executeSmoke(opts, taskSpec);
  console.log(JSON.stringify({
    mode: 'execute',
    evidenceDir: opts.evidenceDir,
    status: 'complete',
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
